"""Derived layers over the raw script output: titles, states, juxtaposition groups,
connector and inferred flow edges, canvas-note association, and the index document."""

import math
import re
from datetime import datetime

from figma_cli.auth import Fail

# File conventions observed in the Player file: a "프레임 타이틀" label instance sits
# 96px above its screen at the same x; a numbered section carries a "섹션 타이틀"
# instance whose description is often this unfilled template placeholder.
FRAME_TITLE, SECTION_TITLE = "프레임 타이틀", "섹션 타이틀"
TITLE_GAP = 96
PLACEHOLDER = "포함될 화면들의 정보를 간략히 설명해 주세요."


def clean(s: str) -> str:
    """Layer names can carry control characters (U+0008 seen); drop them for display."""
    return " ".join("".join(ch for ch in s if ch >= " " or ch in "\n\t").split())


def label_text(parts: list[str]) -> str:
    return " / ".join(p for p in (clean(t) for t in parts) if p and p != PLACEHOLDER)


def rect_dist(a, b) -> float:
    dx = max(0.0, b[0] - (a[0] + a[2]), a[0] - (b[0] + b[2]))
    dy = max(0.0, b[1] - (a[1] + a[3]), a[1] - (b[1] + b[3]))
    return math.hypot(dx, dy)


def similar(a, b, tol=0.1) -> bool:
    return all(abs(a[i] - b[i]) <= tol * max(a[i], b[i], 1) for i in (2, 3))


def pair_titles(frames: list[dict], labels: list[dict]) -> None:
    """A frame's title is the 프레임 타이틀 label at its x, 96px above it, in its section."""
    for f in frames:
        x, y = f["bb"][0], f["bb"][1]
        hits = [l for l in labels if l["kind"] == FRAME_TITLE and l["section"] == f["section"]
                and abs(l["bb"][0] - x) <= 2 and abs(y - l["bb"][1] - TITLE_GAP) <= 4]
        f["title"] = label_text(hits[0]["text"]) if hits else ""
        f["title_id"] = hits[0]["id"] if hits else None


def assign_states(frames: list[dict], labels: list[dict]) -> None:
    """States are the label texts stacked above a frame's column, top to bottom: a wide
    group title over a frame-wide sub-title reads as e.g. ["대기", "선택"]. The
    stack stops at the bottom of the nearest frame above in the same column."""
    for f in frames:
        x, y, w, _ = f["bb"]
        cx = x + w / 2
        floor = max((g["bb"][1] + g["bb"][3] for g in frames if g is not f and g["section"] == f["section"]
                     and g["bb"][0] <= cx <= g["bb"][0] + g["bb"][2] and g["bb"][1] + g["bb"][3] <= y + 2),
                    default=-math.inf)
        stack = [l for l in labels if l["kind"] == FRAME_TITLE and l["section"] == f["section"]
                 and l["bb"][0] - 2 <= cx <= l["bb"][0] + l["bb"][2] + 2
                 and l["bb"][1] + l["bb"][3] <= y + 2 and l["bb"][1] >= floor]
        f["states"] = [t for t in (label_text(l["text"]) for l in sorted(stack, key=lambda l: l["bb"][1])) if t]


def group_juxtaposed(frames: list[dict]) -> list[dict]:
    """Frames of similar size whose tops align in a row inside one section form a group;
    rows with the same column x positions and frame size merge into one grid."""
    groups = []
    by_sec: dict = {}
    for f in frames:
        by_sec.setdefault(f["section"], []).append(f)
    for sec, fs in by_sec.items():
        rows: list[list[dict]] = []
        for f in sorted(fs, key=lambda f: (f["bb"][1], f["bb"][0])):
            row = next((r for r in rows if abs(r[0]["bb"][1] - f["bb"][1]) <= 4), None)
            if row:
                row.append(f)
            else:
                rows.append([f])
        runs = []
        for row in rows:
            row.sort(key=lambda f: f["bb"][0])
            run = [row[0]]
            for f in row[1:]:
                if similar(run[0]["bb"], f["bb"]):
                    run.append(f)
                    continue
                if len(run) > 1:
                    runs.append(run)
                run = [f]
            if len(run) > 1:
                runs.append(run)
        grids: list[list[list[dict]]] = []
        for run in runs:
            xs = [f["bb"][0] for f in run]
            grid = next((g for g in grids if len(g[0]) == len(run) and similar(g[0][0]["bb"], run[0]["bb"])
                         and all(abs(a["bb"][0] - b) <= 4 for a, b in zip(g[0], xs))), None)
            if grid:
                grid.append(run)
            else:
                grids.append([run])
        for g in grids:
            gid = f"{sec}#{len([x for x in groups if x['section'] == sec]) + 1}"
            members = [f["id"] for run in g for f in run]
            for r, run in enumerate(g):
                for c, f in enumerate(run):
                    f["group"], f["cell"] = gid, [r, c]
            states = [g[r][c].get("states") or [g[r][c].get("title", "")] for r in range(len(g)) for c in range(len(g[0]))]
            groups.append({"id": gid, "section": sec, "rows": len(g), "cols": len(g[0]), "members": members,
                           "states": states, "axes": state_axes(states)})
    return groups


