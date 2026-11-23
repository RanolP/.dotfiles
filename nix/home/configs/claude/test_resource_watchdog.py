#!/usr/bin/env python3
"""Regression: a stop notice reached whichever session ran Bash next instead of the session that started the
process (2026-11-23). Checks that resource-watchdog.py attributes a stopped pid to the claude session above it,
through a codex bridge, and that a sibling session's pid stays unattributed. Run: python3 <this file>"""
import importlib.util, json, tempfile
from pathlib import Path

here = Path(__file__).parent
spec = importlib.util.spec_from_file_location("watchdog", here / "resource-watchdog.py")
wd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wd)  # main() is guarded, so this only defines functions

CLAUDE = "/x/mise/installs/claude/2.1.327/claude --mcp-config m.json"
procs = {  # pid: (ppid, rss, stat, command)
    100: (1, 1, "S", CLAUDE), 200: (1, 1, "S", CLAUDE),
    110: (100, 1, "S", "/bin/zsh -c ipsw"), 111: (110, 9_000_000, "R", "ipsw dyld xref"),
    120: (100, 1, "S", "/opt/bin/codex app-server"), 121: (120, 5_000_000, "R", "cargo build"),
    210: (200, 1, "S", "node mcp-server.js"),
}
with tempfile.TemporaryDirectory() as d:
    for pid, sid in [(100, "session-A"), (200, "session-B")]:
        (Path(d) / f"{pid}.json").write_text(json.dumps({"pid": pid, "sessionId": sid, "cwd": "/w"}))
    (Path(d) / "300.json").write_text(json.dumps({"pid": 999, "sessionId": "stale"}))
    lookup = lambda pid: wd.session_of(pid, d + "/{pid}.json")
    assert wd.owner(111, procs, lookup)["session_id"] == "session-A"
    assert wd.owner(121, procs, lookup) == {"session_id": "session-A", "claude_pid": 100, "cwd": "/w"}, "walks through codex"
    assert wd.owner(210, procs, lookup)["session_id"] == "session-B"
    assert wd.session_of(300, d + "/{pid}.json") is None, "a file whose pid field disagrees is not trusted"
    assert wd.owner(999, procs, lookup)["session_id"] is None
assert max(wd.agent_children(procs), key=lambda k: k[1])[0] == 111
bridge = {**procs, 130: (100, 9_999_999, "S", "node /h/.claude/mods/hetero-subagents/daemon/codex-bridge.mjs")}
cands = {k[0] for k in wd.agent_children(bridge)}
assert 130 not in cands, "a codex bridge under a claude session is never a stop candidate"
assert cands == {111}, f"only shell-tool jobs are candidates (not the shell, codex app-server, its children, MCP): {cands}"
print("ok")
