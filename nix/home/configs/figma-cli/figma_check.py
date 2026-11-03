#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["mcp>=1.9,<2"]
# ///
"""Runnable check for figma-cli's indexer: uv run --script figma_check.py

Fixtures are cut from live reads of a real design file, with names and labels replaced by stand-ins, and keep only
fields the Plugin API / MCP server emitted there. Needs node on PATH (mise) to run the
in-Figma hash code exactly as it ships.
"""

import asyncio
import copy
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from figma_cli import auth, derive, plugin_script, query  # noqa: E402


def check_guard():
    """Catches: the shipped script gaining a mutating call, or the guard letting one through."""
    assert plugin_script.read_only_violations(plugin_script.script_for("1:4", 1, 4)) == [], plugin_script.read_only_violations(plugin_script.script_for("1:4"))
    mutating = [
        "node.name = 'x'", "n.x += 5", "n.visible=false", "node.remove()", "figma.createFrame()",
        "frame.appendChild(child)", "parent.insertChild(0, c)", "node.resize(1, 2)", "node.setPluginData('k', 'v')",
        "figma.commitUndo()", "figma.currentPage = page", "kids[0] = x", "n.opacity++", "n.clone()",
        "Object.assign(node, {name: 'x'})", "delete node.name", "figma.group([a], p)", "node.characters = 'hi'",
    ]
    for code in mutating:
        assert plugin_script.read_only_violations(code), f"guard let through: {code}"
    allowed = [
        "await figma.setCurrentPageAsync(page)", "if (a.x === b.x) {}", "const ok = n.width >= 3 && n.height <= 4",
        "const s = 'node.name = 1'", "// node.remove()", "xs.map(x => x.name)", "let a = H[0]; a = 2; i++",
        "m.set(k, v)", "seen.add(t)",
    ]
    for code in allowed:
        assert not plugin_script.read_only_violations(code), f"guard rejected read-only code: {code} {plugin_script.read_only_violations(code)}"


# Subtree of 홈 instance 2177:59141 from get_metadata (meta-instance-2177-59141.json):
# type, name, parent-relative x/y, width/height. Text characters are not in that response;
# "대기" is a stand-in for the real text of 프레임 타이틀 2177:50007, the other TEXT nodes reuse their
# layer name as characters (stand-in).
TREE = ["FRAME", "Frame 26085767", 16, 248, 328, 266, None, [
    ["TEXT", "collection-title", 0, 0, 328, 27, "대기", []],
    ["FRAME", "Frame 26085748", 0, 35, 328, 184, None, []],
    ["FRAME", "Frame 26085749", 0, 227, 328, 39, None, [
        ["FRAME", "Frame 26085766", 4, 0, 320, 39, None, [
            ["TEXT", "Episode", 0, 0, 320, 21, "Episode", []],
            ["TEXT", "지금 라이브 중! · 18:00-20:00", 0, 21, 320, 18, "지금 라이브 중! · 18:00-20:00", []],
        ]],
    ]],
]]


def plugin_node(t, ox, oy, idp):
    """Shape a fixture row like a Plugin API node at absolute origin (ox, oy)."""
    typ, name, x, y, w, h, chars, kids = t
    ax, ay = ox + x, oy + y
    n = {"id": f"{idp}:{abs(hash(name)) % 99999}", "type": typ, "name": name, "visible": True,
         "absoluteBoundingBox": {"x": ax, "y": ay, "width": w, "height": h}}
    if typ == "TEXT":
        n["characters"] = chars
    else:
        n["children"] = [plugin_node(k, ax, ay, idp) for k in kids]
    return n


HARNESS = r"""
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const mains = new Map(Object.entries(input.mains));
const hashOf = n => hashTree(n, bbox(n), true, () => {}, mains);
const out = { trees: input.trees.map(hashOf), sha: input.strings.map(sha256) };
process.stdout.write(JSON.stringify(out));
"""


