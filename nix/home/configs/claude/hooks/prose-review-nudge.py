#!/usr/bin/env python3
"""PreToolUse hook: point a reader-facing prose edit at the prose-editor subagent.

prose-editor (agents/prose-editor.md) is the single home of the prose rules and
reviews a finished draft as a zero-context outside reader. It only helps when it
is spawned, and a description alone does not get it spawned: gh-guard.py
measured that only 11% of `gh pr create` runs had loaded github-master on their
own. The edit itself is the one moment with a tool call to hang a reminder on.

This hook does NOT deny. Like prompt-authoring-guard.py, it rides along as
`additionalContext` with no `permissionDecision`, so the edit happens, no
round-trip is spent, and every other hook's verdict stands.

Fires on `*.md`, `*.mdx` and `*.html` (Artifact pages included) that a person
reads. The two hooks split every file: text a model reads as behavior --
SKILL.md, AGENTS.md, CLAUDE.md, anything under agents/ or skills/ -- belongs
to prompt-authoring-guard.py, and this hook also skips memory, the Claude
config dirs, hooks and node_modules, which have no outside reader.

The reminder is recorded per (session, file path) with a 3h TTL, so twenty
edits to one doc pay for it once, while a second doc gets its own.

Fails open on every internal error -- a bug here must never block an edit.

Self-check: `python3 prose-review-nudge.py --selftest`.
"""
import json
import os
import sys
import time

TTL_SECONDS = 3 * 3600
STATE_DIR = os.path.expanduser("~/.claude-personal/state/prose-review-nudge")
EDIT_TOOLS = ("Edit", "Write", "MultiEdit")
PROSE_SUFFIXES = (".md", ".mdx", ".html")
# prompt-authoring-guard.py owns these basenames, wherever they sit.
BEHAVIOR_BASENAMES = ("SKILL.md", "AGENTS.md", "CLAUDE.md")
# Path segments whose files are model-facing or have no outside reader.
SKIP_PARTS = {
    "agents", "skills", "memory", "hooks", "node_modules",
    ".claude", ".claude-personal", ".agents", ".codex",
}

NUDGE = (
    "[prose-review-nudge] {path} is reader-facing prose. After your last edit "
    "to it, and before you report or publish it, spawn the `prose-editor` "
    "subagent with this path, who reads it, and what they came to do; then "
    "apply its findings or list them in your reply."
)


def is_reader_prose(path):
    """True for a Markdown or HTML file whose reader is a person.

    Disjoint from prompt-authoring-guard.py's is_behavior_text: every path that
    one matches is excluded here by basename or by an agents/skills segment."""
    if not path or not isinstance(path, str):
        return False
    norm = path.replace("\\", "/")
    if not norm.lower().endswith(PROSE_SUFFIXES):
        return False
    if os.path.basename(norm) in BEHAVIOR_BASENAMES:
        return False
    return not any(p in SKIP_PARTS for p in norm.split("/"))


def load_state(path):
    try:
        with open(path) as fh:
            st = json.load(fh)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


def context(text):
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": text,
    }}


def handle(data, state_dir=None, now=None):
    """Process one PreToolUse event; returns the payload to emit, or None."""
    if data.get("tool_name") not in EDIT_TOOLS:
        return None
    path = (data.get("tool_input") or {}).get("file_path")
    if not is_reader_prose(path):
        return None

    now = time.time() if now is None else now
    sdir = state_dir or STATE_DIR
    state_path = os.path.join(sdir, f"{data.get('session_id') or 'no-session'}.json")
    state = load_state(state_path)
    paths = state.get("paths") if isinstance(state.get("paths"), dict) else {}
    last = paths.get(path) or 0
    if last and now - last <= TTL_SECONDS:
        return None

    paths[path] = now
    state["paths"] = paths
    try:
        os.makedirs(sdir, exist_ok=True)
        with open(state_path, "w") as fh:
            json.dump(state, fh)
    except OSError:
        pass  # an unwritable state dir costs a repeat reminder, never a block

    return context(NUDGE.format(path=path))


def main():
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open
    if not isinstance(data, dict):
        sys.exit(0)
    try:
        payload = handle(data)
    except Exception as e:
        print(f"[prose-review-nudge] internal error, failing open: {e}",
              file=sys.stderr)
        sys.exit(0)
    if payload:
        print(json.dumps(payload))
    sys.exit(0)


def selftest():
    import subprocess
    import tempfile

    for path in (
        "/r/docs/src/claude-code.md",
        "/r/README.md",
        "/r/CHANGELOG.md",
        "/r/site/guide.mdx",
        "/private/tmp/claude-501/x/scratchpad/report.html",
        r"C:\r\docs\setup.md",
    ):
        assert is_reader_prose(path), path

    # Behavior text (prompt-authoring-guard.py's half) and private notes.
    for path in (
        "/r/nix/home/configs/.agents/skills/git-master/SKILL.md",
        "/r/skills/github-master/guides/pr.md",
        "/r/nix/home/configs/claude/agents/prose-editor.md",
        "/r/AGENTS.md",
        "/r/nix/home/configs/claude/CLAUDE.md",
        "/Users/u/.claude-personal/projects/p/memory/evidence/x.md",
        "/r/.claude/notes.md",
        "/r/web/node_modules/pkg/README.md",
        "/r/nix/home/configs/claude/hooks/notes.md",
        "/r/src/main.py",
        "/r/docs/diagram.svg",
        "",
        None,
    ):
        assert not is_reader_prose(path), path

    with tempfile.TemporaryDirectory() as td:
        sdir = os.path.join(td, "state")

        def run(tool, path, sid="s1", now=1000.0):
            return handle({"tool_name": tool, "session_id": sid,
                           "tool_input": {"file_path": path}},
                          state_dir=sdir, now=now)

        assert run("Bash", "/r/docs/a.md") is None
        assert run("Write", "/r/skills/x/SKILL.md") is None
        assert run("Edit", "/u/.claude-personal/memory/a.md") is None

        out = run("Write", "/r/docs/a.md")
        hso = out["hookSpecificOutput"]
        assert hso["hookEventName"] == "PreToolUse"
        assert "prose-editor" in hso["additionalContext"]
        assert "/r/docs/a.md" in hso["additionalContext"]
        # No verdict: the nudge never decides whether the edit happens.
        assert "permissionDecision" not in hso, hso
        assert len(hso["additionalContext"]) < 400 + len("/r/docs/a.md")

        # Same file, same session, inside the TTL: reminded once.
        assert run("Edit", "/r/docs/a.md", now=1500.0) is None
        assert run("MultiEdit", "/r/docs/a.md", now=1600.0) is None
        # A second file in the same session gets its own reminder.
        assert run("Edit", "/r/docs/b.md", now=1700.0) is not None
        # Another session, or past the TTL, is reminded again.
        assert run("Edit", "/r/docs/a.md", sid="s2") is not None
        assert run("Edit", "/r/docs/a.md", now=1000.0 + TTL_SECONDS + 1) is not None

    # Malformed stdin: exit 0, nothing on stdout.
    for raw in ("not json", "[1, 2]", ""):
        p = subprocess.run([sys.executable, os.path.abspath(__file__)],
                           input=raw, capture_output=True, text=True)
        assert p.returncode == 0 and p.stdout == "", (raw, p.returncode, p.stdout)

    print("prose-review-nudge.py selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
