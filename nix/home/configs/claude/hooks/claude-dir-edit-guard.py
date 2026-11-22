#!/usr/bin/env python3
"""Protect agent configuration owned by Home Manager and user-granted permissions.

Home Manager generates the entries in MANAGED_ENTRIES from the Claude and Codex
sources under ~/.dotfiles/nix/home/configs/.
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
import sys

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

MANAGED_ENTRIES = {
    "claude": HM_OWNED,
    "codex": frozenset({"config.toml", "AGENTS.md", "agents", "hooks"}),
}


def protected_config_reason(file_path, cwd):
    if not isinstance(file_path, str) or not file_path:
        return None
    p = os.path.expanduser(file_path)
    if not os.path.isabs(p):
        p = os.path.join(cwd or os.getcwd(), p)
    p = os.path.normpath(p)
    if os.path.basename(p) == ".nanno-workers.json":
        return (".nanno-workers.json records user-granted repository permissions; "
                "leave this file under the user's control.")
    for agent, owned in MANAGED_ENTRIES.items():
        prefix = os.path.join(os.path.expanduser("~"), "." + agent) + os.sep
        if p.startswith(prefix) and p[len(prefix):].split(os.sep)[0] in owned:
            return (f"Edit Home-Manager-owned {agent} configuration in "
                    f"~/.dotfiles/nix/home/configs/{agent}/; the next rebuild "
                    f"replaces direct edits under ~/.{agent}/. Apply with `{REBUILD}`.")
    return None


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    sys.exit(0)


def main():
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open

    if not isinstance(data, dict) or not isinstance(data.get("tool_input", {}), dict):
        sys.exit(0)
    file_path = data.get("tool_input", {}).get("file_path", "")
    reason = protected_config_reason(file_path, data.get("cwd"))
    if reason:
        deny(reason)
    sys.exit(0)


def selftest():
    home = os.path.expanduser("~")
    assert protected_config_reason(home + "/.claude/settings.json", None)
    assert protected_config_reason("~/.claude/hooks/x.py", None)
    assert protected_config_reason(home + "/.claude/agents/../CLAUDE.md", None)
    assert protected_config_reason(home + "/.claude/skills/x/SKILL.md", None)
    assert not protected_config_reason(home + "/.dotfiles/nix/home/configs/claude/settings.json", None)
    assert not protected_config_reason(".claude/settings.json", home + "/project")
    assert protected_config_reason(".claude/settings.json", home)
    assert not protected_config_reason("", None)
    # Runtime state: the rebuild never generates these, so edits must go through.
    assert not protected_config_reason(home + "/.claude/plans/some-plan.md", None)
    assert not protected_config_reason(home + "/.claude/projects/-home-ranolp--dotfiles/memory/x.md", None)
    assert not protected_config_reason(home + "/.claude/tasks/t.json", None)
    assert not protected_config_reason(home + "/.claude/shell-snapshots/s.sh", None)
    # A runtime dir must not be defeated by an owned name deeper in the path.
    assert not protected_config_reason(home + "/.claude/projects/p/settings.json", None)
    # A sibling directory sharing the prefix remains writable.
    assert not protected_config_reason(home + "/.claude-personal/memory/x.md", None)
    # Codex configuration stays declarative while its writable state stays usable.
    assert protected_config_reason("~/.codex/config.toml", None)
    assert protected_config_reason(".codex/agents/oracle.toml", home)
    assert protected_config_reason("/repo/.nanno-workers.json", None)
    assert not protected_config_reason("~/.codex/auth.json", None)
    assert not protected_config_reason("~/.codex/memories/note.md", None)
    assert not protected_config_reason(".codex/config.toml", home + "/project")
    print("claude-dir-edit-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