def check_hash():
    """Catches: the hand-written SHA-256/UTF-8 drifting from real SHA-256, or the frame hash
    depending on node ids / absolute position, or ignoring text and child order."""
    node = shutil.which("node")
    assert node, "node not on PATH (mise install node)"
    js = plugin_script.INDEX_JS.split("// --- end hash ---")[0] + HARNESS
    base = plugin_node(TREE, 16228, 18375, "I2233:87901")
    moved = plugin_node(TREE, 96, 904, "I2177:59141")       # same design elsewhere, other ids
    texted = copy.deepcopy(base)
    texted["children"][0]["characters"] = "진행"
    swapped = copy.deepcopy(base)
    swapped["children"][1], swapped["children"][2] = swapped["children"][2], swapped["children"][1]
    # Plugin API IMAGE paint fields (type, visible, opacity, imageHash, scaleMode); the hash
    # values are stand-ins. A childless image-fill frame must not collide with another image.
    def with_image(tree, image_hash):
        t = copy.deepcopy(tree)
        t["children"][1]["fills"] = [{"type": "IMAGE", "visible": True, "opacity": 1, "imageHash": image_hash, "scaleMode": "FILL"}]
        return t
    img_a, img_b = with_image(base, "7f3c0a5e9d"), with_image(base, "b21e44c6a0")
    inst = copy.deepcopy(base)
    inst["type"] = "INSTANCE"
    inst2 = copy.deepcopy(inst)
    inst2["id"] = inst2["id"] + "x"
    mains = {inst["id"]: "key-a", inst2["id"]: "key-b"}  # stand-in component keys
    strings = ["abc", "", "플레이어 \u0008 📱 Mobile", "x" * 200]
    trees = [base, moved, texted, swapped, base, img_a, img_b, with_image(moved, "7f3c0a5e9d"), inst, inst2]
    r = subprocess.run([node, "-e", js], input=json.dumps({"trees": trees, "strings": strings, "mains": mains}),
                       capture_output=True, text=True)
    assert r.returncode == 0, f"node failed: {r.stderr}"
    got = json.loads(r.stdout)
    assert got["sha"] == [hashlib.sha256(s.encode()).hexdigest() for s in strings], got["sha"]
    h = got["trees"]
    assert h[0] == h[1] == h[4], "same subtree at another position / with other ids must hash alike"
    assert h[0] != h[2], "text characters must change the hash"
    assert h[0] != h[3], "child order must change the hash"
    assert len({h[0], h[5], h[6]}) == 3, "a differing imageHash must change the hash"
    assert h[5] == h[7], "the same image elsewhere must hash alike"
    assert h[8] != h[9], "instances of different main components must hash apart"


def check_file_key():
    """Catches: a branch URL indexing the main file instead of the branch."""
    k, b = "Ab3dE5fG7hJ9kL1mN3pQ5r", "Zr8bQ2nLwX5yT1cVdK7mPa"  # both keys are stand-ins of the real shape
    assert query.file_key(f"https://www.figma.com/design/{k}/branch/{b}/%EA%B0%99%EC%9D%B4?node-id=1-4") == b
    assert query.file_key(f"https://www.figma.com/design/{k}/%EA%B0%99%EC%9D%B4?node-id=2230-78067") == k
    assert query.file_key(k) == k


# Section 2233:84364 (진입 이후 이전 채팅 내역 표시), live use_figma read: absoluteBoundingBox of the
# section's screens, the named layer inside 홈, and vector 2233:92876's vectorNetwork endpoints
# transformed by absoluteTransform [[1,0,16572],[0,1,18695]] with their strokeCap.
SCREENS = [("2233:87901", "홈", [16228, 18375, 360, 1061]),
           ("2233:87902", "Player", [16708, 18375, 360, 640]),
           ("2233:87904", "Player", [17186, 18375, 360, 640])]
NAMED = [("I2233:87901;2177:53342", "2233:87901", "Frame 26085767", [16244, 19103, 328, 266])]


def check_connectors():
    """Catches: arrows bound to the wrong screen, reversed, or lost when the arrow starts
    outside its source layer's y-range (2233:92876 starts 116.5px above it)."""
    cands = [{"id": i, "screen": i, "name": n, "bb": b} for i, n, b in SCREENS]
    cands += [{"id": i, "screen": s, "name": n, "bb": b} for i, s, n, b in NAMED]
    e = derive.resolve_connector({"id": "2233:92876", "name": "Frame 26085767 -> Player | My Connector",
                                 "bb": [16572, 18695, 136, 291.5],
                                 "ends": [{"x": 16572, "y": 18986.5, "cap": "CIRCLE_FILLED"},
                                          {"x": 16708, "y": 18695, "cap": "ARROW_LINES"}]}, cands)
    assert (e["src"], e["dst"], e["src_node"]) == ("2233:87901", "2233:87902", "I2233:87901;2177:53342"), e
    # same vector with its ends listed the other way round: the arrow cap still picks the destination
    e2 = derive.resolve_connector({"id": "2233:92876", "name": "Frame 26085767 -> Player | My Connector",
                                  "bb": [16572, 18695, 136, 291.5],
                                  "ends": [{"x": 16708, "y": 18695, "cap": "ARROW_LINES"},
                                           {"x": 16572, "y": 18986.5, "cap": "CIRCLE_FILLED"}]}, cands)
    assert (e2["src"], e2["dst"]) == ("2233:87901", "2233:87902"), e2
    # 2233:92982 from get_metadata only (no vectorNetwork): bbox edges decide
    e3 = derive.resolve_connector({"id": "2233:92982", "name": "Player -> Player | My Connector",
                                  "bb": [17068, 18695, 118, 0], "ends": None}, cands)
    assert (e3["src"], e3["dst"]) == ("2233:87902", "2233:87904"), e3


