#!/usr/bin/env python3
"""PreToolUse guard: deny Edit/Write to the Home-Manager-owned parts of ~/.claude/.

Home Manager generates a fixed set of entries there from
nix/home/configs/claude/ in ~/.dotfiles -- exactly the names in HM_OWNED below.
A direct edit to one of those either fails on a read-only nix-store symlink or
silently gets clobbered by the next rebuild, so the deny reason points Claude at
the repo source of truth instead.

Everything else under ~/.claude/ is runtime state the rebuild never touches --
plans/, projects/ (which holds the per-project memory dirs), tasks/, sessions/,
shell-snapshots/ and friends. Blanket-denying the whole prefix broke plan-file
writes and memory saves, so the check is an owned-name match, not a prefix match.

Fail-open on any parse problem -- a bug here must not block normal edits
elsewhere.

Self-check: `python3 claude-dir-edit-guard.py --selftest`.
"""
import json
import os
import threading
import sys

CLAUDE_DIR = os.path.join(os.path.expanduser("~"), ".claude") + os.sep

# First path segment under ~/.claude/ that Home Manager owns. Mirrors the file
# listing of nix/home/configs/claude/, plus the skills -> ../.agents/skills link.
HM_OWNED = frozenset({
    "agents",
    "hooks",
    "rules",
    "skills",
    "CLAUDE.md",
    "settings.json",
    "statusline.sh",
})

REBUILD = (
    "sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26"
    if sys.platform == "darwin"
    else "home-manager switch --flake ~/.dotfiles/nix#ranolp-archwsl -b before-hm"
)

REASON = (
    "Never edit Home-Manager-owned files under ~/.claude/ directly ("
    + ", ".join(sorted(HM_OWNED))
    + ") -- the next rebuild clobbers the change. Edit the source in "
    "~/.dotfiles/nix/home/configs/claude/ instead, then apply with "
    f"`{REBUILD}`."
)


def is_claude_path(file_path, cwd):
    if not file_path:
        return False
    p = os.path.expanduser(file_path)
    if not os.path.isabs(p):
        p = os.path.join(cwd or os.getcwd(), p)
    p = os.path.normpath(p)
    if not p.startswith(CLAUDE_DIR):
        return False
    return p[len(CLAUDE_DIR):].split(os.sep)[0] in HM_OWNED


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    sys.exit(0)


def main():
    # Bound the stdin read so a stalled harness pipe can never hang the tool.
    # A background timer thread (not a Unix alarm signal) so this works on
    # Windows too, where xpkg links the config into ~/.claude/, not Home Manager.
    timer = threading.Timer(5, os._exit, args=(0,))
    timer.daemon = True
    timer.start()
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open
    finally:
        timer.cancel()

    file_path = (data.get("tool_input", {}) or {}).get("file_path", "")
    if is_claude_path(file_path, data.get("cwd")):
        deny(REASON)
    sys.exit(0)


def selftest():
    home = os.path.expanduser("~")
    assert is_claude_path(home + "/.claude/settings.json", None)
    assert is_claude_path("~/.claude/hooks/x.py", None)
    assert is_claude_path(home + "/.claude/agents/../CLAUDE.md", None)
    assert is_claude_path(home + "/.claude/skills/x/SKILL.md", None)
    assert not is_claude_path(home + "/.dotfiles/nix/home/configs/claude/settings.json", None)
    assert not is_claude_path(".claude/settings.json", home + "/project")
    assert is_claude_path(".claude/settings.json", home)
    assert not is_claude_path("", None)
    # Runtime state: the rebuild never generates these, so edits must go through.
    assert not is_claude_path(home + "/.claude/plans/some-plan.md", None)
    assert not is_claude_path(home + "/.claude/projects/-home-ranolp--dotfiles/memory/x.md", None)
    assert not is_claude_path(home + "/.claude/tasks/t.json", None)
    assert not is_claude_path(home + "/.claude/shell-snapshots/s.sh", None)
    # A runtime dir must not be defeated by an owned name deeper in the path.
    assert not is_claude_path(home + "/.claude/projects/p/settings.json", None)
    # Sibling dirs sharing the ".claude" prefix are not inside CLAUDE_DIR.
    assert not is_claude_path(home + "/.claude-personal/memory/x.md", None)
    print("claude-dir-edit-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
