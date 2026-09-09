#!/usr/bin/env python3
"""SessionStart: say when this project's memories have grown enough to be worth reviewing.

The `memory-review` skill ranks which saved memories deserve promotion into the
shared agent rules, and `dotfiles:evolve` performs the migration. Both work.
Neither is ever invoked, because nothing asks for them -- so promotion
candidates accumulate in `~/.claude-personal/projects/<slug>/memory/` and go
unread. A rule in `~/.dotfiles` reaches every agent on every host through Home
Manager; a memory reaches one project folder. Leaving the pile unreviewed is
therefore leaving rules unwritten.

The trigger is the only missing piece, so this hook is only the trigger: it
counts and it nudges. Two conditions gate the line -- an absolute floor, so a
young project is left alone, and growth since the last nudge, so the same pile
is not announced every session. The count at the last nudge is the whole snooze
state.

Silent on every error. A SessionStart hook that throws disturbs the session it
was meant to help, and this one carries nothing worth that.

Self-check: `python3 scripts/memory-review-nudge-test.py`.
"""
import json
import os
import sys

# Below this the pile is too small for a ranking pass to say anything useful.
FLOOR = 10
# Re-nudging on the same pile is noise; a nudge earns its line by new material.
GROWTH = 3

BASE = "~/.claude-personal"
STATE = os.path.join(BASE, "memory-review-nudge.json")

MESSAGE = ("%d memories saved for this project have not been reviewed for promotion. "
           "`/memory-review` ranks which of them should become rules in ~/.dotfiles.")


def slug(cwd):
    """Claude Code's project directory name: the cwd with `/` and `.` flattened to `-`."""
    return cwd.replace("/", "-").replace(".", "-")


def memory_count(cwd):
    """Top-level `*.md` files in the project's memory dir, minus the index."""
    path = os.path.join(os.path.expanduser(BASE), "projects", slug(cwd), "memory")
    return len([n for n in os.listdir(path)
                if n.endswith(".md") and n != "MEMORY.md"
                and os.path.isfile(os.path.join(path, n))])


def last_count(state_path, key):
    try:
        with open(state_path) as fh:
            return int(json.load(fh).get(key, 0))
    except (OSError, ValueError, TypeError, AttributeError):
        return 0


def record(state_path, key, count):
    try:
        with open(state_path) as fh:
            state = json.load(fh)
        if not isinstance(state, dict):
            state = {}
    except (OSError, ValueError):
        state = {}
    state[key] = count
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    with open(state_path, "w") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)


def main():
    data = json.load(sys.stdin)
    cwd = data.get("cwd") if isinstance(data, dict) else None
    if not isinstance(cwd, str) or not cwd:
        return

    count = memory_count(cwd)
    state_path = os.path.expanduser(STATE)
    key = slug(cwd)
    if count < FLOOR or count - last_count(state_path, key) < GROWTH:
        return

    # Written only on the nudging path, so a read-only HOME never costs a line.
    record(state_path, key, count)
    json.dump({"hookSpecificOutput": {"hookEventName": "SessionStart",
                                      "additionalContext": MESSAGE % count}}, sys.stdout)


try:
    main()
except SystemExit:
    raise
except BaseException:
    pass
sys.exit(0)
