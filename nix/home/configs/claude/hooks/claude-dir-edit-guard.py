#!/usr/bin/env python3
"""PreToolUse guard: deny Edit/Write to anything under ~/.claude/.

Home Manager owns ~/.claude/ -- every file there is generated from
nix/home/configs/claude/ in ~/.dotfiles. A direct edit either fails on a
read-only nix-store symlink or silently gets clobbered by the next rebuild, so
the deny reason points Claude at the repo source of truth instead.

~/.claude-personal (memory) is a sibling directory and never matches the
prefix. Fail-open on any parse problem -- a bug here must not block normal
edits elsewhere.

Self-check: `python3 claude-dir-edit-guard.py --selftest`.
"""
import json
import os
import signal
import sys

CLAUDE_DIR = os.path.join(os.path.expanduser("~"), ".claude") + os.sep

REASON = (
    "Never edit ~/.claude/ directly -- Home Manager owns it and the next "
    "rebuild clobbers the change. Edit the source in "
    "~/.dotfiles/nix/home/configs/claude/ instead, then apply with "
    "`sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26`."
)


def is_claude_path(file_path, cwd):
    if not file_path:
        return False
    p = os.path.expanduser(file_path)
    if not os.path.isabs(p):
        p = os.path.join(cwd or os.getcwd(), p)
    return os.path.normpath(p).startswith(CLAUDE_DIR)


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    sys.exit(0)


def main():
    # Bound the stdin read so a stalled harness pipe can never hang the tool.
    signal.signal(signal.SIGALRM, lambda *_: sys.exit(0))
    signal.alarm(5)
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open
    finally:
        signal.alarm(0)

    file_path = (data.get("tool_input", {}) or {}).get("file_path", "")
    if is_claude_path(file_path, data.get("cwd")):
        deny(REASON)
    sys.exit(0)


def selftest():
    home = os.path.expanduser("~")
    assert is_claude_path(home + "/.claude/settings.json", None)
    assert is_claude_path("~/.claude/hooks/x.py", None)
    assert is_claude_path(home + "/.claude/agents/../CLAUDE.md", None)
    assert not is_claude_path(home + "/.claude-personal/memory/x.md", None)
    assert not is_claude_path(home + "/.dotfiles/nix/home/configs/claude/settings.json", None)
    assert not is_claude_path(".claude/settings.json", home + "/project")
    assert is_claude_path(".claude/settings.json", home)
    assert not is_claude_path("", None)
    print("claude-dir-edit-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
