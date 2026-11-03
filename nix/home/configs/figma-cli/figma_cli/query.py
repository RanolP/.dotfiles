"""The on-disk index and agent notes, ref lookup, and the bounded-output commands."""

import json
import re
from datetime import datetime
from pathlib import Path

from figma_cli.auth import DATA, die
from figma_cli.derive import INFER_RULE, rect_dist, reading_order


def file_key(ref: str) -> str:
    """A branch URL (figma.com/design/<key>/branch/<branchKey>/<name>) names the branch's own file."""
    m = re.search(r"figma\.com/(?:design|file|board|proto)/([0-9a-zA-Z]{22,128})(?:/branch/([0-9a-zA-Z]{22,128}))?", ref)
    if m:
        return m.group(2) or m.group(1)
    if re.fullmatch(r"[0-9a-zA-Z]{22,128}", ref):
        return ref
    die(f"not a Figma file URL or key: {ref}")


def store(key: str) -> Path:
    return DATA / key


def load_index(file_ref: str | None) -> dict:
    if file_ref:
        path = store(file_key(file_ref)) / "index.json"
    else:
        found = sorted(DATA.glob("*/index.json"))
        if len(found) != 1:
            die(f"pass --file <url|fileKey>; indexed files: {[p.parent.name for p in found] or 'none (run figma-cli index first)'}")
        path = found[0]
    if not path.exists():
        die(f"{path} not found; run: figma-cli index <url|fileKey>")
    return json.loads(path.read_text())


def load_notes(key: str) -> list[dict]:
    path = store(key) / "notes.jsonl"
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()] if path.exists() else []


def resolve_ref(idx: dict, ref: str, sections_ok: bool = False):
    """A ref is a node id (1:2 or 1-2), a hash prefix (4+ hex), or, where sections are
    allowed, a section id. Returns ("frame", frame) or ("section", section)."""
    ref = ref.strip()
    if re.fullmatch(r"I?\d+[-:]\d+(?:;\d+[-:]\d+)*", ref):
        ref = ref.replace("-", ":")
        f = next((f for f in idx["frames"] if f["id"] == ref), None)
        if f:
            return "frame", f
        if sections_ok and ref in idx["sections"]:
            return "section", idx["sections"][ref]
        die(f"{ref} is not an indexed frame{' or section' if sections_ok else ''}; frames are the direct children of sections and pages")
    if re.fullmatch(r"[0-9a-f]{4,64}", ref):
        hits = [f for f in idx["frames"] if f["hash"].startswith(ref)]
        if len(hits) == 1:
            return "frame", hits[0]
        if not hits:
            die(f"no frame hash starts with {ref}")
        kind = "duplicates share this hash" if len({f["hash"] for f in hits}) == 1 else "prefix matches several hashes"
        die(f"ambiguous {ref}: {kind}; pass a nodeId:\n" + "\n".join(line(idx, f) for f in hits[:20])
            + (f"\n… {len(hits) - 20} more" if len(hits) > 20 else ""))
    die(f"not a nodeId or hash prefix: {ref}")


def section_path(idx: dict, sid: str | None) -> str:
    names = []
    while sid and sid in idx["sections"]:
        names.append(idx["sections"][sid]["name"])
        sid = idx["sections"][sid]["parent"]
    return " › ".join(reversed(names)) or "(page)"


def page_name(idx: dict, pid: str) -> str:
    return next((p["name"] for p in idx["pages"] if p["id"] == pid), pid)


def label(f: dict) -> str:
    return f.get("title") or f["name"]


def line(idx: dict, f: dict, with_page: bool = True) -> str:
    states = f.get("states") or []
    st = f" [{' / '.join(states)}]" if states and states != [f.get("title")] else ""
    dup = f" ={f['dups']}" if f.get("dups", 1) > 1 else ""
    pg = f"{page_name(idx, f['page'])} · " if with_page else ""
    hidden = " (hidden)" if not f.get("visible", True) else ""
    return (f"{f['hash'][:10]} {f['id']:<14} {pg}{section_path(idx, f['section'])} | {label(f)}{st}"
            f" {round(f['bb'][2])}x{round(f['bb'][3])}{dup}{hidden}")


def capped(lines: list[str], limit: int, what: str = "lines") -> str:
    if len(lines) <= limit:
        return "\n".join(lines)
    return "\n".join(lines[:limit] + [f"… {len(lines) - limit} more {what} (raise --limit or narrow the filter)"])


def in_section(idx: dict, f: dict, sec_ref: str) -> bool:
    sid, q = f["section"], sec_ref.casefold()
    while sid:
        s = idx["sections"][sid]
        if sid == sec_ref.replace("-", ":") or q in s["name"].casefold() or q in s.get("title", "").casefold():
            return True
        sid = s["parent"]
    return False


def on_page(idx: dict, f: dict, page_ref: str) -> bool:
    return f["page"] == page_ref.replace("-", ":") or page_ref.casefold() in page_name(idx, f["page"]).casefold()


