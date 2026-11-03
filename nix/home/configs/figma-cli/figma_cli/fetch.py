"""Reads over MCP: the paced, resumable per-page index fetch into raw/, and get_design_context."""

import asyncio
import json
import math
import re
import time
from pathlib import Path

from mcp import ClientSession

from figma_cli.auth import PACE, Fail, call, call_raw, describe, die, parse_json, rate_limited, write_atomic
from figma_cli.derive import build_index, parse_pages
from figma_cli.plugin_script import script_for
from figma_cli.query import store

RETURN_BUDGET = 40_000  # use_figma refuses a return over 48,000 bytes; slices aim below it
MAX_PARTS = 256


def raw_dir(key: str) -> Path:
    return store(key) / "raw"


def page_file(key: str, page_id: str) -> Path:
    return raw_dir(key) / (page_id.replace(":", "-") + ".json")


def index_action(key: str, refresh: bool):
    """Fetch every non-divider page into raw/<pageId>.json, one file as each page completes.
    Pages already in raw/ are skipped unless refresh. A slice whose return is over the
    limit is re-read as k finer slices (the error states its size, which sizes k). A rate
    limit stops new calls; saved pages stay and the next run resumes from them."""
    async def act(session: ClientSession) -> dict:
        started = time.time()
        sid = parse_json(await call(session, "create_session", {"fileKey": key, "description": "read-only frame index (figma-cli index)"}),
                         "create_session")["sessionId"]
        pages = parse_pages(await call(session, "get_metadata", {"fileKey": key, "sessionId": sid}))
        raw_dir(key).mkdir(parents=True, exist_ok=True)
        write_atomic(raw_dir(key) / "pages.json", json.dumps({"fileKey": key, "pages": pages}, ensure_ascii=False))
        live = [p for p in pages if not p["divider"]]
        todo = [p for p in live if refresh or not page_file(key, p["id"]).exists()]
        gate = asyncio.Semaphore(4)
        stopped: list[str] = []

        async def read_slice(page_id: str, part: int, parts: int) -> dict | int:
            where = f"page {page_id} slice {part}/{parts}"
            async with gate:
                try:
                    err, text = await call_raw(session, "use_figma", {
                        "fileKey": key, "sessionId": sid, "code": script_for(page_id, part, parts),
                        "description": "Read-only: list sections, screens, labels, notes and connectors with bounds and content hashes"},
                        abort=lambda: bool(stopped))
                except Fail as e:
                    raise Fail(f"{where}: {e}") from None
            if err and (m := re.search(r"byte limit \((\d+) bytes\)", text)):
                return int(m.group(1))
            if err and rate_limited(text):
                stopped.append(text)
                raise Fail(f"{where}: rate limited: {text}")
            if err:
                raise Fail(f"use_figma tool error ({where}): {text}")
            return parse_json(text, f"use_figma ({where})")

        async def read(p: dict) -> None:
            t, done, slices = time.time(), [], [(0, 1)]
            while slices:
                got = await asyncio.gather(*(read_slice(p["id"], a, n) for a, n in slices))
                nxt = []
                for (a, n), g in zip(slices, got):
                    if not isinstance(g, int):
                        done.append(g)
                        continue
                    k = max(2, math.ceil(g / RETURN_BUDGET))
                    if n * k > MAX_PARTS:
                        raise Fail(f"page {p['id']} slice {a}/{n} is {g} bytes; splitting it {k} ways passes {MAX_PARTS} slices")
                    # slice a of n keeps items i % n == a; those split into i % (n*k) == a + j*n
                    nxt += [(a + j * n, n * k) for j in range(k)]
                slices = nxt
            write_atomic(page_file(key, p["id"]), json.dumps(
                {"page": p["id"], "name": p["name"], "fileName": done[0]["fileName"], "seconds": round(time.time() - t, 1),
                 "parts": done}, ensure_ascii=False, separators=(",", ":")))

        results = await asyncio.gather(*(read(p) for p in todo), return_exceptions=True)
        failed = [(p, r) for p, r in zip(todo, results) if isinstance(r, BaseException)]
        if failed:
            left = [p for p in live if not page_file(key, p["id"]).exists()]
            errs = "\n".join(f"  {p['id']} {p['name']}: {describe(r)}" for p, r in failed)
            hint = ("rate limited — rerun after the limit resets; saved pages are skipped" if stopped
                    else "rerun to retry; saved pages are skipped")
            raise Fail(f"{len(live) - len(left)} of {len(live)} pages saved under {raw_dir(key)}; "
                       f"{len(left)} remain: {', '.join(p['id'] + ' ' + p['name'] for p in left)}\n{errs}\n{hint}")
        return {"fileKey": key, "calls": PACE.count, "seconds": round(time.time() - started, 1),
                "fetched": len(todo), "skipped": len(live) - len(todo)}
    return act


def load_raw(key: str) -> dict:
    listing = raw_dir(key) / "pages.json"
    if not listing.exists():
        die(f"{listing} not found; run figma-cli index {key} without --offline first")
    pages = json.loads(listing.read_text())["pages"]
    live = [p for p in pages if not p["divider"]]
    missing = [p for p in live if not page_file(key, p["id"]).exists()]
    if missing:
        die(f"raw/ lacks {len(missing)} pages ({', '.join(p['id'] + ' ' + p['name'] for p in missing)}); "
            f"run figma-cli index {key} to fetch them")
    saved = [json.loads(page_file(key, p["id"]).read_text()) for p in live]
    return {"fileKey": key, "fileName": saved[0]["fileName"] if saved else "", "pages": pages,
            "parts": [part for s in saved for part in s["parts"]]}


def write_index(key: str, stats: dict | None) -> None:
    raw = load_raw(key)
    idx = build_index(key, raw["fileName"], raw["pages"], raw["parts"])
    path = store(key) / "index.json"
    path.write_text(json.dumps(idx, ensure_ascii=False, separators=(",", ":")))
    ex = sum(e["kind"] == "explicit" for e in idx["edges"])
    fetched = ("from raw/, 0 calls" if stats is None else
               f"in {stats['seconds']}s over {stats['calls']} calls ({stats['fetched']} pages fetched, {stats['skipped']} reused from raw/)")
    print(f"indexed {idx['fileName']} ({key}) {fetched}: "
          f"{sum(not p['divider'] for p in idx['pages'])} pages, {len(idx['sections'])} sections, {len(idx['frames'])} frames, "
          f"{len(idx['groups'])} groups, edges {ex} explicit / {len(idx['edges']) - ex} inferred, "
          f"{len(idx['unresolved'])} unresolved, {len(idx['notes'])} canvas notes -> {path} ({path.stat().st_size} bytes)")


def design_action(key: str, node_id: str, max_bytes: int):
    async def act(session: ClientSession) -> str:
        sid = parse_json(await call(session, "create_session", {"fileKey": key, "description": "read design context for one indexed frame"}),
                         "create_session")["sessionId"]
        text = await call(session, "get_design_context", {"fileKey": key, "nodeId": node_id, "sessionId": sid,
                                                         "excludeScreenshot": True, "clientLanguages": "unknown", "clientFrameworks": "unknown"})
        raw = text.encode()
        if len(raw) <= max_bytes:
            return text
        return raw[:max_bytes].decode(errors="ignore") + f"\n… {len(raw) - max_bytes} more bytes cut (raise --max-bytes)"
    return act
