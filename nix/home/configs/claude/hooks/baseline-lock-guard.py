#!/usr/bin/env python3
"""PreToolUse guard: a captured baseline stays as captured.

A parity check (visual diff, snapshot test, golden output) only means
something while its baseline is the one captured before the change. An agent
whose diff fails can make it pass by re-recording the baseline instead of
fixing the change -- the shortcut pstack's visual-parity playbook names as
"baseline tampering". Prose cannot stop a worker that is optimising for the
check, so the baseline is locked on disk:

  - after capture, create an empty `.baseline-lock` file in the baseline
    directory (or any ancestor of it);
  - this hook then denies Edit/Write/MultiEdit/NotebookEdit on any file under
    that directory, and a Bash call that passes a snapshot-update flag
    (`--update-snapshots`, `--updateSnapshot`, `--update-baseline`, ...)
    from a working directory at, under, or up to four levels above a lock;
  - the user refreshes the baseline by deleting the lock file themselves.

Writing the `.baseline-lock` file itself stays allowed, since that is the
capture step. Fail-open: any parse problem exits 0 silently.

Self-check: `python3 baseline-lock-guard.py --selftest`.
"""
import json
import os
import re
import sys

LOCK = ".baseline-lock"
EDIT_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
UPDATE_FLAG = re.compile(
    r"(?<![\w-])--(update-?snapshots?|updateSnapshots?|update-baselines?|"
    r"update-goldens?|update-golden-files|snapshot-update|record-snapshots?)\b",
    re.IGNORECASE,
)


def lock_above(path):
    """The nearest .baseline-lock in path's directory or an ancestor, or None."""
    cur = path if os.path.isdir(path) else os.path.dirname(path)
    while True:
        candidate = os.path.join(cur, LOCK)
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent


SKIP_DIRS = {"node_modules", "vendor", "target", "dist", "build"}
MAX_DIRS = 2000


def lock_below(root, depth=4):
    """A .baseline-lock within depth levels under root, or None. Bounded,
    because a test runner is usually started from the project root while the
    baseline sits a few folders down (e2e/__screenshots__)."""
    seen = 0
    for cur, dirs, files in os.walk(root):
        if LOCK in files:
            return os.path.join(cur, LOCK)
        seen += 1
        if seen >= MAX_DIRS or cur[len(root):].count(os.sep) >= depth:
            dirs[:] = []
        else:
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS]
    return None


def absolute(path, cwd):
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        path = os.path.join(cwd or os.getcwd(), path)
    return os.path.normpath(path)


def reason_for(data):
    tool = data.get("tool_name")
    ti = data.get("tool_input")
    if not isinstance(ti, dict):
        return None
    cwd = data.get("cwd") if isinstance(data.get("cwd"), str) else None
    if tool in EDIT_TOOLS:
        target = ti.get("file_path") or ti.get("notebook_path")
        if not isinstance(target, str) or not target:
            return None
        target = absolute(target, cwd)
        if os.path.basename(target) == LOCK:
            return None
        lock = lock_above(target)
        if lock:
            return (f"{target} is under a locked baseline ({lock}). Fix the change so "
                    "it matches the baseline; if the baseline itself looks wrong, stop "
                    "and ask the user, who refreshes it by deleting the lock file.")
        return None
    if tool == "Bash":
        cmd = ti.get("command")
        if not isinstance(cmd, str) or not cwd or not UPDATE_FLAG.search(cmd):
            return None
        root = absolute(cwd, None)
        lock = lock_above(root) or lock_below(root)
        if lock:
            return (f"This command re-records snapshots under a locked baseline ({lock}). "
                    "Make the change pass against the captured baseline; if the baseline "
                    "looks wrong, stop and ask the user, who refreshes it by deleting the lock.")
    return None


def main():
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            return
        reason = reason_for(data)
        if reason:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": reason,
            }}))
    except Exception:
        pass  # fail-open


def selftest():
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        base = os.path.join(td, "e2e", "__screenshots__")
        os.makedirs(os.path.join(base, "home"))
        src = os.path.join(td, "src")
        os.makedirs(src)

        def edit(path, tool="Edit"):
            return reason_for({"tool_name": tool, "tool_input": {"file_path": path}, "cwd": td})

        def bash(cmd, cwd):
            return reason_for({"tool_name": "Bash", "tool_input": {"command": cmd}, "cwd": cwd})

        shot = os.path.join(base, "home", "hero.png")
        assert edit(shot, "Write") is None  # no lock yet: capture goes through
        assert edit(os.path.join(base, LOCK), "Write") is None
        open(os.path.join(base, LOCK), "w").close()
        assert edit(shot, "Write")
        assert edit("e2e/__screenshots__/home/hero.png")  # relative to cwd
        assert edit(os.path.join(src, "Hero.tsx")) is None  # the component stays editable
        assert edit(os.path.join(base, LOCK), "Write") is None
        assert bash("npx playwright test --update-snapshots", os.path.join(td, "e2e"))
        assert bash("npx jest --updateSnapshot", base)
        assert bash("npx playwright test", os.path.join(td, "e2e")) is None
        assert bash("npx playwright test --update-snapshots", td)  # project root
        assert bash("npx playwright test --update-snapshots", src) is None
        assert reason_for({"tool_name": "Edit", "tool_input": None}) is None
        assert reason_for({"tool_name": "Read", "tool_input": {"file_path": shot}}) is None
    print("baseline-lock-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
    sys.exit(0)
