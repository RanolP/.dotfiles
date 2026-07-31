#!/usr/bin/env python3
"""UserPromptSubmit hint: restate the output-shape check next to generation.

The ADHD-shaped-output rule lives in AGENTS.md and loads once at session start,
thousands of tokens before the response that breaks it. That distance is the
whole failure: by the time the answer is written, attention sits on the tool
results, not on the manner spec. This hook restates the mechanically checkable
core at the END of the prompt, the point closest to generation. Plain
UserPromptSubmit stdout is model-visible context (same mechanism as
ask-mode-guard).

REMINDER stays one sentence on purpose. Every injected copy stays in the
transcript and is re-read as cache-read input by every later request, so the
cost grows with the SQUARE of the turn count -- injecting the full spec would
add hundreds of thousands of tokens to a marathon session. The full spec stays
in AGENTS.md; this is the check, not a replacement.

Self-check: `python3 output-shape-reminder.py --selftest`.
"""
import sys

REMINDER = (
    "Shape check before you send: lead with the outcome, cut every closer and "
    "trailing recap, end with one next action."
)

# Injection cost grows with turns^2, so a long reminder is a session-wide tax.
MAX_CHARS = 200


def main():
    try:
        sys.stdin.read()  # drain the hook payload; nothing here depends on it
    except OSError:
        pass
    print(REMINDER)
    sys.exit(0)


def selftest():
    assert len(REMINDER) <= MAX_CHARS, "reminder too long -- cost grows with turns^2"
    for check in ("outcome", "closer", "next action"):
        assert check in REMINDER, f"reminder dropped the {check!r} check"
    print("output-shape-reminder selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
