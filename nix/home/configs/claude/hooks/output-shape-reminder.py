#!/usr/bin/env python3
"""UserPromptSubmit hint: restate the output-shape check next to generation.

The ADHD-shaped-output rule lives in output-manner.md and loads once at session start,
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

A second line carries the machine's load, read fresh on every prompt, so the
judgment before a heavy job (an emulator, a native build) weighs it without a
`sysctl` tool call. Cheap work such as edits stays parallel whatever the load.
It is measured here because a figure read at session start is stale in minutes.

Self-check: `python3 output-shape-reminder.py --selftest`.
"""
import os
import sys

REMINDER = (
    "Shape check: end with the outcome, cut closers. If the user must act, say "
    "it and stop; if several paths are open, offer the choices; else state your "
    "next step in one line and continue."
)

# Injection cost grows with turns^2, so a long reminder is a session-wide tax.
MAX_CHARS = 200

# 1-minute load per core at or above this reads as "high": runnable work
# already exceeds what the cores clear, so another heavy job queues behind it.
HIGH_LOAD_PER_CORE = 0.8


def load_line():
    """Return the one-line load reading, or None where the OS exposes none."""
    try:
        one, _, _ = os.getloadavg()
    except OSError:
        return None
    cores = os.cpu_count() or 1
    level = "high" if one / cores >= HIGH_LOAD_PER_CORE else "normal"
    return f"Load: {one:.1f} on {cores} cores ({level}); weigh it before emulators or native builds."


def main():
    try:
        sys.stdin.read()  # drain the hook payload; nothing here depends on it
    except OSError:
        pass
    print(REMINDER)
    line = load_line()
    if line:
        print(line)
    sys.exit(0)


def selftest():
    assert len(REMINDER) <= MAX_CHARS, "reminder too long -- cost grows with turns^2"
    for check in ("outcome", "closer", "stop", "choices", "next step"):
        assert check in REMINDER, f"reminder dropped the {check!r} check"
    line = load_line()
    assert line is None or (line.startswith("Load: ") and len(line) <= 120), line
    print("output-shape-reminder selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
