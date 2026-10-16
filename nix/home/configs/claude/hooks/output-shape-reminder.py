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

Two more lines give the model what it cannot see on its own: the wall clock
with the previous turn's duration, so it notices a slow turn, and the machine's
load, so it weighs it before a heavy job. Both are read fresh on every prompt
because a figure read at session start is stale in minutes. Memory and running
processes are left for the model to query when the load reads high.

Self-check: `python3 output-shape-reminder.py --selftest`.
"""
import json
import os
import sys
from datetime import datetime

REMINDER = (
    "Shape check: end with the outcome, cut closers. If the user must act, say "
    "it and stop; if several paths are open, offer the choices; else state your "
    "next step in one line and continue."
)

# Injection cost grows with turns^2, so a long reminder is a session-wide tax.
MAX_CHARS = 200

# Tail of the transcript scanned for the previous turn's bounds, in bytes.
TRANSCRIPT_TAIL = 262144

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


def is_prompt(entry):
    """True for a user-typed prompt, False for a tool result or a meta entry."""
    if entry.get("type") != "user" or entry.get("isMeta"):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return True
    return (
        isinstance(content, list)
        and bool(content)
        and isinstance(content[0], dict)
        and content[0].get("type") == "text"
    )


def parse_ts(raw):
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def last_turn_seconds(path):
    """Wall time of the previous turn: its prompt to its last assistant entry.

    The hook fires before the new prompt is written, so the newest prompt in
    the transcript is the previous turn's."""
    if not path:
        return None
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - TRANSCRIPT_TAIL))
            lines = fh.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return None
    end = None
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if end is None and entry.get("type") == "assistant":
            end = parse_ts(entry.get("timestamp"))
        elif end is not None and is_prompt(entry):
            start = parse_ts(entry.get("timestamp"))
            return (end - start).total_seconds() if start else None
    return None


def clock_line(path):
    now = datetime.now().astimezone().strftime("%H:%M %Z")
    secs = last_turn_seconds(path)
    if secs is None or secs < 0:
        return f"Now {now}."
    mins, rest = divmod(int(secs), 60)
    return f"Now {now}; last turn took {mins}m{rest:02d}s."


def main():
    try:
        data = json.load(sys.stdin)
    except (ValueError, OSError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    print(REMINDER)
    print(clock_line(data.get("transcript_path")))
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

    import tempfile

    # A tool_result between prompt and answer must not be read as the prompt,
    # or the turn time collapses to the last tool call's gap.
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        for entry in (
            {"type": "user", "timestamp": "2026-10-16T05:00:00Z", "message": {"content": "go"}},
            {"type": "assistant", "timestamp": "2026-10-16T05:01:00Z"},
            {"type": "user", "timestamp": "2026-10-16T05:01:01Z",
             "message": {"content": [{"type": "tool_result"}]}},
            {"type": "assistant", "timestamp": "2026-10-16T05:03:05Z"},
        ):
            fh.write(json.dumps(entry) + "\n")
        sample = fh.name
    try:
        assert last_turn_seconds(sample) == 185, last_turn_seconds(sample)
        assert "last turn took 3m05s" in clock_line(sample)
    finally:
        os.unlink(sample)
    assert clock_line(None).startswith("Now ")
    print("output-shape-reminder selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
