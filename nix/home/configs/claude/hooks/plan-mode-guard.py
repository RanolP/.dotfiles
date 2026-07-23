#!/usr/bin/env python3
"""Plan mode is distill-only: research happens BEFORE EnterPlanMode, so once
the session is in plan mode every tool except writing the plan file and
presenting it (ExitPlanMode) is denied. AskUserQuestion stays available for
requirement clarification, and ToolSearch for loading the deferred
ExitPlanMode schema -- without it a session already in plan mode could never
exit; neither is research.
"""

import json
import sys

ALLOWED = {"ExitPlanMode", "Write", "Edit", "AskUserQuestion", "ToolSearch"}


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    if data.get("permission_mode") != "plan":
        return
    tool = data.get("tool_name", "")
    if tool in ALLOWED:
        return
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                f"Plan mode is distill-only and {tool} is blocked here -- "
                "research happens BEFORE EnterPlanMode. Write the plan file "
                "and present it via ExitPlanMode now. If research is "
                "genuinely missing, present what you have and let the user "
                "redirect."
            ),
        }
    }))


if __name__ == "__main__":
    main()
