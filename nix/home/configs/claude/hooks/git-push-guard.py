#!/usr/bin/env python3
"""PreToolUse guard: allow `git push` only to claude/* branches, deny all else.

Static deny/allow glob rules cannot express "deny push EXCEPT claude/*" because
deny always wins over allow regardless of specificity. So the blanket
`Bash(git push*)` deny is removed from settings.json and this hook enforces the
policy at runtime instead.

Fail-safe: anything we cannot confidently prove targets claude/* exclusively is
denied. Some exotic push forms are therefore blocked by design.
"""
import json
import re
import shlex
import sys

data = json.load(sys.stdin)
cmd = data.get("tool_input", {}).get("command", "")


def decide(decision, reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


# Not a git push -> no opinion, let normal permission flow handle it.
if not re.search(r"\bgit\b.*\bpush\b", cmd):
    sys.exit(0)

# Conservative: a push mixed into a compound command is hard to reason about.
if re.search(r"&&|\|\||;|\|", cmd):
    decide("deny", "Run git push as a standalone command (no &&/||/;/| chaining).")

try:
    toks = shlex.split(cmd)
except ValueError:
    decide("deny", "Push blocked: command could not be parsed safely.")

try:
    i = toks.index("push")
except ValueError:
    sys.exit(0)

args = toks[i + 1:]
positionals = [t for t in args if not t.startswith("-")]

if not positionals:
    decide("deny", "Bare 'git push' targets the current upstream; specify origin claude/<branch>.")

# Standard form: git push <remote> <refspec...>
refspecs = positionals[1:]
if not refspecs:
    decide("deny", "Specify an explicit claude/<branch> refspec to push.")


def dest(refspec):
    return refspec.split(":", 1)[1] if ":" in refspec else refspec


bad = [r for r in refspecs if not dest(r).startswith("claude/")]
if bad:
    decide("deny", "Only claude/* branches may be pushed. Offending refspec(s): " + ", ".join(bad))

decide("allow", "Push to claude/* branch permitted.")