# Section 2230:78067 "Player - 상태별 화면만 정리" (Mobile), live use_figma read: the 8 screens
# and the 12 프레임 타이틀 labels above them (744-wide group titles over 360-wide sub-titles).
JUX_FRAMES = [("2230:77257", 4860), ("2230:78068", 5244), ("2230:77369", 5700), ("2230:78147", 6084),
              ("2230:77583", 6540), ("2230:78324", 6924), ("2230:77825", 7380), ("2230:78533", 7764)]
JUX_LABELS = [("2230:78742", "선택", [4860, 16519, 360, 72]), ("2230:78771", "대기", [4860, 16423, 744, 72]),
              ("2230:78777", "진행", [5700, 16423, 744, 72]), ("2230:78780", "종료 대기", [6540, 16423, 744, 72]),
              ("2230:78783", "종료", [7380, 16423, 744, 72]), ("2230:78747", "선택 X", [5244, 16519, 360, 72]),
              ("2230:78750", "선택", [5700, 16519, 360, 72]), ("2230:78751", "선택 X", [6084, 16519, 360, 72]),
              ("2230:78757", "선택", [6540, 16519, 360, 72]), ("2230:78758", "선택 X", [6924, 16519, 360, 72]),
              ("2230:78764", "선택", [7380, 16519, 360, 72]), ("2230:78765", "선택 X", [7764, 16519, 360, 72])]


def check_juxtaposition():
    """Catches: the side-by-side state matrix splitting apart or losing its group/sub-title axes."""
    sec = "2230:78067"
    frames = [{"id": i, "section": sec, "bb": [x, 16615, 360, 640], "name": "Player"} for i, x in JUX_FRAMES]
    labels = [{"id": i, "kind": derive.FRAME_TITLE, "section": sec, "bb": b, "text": [t]} for i, t, b in JUX_LABELS]
    derive.pair_titles(frames, labels)
    derive.assign_states(frames, labels)
    groups = derive.group_juxtaposed(frames)
    assert len(groups) == 1 and (groups[0]["rows"], groups[0]["cols"]) == (1, 8), groups
    assert groups[0]["axes"] == [["대기", "진행", "종료 대기", "종료"], ["선택", "선택 X"]], groups[0]["axes"]
    by = {f["id"]: f for f in frames}
    assert by["2230:78068"]["title"] == "선택 X" and by["2230:78068"]["states"] == ["대기", "선택 X"]
    assert by["2230:78533"]["states"] == ["종료", "선택 X"]
    # states are alternatives, so no inferred step runs between them
    for f in frames:
        f["page"], f["visible"] = "1:4", True
    assert derive.infer_edges(frames, []) == []


def check_pacer():
    """Catches: two concurrent figma-cli runs each getting the full per-minute budget
    (the log shared through calls.log must cap them together)."""
    with tempfile.TemporaryDirectory() as d:
        log = Path(d) / "calls.log"
        a, b = auth.Pacer(per=3, window=2.0, log=log), auth.Pacer(per=3, window=2.0, log=log)
        sent: list[float] = []

        async def go(p):
            for _ in range(4):
                await p.wait()
                sent.append(time.time())

        async def both():
            await asyncio.gather(go(a), go(b))
        asyncio.run(both())
        sent.sort()
        assert len(sent) == 8 and a.count + b.count == 8
        worst = max(sum(t <= s < t + 2.0 for s in sent) for t in sent)
        assert worst <= 3, f"{worst} calls inside one 2s window"


if __name__ == "__main__":
    for check in (check_guard, check_hash, check_file_key, check_connectors, check_juxtaposition, check_pacer):
        check()
        print(f"ok {check.__name__}")