def state_axes(states: list[list[str]]) -> list[list[str]] | None:
    """When every member's state stack has the same depth and the stacks are exactly the
    product of their per-level values, the group is a state matrix with those axes."""
    depth = {len(s) for s in states}
    if len(depth) != 1 or depth == {1} or len({tuple(s) for s in states}) != len(states):
        return None
    axes = [list(dict.fromkeys(s[k] for s in states)) for k in range(depth.pop())]
    return axes if math.prod(len(a) for a in axes) == len(states) else None


TOUCH_MAX_GAP = 400  # the Home -> Player arrow in 2233:84364 starts 116.5px past its frame's y-range


def _touch(pt, bb, tol=1.0):
    """Perpendicular gap if the point lies on one of bb's edge lines, else None."""
    x, y, w, h = bb
    gaps = []
    if min(abs(pt[0] - x), abs(pt[0] - x - w)) <= tol:
        gaps.append(max(0.0, y - pt[1], pt[1] - y - h))
    if min(abs(pt[1] - y), abs(pt[1] - y - h)) <= tol:
        gaps.append(max(0.0, x - pt[0], pt[0] - x - w))
    return min(gaps) if gaps else None


def resolve_end(pt, want: str, cands: list[dict]):
    """Pick the node an arrow end touches: an edge line through the point, preferring the
    layer name the connector names, then the smallest perpendicular gap; fall back to
    the nearest frame. Returns (candidate, rule, gap)."""
    best = None
    for c in cands:
        gap = _touch(pt, c["bb"])
        if gap is not None and gap <= TOUCH_MAX_GAP:
            key = (clean(c["name"]) != want, gap)
            if best is None or key < best[0]:
                best = (key, c)
    if best:
        return best[1], "edge-touch" + ("+name" if not best[0][0] else ""), round(best[0][1], 1)
    frames = [c for c in cands if c["id"] == c["screen"]]
    if not frames:
        return None, "no-candidate", None
    c = min(frames, key=lambda c: rect_dist((pt[0], pt[1], 0, 0), c["bb"]))
    return c, "nearest", round(rect_dist((pt[0], pt[1], 0, 0), c["bb"]), 1)


def resolve_connector(conn: dict, cands: list[dict]) -> dict:
    """Edge for a plugin-drawn "<src> -> <dst> | My Connector" vector. The end whose
    stroke cap is an arrow is the destination; without caps, names decide."""
    m = re.match(r"(.*?) -> (.*?)(?: \| .*)?$", clean(conn["name"]))
    src_name, dst_name = (m.group(1), m.group(2)) if m else ("", "")
    ends = conn.get("ends") or []
    if len(ends) != 2:
        x, y, w, h = conn["bb"]
        ends = ([{"x": x, "y": y + h / 2}, {"x": x + w, "y": y + h / 2}] if w >= h
                else [{"x": x + w / 2, "y": y}, {"x": x + w / 2, "y": y + h}])
    arrow = [("ARROW" in (e.get("cap") or "") or "TRIANGLE" in (e.get("cap") or "")) for e in ends]
    orders = [(0, 1), (1, 0)]
    if arrow.count(True) == 1:
        orders = [(1, 0)] if arrow[0] else [(0, 1)]
    best = None
    for si, di in orders:
        s = resolve_end((ends[si]["x"], ends[si]["y"]), src_name, cands)
        d = resolve_end((ends[di]["x"], ends[di]["y"]), dst_name, cands)
        score = sum(r[1].endswith("+name") for r in (s, d))
        if best is None or score > best[0]:
            best = (score, s, d)
    _, s, d = best
    if not s[0] or not d[0] or s[0]["screen"] == d[0]["screen"]:
        return {"via": conn["id"], "unresolved": f"src {s[1]}, dst {d[1]}"}
    return {"src": s[0]["screen"], "dst": d[0]["screen"], "kind": "explicit", "how": "connector", "via": conn["id"],
            "src_node": s[0]["id"], "dst_node": d[0]["id"], "rule": f"src {s[1]} gap {s[2]}, dst {d[1]} gap {d[2]}",
            "label": clean(conn["name"])}


def reading_order(fs: list[dict]) -> list[dict]:
    rows: list[list[dict]] = []
    for f in sorted(fs, key=lambda f: (f["bb"][1], f["bb"][0])):
        if rows and f["bb"][1] < rows[-1][0]["bb"][1] + min(g["bb"][3] for g in rows[-1]) / 2:
            rows[-1].append(f)
        else:
            rows.append([f])
    return [f for row in rows for f in sorted(row, key=lambda f: f["bb"][0])]


INFER_RULE = "reading-order: section has no explicit edge; next frame row-major, skipping pairs in one juxtaposition group"


