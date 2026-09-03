#!/usr/bin/env python3
"""Plan mode is transcribe-only: the plan is finished in auto mode BEFORE
EnterPlanMode, and plan mode exists only to carry that finished text out. So
every tool is denied here except writing the plan file and ExitPlanMode.
AskUserQuestion stays available for requirement clarification, and ToolSearch
for loading the deferred ExitPlanMode schema -- without it a session already in
plan mode could never exit.

Read-only lookups are denied too, Read and Grep included. They were once open
on the theory that distilling a plan surfaces gaps and reading one file is
cheaper than leaving and re-entering. That theory is wrong for the purpose:
removing context is what a handoff is for, and every file read inside plan mode
puts back some of what the reset was supposed to drop. A gap found here means
the research was unfinished, so the answer is to exit, research in auto mode,
and re-enter with the plan complete.

A Write/Edit of the plan file itself is auto-allowed rather than merely
permitted: distilling the plan is the ONE thing plan mode is for, so prompting
for it is pure friction. Any other Write/Edit still falls through to the normal
permission flow.

The plan directory is per auth profile, so it is resolved rather than fixed.
`ccc <profile>` (nix/home/configs/nushell/config.nu) runs claude under
CLAUDE_CONFIG_DIR=~/.claude-<profile>, and plans land in that dir's plans/.
Pinning this to ~/.claude/plans/ made the auto-allow dead code under every
profile: measured 2026-08-31, ~/.claude/plans held 7 files against 37 in
~/.claude-personal/plans. The write then fell into the normal permission flow,
Write demanded a prior Read of a file it had just created, and the turn ended
inside plan mode with ExitPlanMode never called -- 4 of the 5 abandoned plan
files found across 1491 transcripts, ~8k tokens of finished plan discarded.

CLAUDE_CONFIG_DIR is read when present, and any ~/.claude*/plans/ is accepted
too so the guard still works if the hook is spawned without that variable.

Self-check: `python3 plan-mode-guard.py --selftest`.
"""

import json
import os
import sys

# ToolSearch is here for one reason only: ExitPlanMode is a deferred tool, so a
# session that entered plan mode without its schema loaded needs the search to
# be able to leave at all.
ALLOWED = frozenset({
    "ExitPlanMode",
    "Write",
    "Edit",
    "AskUserQuestion",
    "ToolSearch",
})


def config_plans_dir(env):
    """The active profile's plans/, from CLAUDE_CONFIG_DIR when it is set."""
    cfg = (env or {}).get("CLAUDE_CONFIG_DIR", "")
    if not cfg:
        return None
    return os.path.join(
        os.path.normpath(os.path.expanduser(cfg)), "plans"
    ) + os.sep


def is_profile_plans_dir(dir_path, home):
    """True for ~/.claude/plans and every ~/.claude-<profile>/plans."""
    parent, base = os.path.split(dir_path)
    if base != "plans":
        return False
    grandparent, profile = os.path.split(parent)
    if grandparent != home:
        return False
    return profile == ".claude" or profile.startswith(".claude-")


def is_plan_file(file_path, cwd, env=None, home=None):
    if not file_path:
        return False
    home = os.path.normpath(home or os.path.expanduser("~"))
    p = os.path.expanduser(file_path)
    if not os.path.isabs(p):
        p = os.path.join(cwd or os.getcwd(), p)
    p = os.path.normpath(p)
    active = config_plans_dir(env if env is not None else os.environ)
    if active and p.startswith(active):
        return True
    # A plan file sits directly in the plans dir, so its parent is that dir.
    return is_profile_plans_dir(os.path.dirname(p), home)


def decide(decision, reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    # A non-object payload has no fields to read; staying silent leaves the
    # call to the normal permission flow, where a crash would leave it
    # unguarded instead.
    if not isinstance(data, dict):
        return
    if data.get("permission_mode") != "plan":
        return
    tool = data.get("tool_name", "")
    if tool in ("Write", "Edit") and is_plan_file(
        (data.get("tool_input", {}) or {}).get("file_path", ""), data.get("cwd")
    ):
        decide("allow", "Writing the plan file is what plan mode is for.")
        return
    if tool in ALLOWED:
        return
    decide("deny", (
        f"Plan mode is transcribe-only and {tool} is blocked here -- "
        "every lookup, read and search happens BEFORE EnterPlanMode, "
        "because clearing context is what this mode is for. Write the "
        "already-drafted plan file and call ExitPlanMode now. If the "
        "research is genuinely missing, present what you have and let "
        "the user redirect."
    ))


def selftest():
    home = os.path.expanduser("~")
    none = {}
    assert is_plan_file(home + "/.claude/plans/eager-skipping-turtle.md", None, none)
    assert is_plan_file("~/.claude/plans/p.md", None, none)
    assert is_plan_file("plans/p.md", home + "/.claude", none)
    assert not is_plan_file(home + "/.claude/plans", None, none)  # the dir itself
    assert not is_plan_file(home + "/.claude/settings.json", None, none)
    assert not is_plan_file(home + "/.dotfiles/nix/flake.nix", None, none)
    assert not is_plan_file("", None, none)

    # Every `ccc <profile>` dir counts, with or without CLAUDE_CONFIG_DIR set.
    assert is_plan_file(home + "/.claude-personal/plans/p.md", None, none)
    assert is_plan_file(home + "/.claude-work/plans/p.md", None, none)
    profile = {"CLAUDE_CONFIG_DIR": home + "/.claude-personal"}
    assert is_plan_file(home + "/.claude-personal/plans/p.md", None, profile)
    assert is_plan_file("~/.claude-personal/plans/p.md", None, profile)
    # The default dir stays allowed while a profile is active.
    assert is_plan_file(home + "/.claude/plans/p.md", None, profile)
    # A profile dir outside $HOME is reachable only through the env var.
    elsewhere = {"CLAUDE_CONFIG_DIR": "/opt/claude-alt"}
    assert is_plan_file("/opt/claude-alt/plans/p.md", None, elsewhere)
    assert not is_plan_file("/opt/claude-alt/plans/p.md", None, none)
    # Neighbours of the plans dir, and lookalike dirs, stay out.
    assert not is_plan_file(home + "/.claude-personal/settings.json", None, none)
    assert not is_plan_file(home + "/.claude-personal/plans/sub/p.md", None, none)
    assert not is_plan_file(home + "/.claudex/plans/p.md", None, none)
    assert not is_plan_file(home + "/proj/.claude/plans/p.md", None, none)
    assert not is_plan_file(home + "/.claude/plans/../settings.json", None, none)
    assert config_plans_dir({}) is None
    assert config_plans_dir(None) is None
    # Only the plan write and the exit survive; every lookup is denied so the
    # context the handoff just dropped cannot be pulled back in.
    assert ALLOWED == {
        "ExitPlanMode", "Write", "Edit", "AskUserQuestion", "ToolSearch"
    }
    for denied in ("Read", "Grep", "Glob", "WebFetch", "WebSearch",
                   "NotebookRead", "TaskGet", "Bash", "Agent"):
        assert denied not in ALLOWED, denied
    print("plan-mode-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