def note_status(idx: dict, n: dict) -> str:
    f = next((f for f in idx["frames"] if f["id"] == n["nodeId"]), None)
    if not f:
        return "orphan: node no longer indexed"
    return "current" if f["hash"] == n["hash"] else f"stale: frame hash is now {f['hash'][:10]}"


def notes_for(idx: dict, f: dict) -> list[str]:
    out = []
    for n in load_notes(idx["fileKey"]):
        if n["nodeId"] == f["id"]:
            out.append(f"  [{note_status(idx, n)}] {n['ts']} {n['text']}")
        elif n["hash"] == f["hash"]:
            out.append(f"  [same design as {n['nodeId']}] {n['ts']} {n['text']}")
    return out


def edge_line(idx: dict, e: dict, by_id: dict) -> str:
    s, d = by_id.get(e["src"]), by_id.get(e["dst"])
    how = f"{e['how']} {e['via']}" if e["kind"] == "explicit" else "inferred"
    extra = f" ({e['label']})" if e.get("label") else ""
    return (f"  {s['hash'][:10]} {label(s)} ({s['id']}) -> {d['hash'][:10]} {label(d)} ({d['id']})"
            f"  [{how}]{extra}")


# ---------------------------------------------------------------- commands

def cmd_ls(idx: dict, a) -> str:
    fs = [f for f in idx["frames"] if (not a.page or on_page(idx, f, a.page)) and (not a.section or in_section(idx, f, a.section))]
    if a.page:
        pages = ", ".join(dict.fromkeys(page_name(idx, f["page"]) for f in fs)) or a.page
        where = f"{pages} ({idx['fileKey']} · {idx['fileName']})"
    else:
        where = f"{idx['fileName']} ({idx['fileKey']})"
    head = f"{len(fs)} frames in {where}, indexed {idx['indexedAt']}"
    return head + "\n" + capped([line(idx, f, with_page=not a.page) for f in fs], a.limit, "frames")


def cmd_find(idx: dict, a) -> str:
    notes = load_notes(idx["fileKey"])

    def has(hay, q):
        return q is None or any(q.casefold() in (h or "").casefold() for h in hay)

    hits = []
    for f in idx["frames"]:
        canvas = [n["text"] for n in idx["notes"] if n.get("frame") == f["id"]]
        agent = [n["text"] for n in notes if n["nodeId"] == f["id"] or n["hash"] == f["hash"]]
        if (has([f["name"]], a.name) and has([f.get("title", "")], a.title)
                and has([f.get("title", ""), *f.get("states", []), *f["texts"]], a.text)
                and has(canvas + agent, a.note)
                and (not a.page or on_page(idx, f, a.page)) and (not a.section or in_section(idx, f, a.section))):
            hits.append(f)
    return f"{len(hits)} frames match\n" + capped([line(idx, f) for f in hits], a.limit, "frames")


def cmd_show(idx: dict, a) -> str:
    _, f = resolve_ref(idx, a.ref)
    by_id = {g["id"]: g for g in idx["frames"]}
    out = [f"{f['hash']} {f['id']} {f['type']} \"{f['name']}\"",
           f"page: {page_name(idx, f['page'])}   section: {section_path(idx, f['section'])} ({f['section']})",
           f"title: {f.get('title') or '-'}   states: {' / '.join(f.get('states') or []) or '-'}",
           f"bbox: x {round(f['bb'][0])} y {round(f['bb'][1])} {round(f['bb'][2])}x{round(f['bb'][3])}"
           f"   nodes: {f['nodes']}   visible: {f.get('visible', True)}   prototype reactions: {f.get('reactionCount', 0)}"]
    if f["dups"] > 1:
        same = [g["id"] for g in idx["frames"] if g["hash"] == f["hash"] and g is not f]
        out.append(f"same hash: {', '.join(same[:10])}" + (f" … {len(same) - 10} more" if len(same) > 10 else ""))
    if f.get("group"):
        g = next(g for g in idx["groups"] if g["id"] == f["group"])
        mates = [by_id[m] for m in g["members"] if m != f["id"]]
        out.append(f"group {g['id']} {g['rows']}x{g['cols']}, this at row {f['cell'][0] + 1} col {f['cell'][1] + 1}; mates:")
        out += [f"  {m['hash'][:10]} {m['id']} {label(m)} [{' / '.join(m.get('states') or [])}]" for m in mates[:12]]
    edges = [e for e in idx["edges"] if f["id"] in (e["src"], e["dst"])]
    if edges:
        out.append("flow:")
        out += [edge_line(idx, e, by_id) for e in edges[:12]]
    sec = [g for g in idx["frames"] if g["section"] == f["section"] and g is not f]
    near = sorted(sec, key=lambda g: rect_dist(f["bb"], g["bb"]))[:4]
    if near:
        out.append("nearest in section:")
        out += [f"  {g['hash'][:10]} {g['id']} {label(g)} ({round(rect_dist(f['bb'], g['bb']))}px)" for g in near]
    canvas = sorted((n for n in idx["notes"] if n.get("frame") == f["id"]), key=lambda n: n["frame_dist"])
    if canvas:
        out.append("canvas notes (nearest frame is this one):")
        out += [f"  {n['id']} {n['frame_dist']}px: {clip(n['text'], 200)}" for n in canvas[:6]]
    if (agent := notes_for(idx, f)):
        out.append("agent notes:")
        out += agent
    if f["texts"]:
        out.append("texts: " + clip(" | ".join(f["texts"]), 400))
    return "\n".join(out)


