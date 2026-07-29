#!/usr/bin/env python3
"""Plan mode is distill-only: research happens BEFORE EnterPlanMode, so once
the session is in plan mode every tool except writing the plan file and
presenting it (ExitPlanMode) is denied. AskUserQuestion stays available for
requirement clarification, and ToolSearch for loading the deferred
ExitPlanMode schema -- without it a session already in plan mode could never
exit; neither is research.

A Write/Edit of the plan file itself (~/.claude/plans/) is auto-allowed rather
than merely permitted: distilling the plan is the ONE thing plan mode is for,
so prompting for it is pure friction. Any other Write/Edit still falls through
to the normal permission flow.

Self-check: `python3 plan-mode-guard.py --selftest`.
"""

import json
import os
import sys

ALLOWED = {"ExitPlanMode", "Write", "Edit", "AskUserQuestion", "ToolSearch"}
PLANS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "plans") + os.sep


def is_plan_file(file_path, cwd):
    if not file_path:
        return False
    p = os.path.expanduser(file_path)
    if not os.path.isabs(p):
        p = os.path.join(cwd or os.getcwd(), p)
    return os.path.normpath(p).startswith(PLANS_DIR)


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
        f"Plan mode is distill-only and {tool} is blocked here -- "
        "research happens BEFORE EnterPlanMode. Write the plan file "
        "and present it via ExitPlanMode now. If research is "
        "genuinely missing, present what you have and let the user "
        "redirect."
    ))


def selftest():
    home = os.path.expanduser("~")
    assert is_plan_file(home + "/.claude/plans/eager-skipping-turtle.md", None)
    assert is_plan_file("~/.claude/plans/p.md", None)
    assert is_plan_file("plans/p.md", home + "/.claude")
    assert not is_plan_file(home + "/.claude/plans", None)  # the dir itself
    assert not is_plan_file(home + "/.claude/settings.json", None)
    assert not is_plan_file(home + "/.dotfiles/nix/flake.nix", None)
    assert not is_plan_file("", None)
    print("plan-mode-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
