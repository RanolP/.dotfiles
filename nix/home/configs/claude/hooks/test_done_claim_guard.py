#!/usr/bin/env python3
"""Assert check for done-claim-guard.py.

Regression it catches: the guard letting "타입 검사는 통과했다, 새로고침하면
보인다" through after an edit nothing ran (the 2026-11-18 banner-session
pattern), or starting to block turns that did run the change, turns that only
answered a question, or turns that already said what stayed unverified.
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "done-claim-guard.py")
spec = importlib.util.spec_from_file_location("guard", HOOK)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def prompt(text):
    return {"type": "user", "message": {"content": text}}


def call(name, **inp):
    return {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": name, "input": inp}]}}


def result():
    return {"type": "user", "message": {"content": [{"type": "tool_result", "content": "ok"}]}}


def run(entries, final, **extra):
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        for e in entries:
            fh.write(json.dumps(e) + "\n")
        path = fh.name
    try:
        payload = {"hook_event_name": "Stop", "transcript_path": path,
                   "last_assistant_message": final, "stop_hook_active": False}
        payload.update(extra)
        p = subprocess.run([sys.executable, HOOK], input=json.dumps(payload).encode(),
                           capture_output=True, timeout=10)
    finally:
        os.unlink(path)
    assert p.returncode == 0, p.stderr
    return json.loads(p.stdout) if p.stdout.strip() else None


SRC = "/repo/src/Wall.tsx"
EDIT = call("Edit", file_path=SRC, old_string="a", new_string="b")
CLAIM = "벽 색을 바꿨다. 타입 검사는 통과했다. 새로고침하면 보인다."


def main():
    blocked = run([prompt("벽 색 밝게"), EDIT, result(), call("Bash", command="npx tsc --noEmit")], CLAIM)
    assert blocked and blocked["decision"] == "block", blocked

    # Earlier turns do not count: the turn starts at the newest prompt.
    assert run([prompt("a"), EDIT, prompt("뭐가 바뀌었어?")], CLAIM) is None
    assert run([prompt("x"), EDIT, call("Bash", command="npm test -- wall")], CLAIM) is None
    assert run([prompt("x"), call("Read", file_path=SRC)], "Fixed in the last turn.") is None
    assert run([prompt("x"), EDIT], "고쳤다. 화면에서는 아직 확인하지 않았다.") is None
    assert run([prompt("x"), EDIT], CLAIM, stop_hook_active=True) is None
    assert run([prompt("x"), call("Edit", file_path="/repo/README.md")], "Done.") is None
    assert run([prompt("x"), EDIT], "Which colour do you want?") is None

    # REPL: an edit followed by a run in the same script passes; JS arrows in a
    # quoted browser eval are not a redirect into a file.
    assert run([prompt("x"), call("REPL", code="const CR = '%s';\nawait edit(CR, 'a', 'b');\n"
                                   "await $`npx vitest run`;" % SRC)], CLAIM) is None
    assert run([prompt("x"), call("REPL", code="await edit('%s', 'a', 'b');" % SRC)], CLAIM)
    assert not guard.bash_edits("agent-browser eval '(() => { return a > 1 })()'")
    assert guard.bash_edits("sed -i 's/a/b/' src/x.py")
    assert not guard.bash_edits("sed -i 's/a/b/' notes/handoff.md")
    assert not guard.command_runs("git status && rg foo | head")
    assert guard.command_runs("cd repo && uv run pytest -q")

    for bad in (b"", b"not json", b"[1]", json.dumps({"last_assistant_message": "done",
                                                     "transcript_path": "/nonexistent"}).encode()):
        p = subprocess.run([sys.executable, HOOK], input=bad, capture_output=True, timeout=10)
        assert p.returncode == 0 and not p.stdout.strip(), (bad, p.stdout, p.stderr)
    print("test_done_claim_guard: ok")


if __name__ == "__main__":
    main()