def clip(s: str, n: int) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[:n] + f"… (+{len(s) - n} chars)"


def cmd_flow(idx: dict, a) -> str:
    kind, obj = resolve_ref(idx, a.ref, sections_ok=True)
    by_id = {f["id"]: f for f in idx["frames"]}
    if kind == "section":
        fs = [f for f in idx["frames"] if in_section(idx, f, obj["id"])]
        ids = {f["id"] for f in fs}
        edges = [e for e in idx["edges"] if e["src"] in ids or e["dst"] in ids]
        groups = [g for g in idx["groups"] if g["members"][0] in ids]
        head = (f"section {obj['id']} \"{obj['name']}\"{' — ' + obj['title'] if obj.get('title') else ''}: {len(fs)} frames, "
                f"{sum(e['kind'] == 'explicit' for e in edges)} explicit, {sum(e['kind'] == 'inferred' for e in edges)} inferred edges")
    else:
        fs, edges, groups = [obj], [e for e in idx["edges"] if obj["id"] in (e["src"], e["dst"])], []
        head = f"frame {obj['id']} {label(obj)}: {len(edges)} edges"
    if a.mermaid:
        nodes = {e[k] for e in edges for k in ("src", "dst")} | {f["id"] for f in fs}
        out = ["flowchart LR"]
        for nid in sorted(nodes):
            f = by_id[nid]
            text = (label(f) + (" · " + " / ".join(f["states"]) if f.get("states") and f["states"] != [f.get("title")] else "")).replace('"', "#quot;")
            out.append(f'  n{nid.replace(":", "_").replace(";", "__")}["{text}<br/>{f["hash"][:8]}"]')
        for e in edges:
            arrow = "-->" if e["kind"] == "explicit" else "-.->"
            out.append(f"  n{e['src'].replace(':', '_').replace(';', '__')} {arrow} n{e['dst'].replace(':', '_').replace(';', '__')}")
        return capped(out, a.limit * 2, "mermaid lines")
    out = [head]
    if kind == "section":
        out.append("frames (reading order):")
        out += [f"  {f['hash'][:10]} {f['id']} {label(f)}" + (f" [{' / '.join(f['states'])}]" if f.get("states") and f["states"] != [f.get("title")] else "")
                for f in reading_order(fs)][: a.limit]
        if len(fs) > a.limit:
            out.append(f"  … {len(fs) - a.limit} more frames")
    if edges:
        out.append("edges:")
        out += [edge_line(idx, e, by_id) for e in edges[: a.limit]]
        if len(edges) > a.limit:
            out.append(f"  … {len(edges) - a.limit} more edges")
        if any(e["kind"] == "inferred" for e in edges):
            out.append(f"  inferred rule: {INFER_RULE}")
    for g in groups:
        out.append(f"juxtaposition group {g['id']} {g['rows']}x{g['cols']} (states laid side by side):")
        if g.get("axes"):
            out.append("  state matrix " + "x".join(str(len(a)) for a in g["axes"]) + ": " + " × ".join("|".join(a) for a in g["axes"]))
        for r in range(g["rows"]):
            cells = [g["states"][r * g["cols"] + c] for c in range(g["cols"])]
            out.append("  row " + str(r + 1) + ": " + " | ".join(" / ".join(c) or "?" for c in cells))
    if kind == "section":
        un = [u for u in idx["unresolved"] if any(c["id"] == u["via"] and in_section_id(idx, c.get("section"), obj["id"])
                                                    for c in idx.get("connectors", []))]
        out += [f"  unresolved {u['via']}: {u['unresolved']}" for u in un]
    return "\n".join(out)


def in_section_id(idx: dict, sid: str | None, target: str) -> bool:
    while sid:
        if sid == target:
            return True
        sid = idx["sections"].get(sid, {}).get("parent")
    return False


def cmd_note(idx: dict, a) -> str:
    _, f = resolve_ref(idx, a.ref)
    text = a.text.strip()
    if not text:
        die("note text is empty")
    rec = {"ts": datetime.now().astimezone().isoformat(timespec="seconds"), "hash": f["hash"], "nodeId": f["id"],
           "page": f["page"], "frame": label(f), "text": text}
    path = store(idx["fileKey"]) / "notes.jsonl"
    with path.open("a") as fh:
        fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return f"noted {f['hash'][:10]} {f['id']} {label(f)} -> {path}"


def cmd_notes(idx: dict, a) -> str:
    _, f = resolve_ref(idx, a.ref)
    out = notes_for(idx, f)
    return f"{len(out)} notes for {f['hash'][:10]} {f['id']} {label(f)}\n" + capped(out, a.limit, "notes")

