#!/usr/bin/env python3
"""Semantics test for memory-review-nudge.py.

The hook nudges toward `/memory-review` when a project's saved memories have
both passed a floor and grown since the last nudge, and stays silent otherwise
-- a SessionStart line is re-read by every later request in the session, so a
repeated nudge on an unchanged pile is pure cost.

Usage: memory-review-nudge-test.py   (exit 0 when every case passes)
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "nix", "home", "configs", "claude", "hooks",
                    "memory-review-nudge.py")

PROJECT = "/Users/tester/some-project"
SLUG = PROJECT.replace("/", "-").replace(".", "-")


def memory_dir(home):
    return os.path.join(home, ".claude-personal", "projects", SLUG, "memory")


def populate(home, n):
    path = memory_dir(home)
    os.makedirs(path, exist_ok=True)
    open(os.path.join(path, "MEMORY.md"), "w").close()
    for i in range(n):
        open(os.path.join(path, "note_%02d.md" % i), "w").close()


def nudge(home, cwd=PROJECT):
    env = dict(os.environ, HOME=home)
    p = subprocess.run([sys.executable, HOOK], text=True, capture_output=True, timeout=30,
                       env=env, input=json.dumps({"hook_event_name": "SessionStart", "cwd": cwd}))
    if p.returncode != 0:
        return "error(%d): %s" % (p.returncode, p.stderr.strip()[-200:])
    if not p.stdout.strip():
        return "silent"
    return json.loads(p.stdout)["hookSpecificOutput"]["additionalContext"]


def main():
    home = tempfile.mkdtemp()
    results = []
    try:
        populate(home, 9)
        results.append(("below the floor", nudge(home) == "silent"))

        populate(home, 10)
        first = nudge(home)
        results.append(("at the floor, nudges", first.startswith("10 memories")))

        results.append(("re-run is snoozed", nudge(home) == "silent"))

        populate(home, 12)
        results.append(("grown by 2, still snoozed", nudge(home) == "silent"))

        populate(home, 13)
        grown = nudge(home)
        results.append(("grown by 3, nudges again", grown.startswith("13 memories")))

        results.append(("the nudge names /memory-review", "/memory-review" in grown))

        results.append(("no such project dir", nudge(home, "/Users/tester/absent") == "silent"))
    finally:
        shutil.rmtree(home, ignore_errors=True)

    # A read-only HOME is what the container verifier runs under; the hook must
    # not surface the failed state write as a crash.
    ro = tempfile.mkdtemp()
    try:
        populate(ro, 10)
        os.chmod(os.path.join(ro, ".claude-personal"), 0o500)
        results.append(("unwritable state file stays quiet", nudge(ro) == "silent"))
    finally:
        os.chmod(os.path.join(ro, ".claude-personal"), 0o700)
        shutil.rmtree(ro, ignore_errors=True)

    failures = 0
    for name, ok in results:
        failures += not ok
        print("%s  %s" % ("ok  " if ok else "FAIL", name))
    print("%d/%d passed" % (len(results) - failures, len(results)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