def infer_edges(frames: list[dict], explicit: list[dict]) -> list[dict]:
    """Inferred steps run left-to-right, top-to-bottom inside a section that has no
    explicit edge. Frames in one juxtaposition group are alternatives, not steps."""
    by_id = {f["id"]: f for f in frames}
    wired = {by_id[e["src"]]["section"] for e in explicit if e["src"] in by_id}
    wired |= {by_id[e["dst"]]["section"] for e in explicit if e["dst"] in by_id}
    by_sec: dict = {}
    for f in frames:
        by_sec.setdefault(f["section"], []).append(f)
    out = []
    for sec, fs in by_sec.items():
        if sec in wired or sec is None:
            continue
        order = reading_order([f for f in fs if f.get("visible", True)])
        for a, b in zip(order, order[1:]):
            if a.get("group") and a.get("group") == b.get("group"):
                continue
            out.append({"src": a["id"], "dst": b["id"], "kind": "inferred", "rule": INFER_RULE})
    return out


def associate_notes(notes: list[dict], frames: list[dict], sections: dict) -> None:
    for n in notes:
        same = [f for f in frames if f["page"] == n["page"]]
        if same:
            f = min(same, key=lambda f: rect_dist(n["bb"], f["bb"]))
            n["frame"], n["frame_dist"] = f["id"], round(rect_dist(n["bb"], f["bb"]), 1)
        secs = [s for s in sections.values() if s["page"] == n["page"]]
        if n.get("section") is None and secs:
            s = min(secs, key=lambda s: rect_dist(n["bb"], s["bb"]))
            n["near_section"], n["section_dist"] = s["id"], round(rect_dist(n["bb"], s["bb"]), 1)


def build_index(key: str, file_name: str, pages: list[dict], parts: list[dict]) -> dict:
    sections, frames, labels, notes, conns, named, resolved = {}, [], [], [], [], [], []
    for p in parts:
        for s in p["sections"]:
            sections[s["id"]] = {**s, "page": p["page"], "name": clean(s["name"])}
        for f in p["frames"]:
            frames.append({**f, "page": p["page"], "name": clean(f["name"])})
        labels += p["labels"]
        notes += [{**n, "page": p["page"], "text": n["text"].strip()} for n in p["notes"] if n["text"].strip()]
        conns += [{**c, "page": p["page"]} for c in p["connectors"]]
        named += [{**n, "page": p["page"]} for n in p["named"]]
        resolved += p["resolved"]
    for s in sections.values():
        s["title"] = next((label_text(l["text"]) for l in labels if l["kind"] == SECTION_TITLE and l["section"] == s["id"]), "")
    pair_titles(frames, labels)
    assign_states(frames, labels)
    groups = group_juxtaposed(frames)

    by_id = {f["id"]: f for f in frames}
    edges, unresolved = [], []
    for c in conns:
        if c["type"] == "CONNECTOR":
            r = next((r for r in resolved if r["id"] == c["id"]), {})
            if r.get("start") in by_id and r.get("end") in by_id:
                edges.append({"src": r["start"], "dst": r["end"], "kind": "explicit", "how": "connector-node",
                              "via": c["id"], "label": clean(c["name"])})
            else:
                unresolved.append({"via": c["id"], "unresolved": "endpoint is not an indexed frame"})
            continue
        cands = [{"id": f["id"], "screen": f["id"], "name": f["name"], "bb": f["bb"]} for f in frames if f["page"] == c["page"]]
        cands += [{"id": n["id"], "screen": n["screen"], "name": n["name"], "bb": n["bb"]} for n in named if n["page"] == c["page"]]
        e = resolve_connector(c, cands)
        (unresolved if "unresolved" in e else edges).append(e)
    owner = {}
    for f in frames:
        owner[f["id"]] = f["id"]
    for f in frames:
        for r in f["reactions"]:
            dst = owner.get(r["dest"])
            if dst and dst != f["id"]:
                edges.append({"src": f["id"], "dst": dst, "kind": "explicit", "how": "reaction", "via": r["node"],
                              "label": f"{r['trigger']} {r['navigation']}"})
            elif not dst:
                unresolved.append({"via": r["node"], "unresolved": f"reaction destination {r['dest']} is not an indexed frame"})
    edges += infer_edges(frames, edges)

    associate_notes(notes, frames, sections)
    counts: dict = {}
    for f in frames:
        counts[f["hash"]] = counts.get(f["hash"], 0) + 1
    for f in frames:
        f["dups"] = counts[f["hash"]]
    return {"fileKey": key, "fileName": file_name, "indexedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "pages": pages, "sections": sections, "frames": frames, "groups": groups, "edges": edges,
            "unresolved": unresolved, "notes": notes,
            "connectors": [{"id": c["id"], "page": c["page"], "section": c["section"], "name": clean(c["name"])} for c in conns],
            "labels": [{**l, "text": label_text(l["text"])} for l in labels]}


def parse_pages(listing: str) -> list[dict]:
    pages = []
    for m in re.finditer(r"^- (\S+): (.*)$", listing, re.M):
        name = m.group(2).strip()
        pages.append({"id": m.group(1), "name": name, "divider": bool(re.fullmatch(r"-+", name))})
    if not pages:
        raise Fail(f"get_metadata returned no page list:\n{listing[:2000]}")
    return pages
