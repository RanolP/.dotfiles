#!/usr/bin/env python3
"""UserPromptSubmit nudge: order /handoff once a thread's context runs out of room.

WHY A HOOK AND NOT A RULE: an audit of 907 transcripts over 21 days found the
`handoff` skill never fails once it runs -- 17 of 17 invocations completed
EnterPlanMode -> plan write -> ExitPlanMode. The loss is that it almost never
runs on its own: every one of those 17 was a user-typed `/handoff`, zero were
model-initiated, while 466 `compact_boundary` events fired across 126 sessions.
Compaction was doing 27x the work handoff exists to do.

WHY CONTEXT SIZE AND NOT TURN COUNT: the same audit measured context size at the
moment handoff was invoked -- median 139,250 tokens, against an observed
auto-compaction trigger of ~167,000-172,000. The skill is not invoked too rarely
in TURNS; it is invoked with ~30k of headroom left, which is why 5 of 17
episodes had a compaction land inside the handoff itself. A turn count does not
see that; the resident context does, and it is the quantity that actually
decides whether the handoff completes.

A topic boundary stays unobservable from a hook. CLAUDE.md keeps the topic
boundary primary; this fires the floor underneath it, late enough that a nudge
means real pressure and early enough that the handoff still fits.

COST CONSTRAINT (non-negotiable): an injected line stays resident and is re-read
as cache-read input by every later request in the same compaction segment, and
this hook fires only in the long threads where that segment is most expensive.
So the message is at most MAX_CHARS characters and fires at most once per band,
never every turn.

PERFORMANCE: these transcripts reach tens of MB and this runs on every user
prompt, so the file is never read whole -- only the last TAIL_BYTES, scanned
backwards for the newest usage record. State is keyed on transcript_path
because `session_id` is NOT stable across a conversation (the lesson
rebuild-enforcer.py records).

FAIL-OPEN everywhere: any exception exits 0 silently with no output. A crash in
here must never block a prompt or annoy the user.

Self-check: `python3 handoff-nudge.py --selftest`.
"""
import json
import os
import sys

# Observed auto-compaction trigger is ~167k-172k tokens. Handing off costs the
# gathering plus the plan-mode dance, so the first nudge leaves roughly 60k of
# headroom. BAND re-fires as the thread keeps growing past it (110k, 140k, 170k)
# rather than nagging every turn.
FIRST_THRESHOLD = 110_000
BAND = 30_000

MESSAGE = (
    "Run /handoff now -- this thread holds ~{k}k tokens and auto-compaction "
    "fires near 170k, so the handoff has to happen before then. Skip only if "
    "the active plan says Chainable: false."
)

# The nudge is resident for the rest of the compaction segment it lands in.
MAX_CHARS = 220

# Enough tail to hold the newest assistant record even after a long tool result.
TAIL_BYTES = 512 * 1024


def state_path():
    """Resolved at call time so a test can redirect TMPDIR."""
    return os.path.join(os.environ.get("TMPDIR") or "/tmp",
                        "claude-handoff-nudge.json")


def load_state():
    try:
        with open(state_path()) as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        return {}
    if not isinstance(state, dict):
        return {}
    # Drop records for transcripts that no longer exist, so the file stays small.
    return {k: v for k, v in state.items()
            if isinstance(v, dict) and isinstance(k, str) and os.path.exists(k)}


def save_state(state):
    try:
        with open(state_path(), "w") as fh:
            json.dump(state, fh)
    except OSError:
        pass  # fail open: an unwritable state file only costs a rescan


def usage_tokens(entry):
    """Resident context of one assistant request, or None.

    Everything the model was sent is billed as input, split across three
    counters depending on cache state, so the context size is their sum.
    """
    message = entry.get("message")
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    total = 0
    seen = False
    for key in ("input_tokens", "cache_read_input_tokens",
                "cache_creation_input_tokens"):
        value = usage.get(key)
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            continue
        total += value
        seen = True
    return total if seen else None


def context_size(path):
    """Tokens resident in the newest main-thread assistant request, or None.

    Reads only the tail. The first line of the chunk may be a fragment, so it is
    dropped unless the read started at byte 0. Records are walked newest-first
    and the first usable one wins -- a compaction resets the size, and the
    newest record is the only one that reflects that.
    """
    size = os.path.getsize(path)
    start = max(0, size - TAIL_BYTES)
    with open(path, "rb") as fh:
        fh.seek(start)
        chunk = fh.read()
    lines = chunk.decode("utf-8", "replace").splitlines()
    if start > 0 and lines:
        lines = lines[1:]
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if entry.get("type") != "assistant" or entry.get("isSidechain"):
            continue
        tokens = usage_tokens(entry)
        if tokens:
            return tokens
    return None


def nudge_for(data):
    """Return the message to inject, or None."""
    path = data.get("transcript_path")
    if not isinstance(path, str) or not path or not os.path.exists(path):
        return None
    tokens = context_size(path)
    if not tokens or tokens < FIRST_THRESHOLD:
        return None
    # Which band this size has reached. A jump across two bands still fires once.
    band = FIRST_THRESHOLD + ((tokens - FIRST_THRESHOLD) // BAND) * BAND
    state = load_state()
    record = state.get(path) or {}
    last = record.get("last_band") or 0
    if not isinstance(last, int) or isinstance(last, bool):
        last = 0
    if band <= last:
        return None
    state[path] = {"last_band": band}
    save_state(state)
    return MESSAGE.format(k=round(tokens / 1000))


def main():
    try:
        raw = sys.stdin.read()
    except (OSError, ValueError):
        sys.exit(0)
    try:
        data = json.loads(raw)
    except ValueError:
        sys.exit(0)
    if not isinstance(data, dict):
        sys.exit(0)
    try:
        message = nudge_for(data)
    except Exception:
        sys.exit(0)
    if message:
        print(message)
    sys.exit(0)


def selftest():
    import tempfile

    assert len(MESSAGE.format(k=8888)) <= MAX_CHARS, \
        "nudge too long -- it stays resident for the whole compaction segment"
    assert "/handoff" in MESSAGE and "Chainable: false" in MESSAGE

    with tempfile.TemporaryDirectory() as td:
        os.environ["TMPDIR"] = td
        path = os.path.join(td, "t.jsonl")

        def append(tokens, sidechain=False, usage=True):
            entry = {"type": "assistant", "isSidechain": sidechain,
                     "message": {"usage": {
                         "input_tokens": 0,
                         "cache_read_input_tokens": tokens,
                         "cache_creation_input_tokens": 0}} if usage else {}}
            with open(path, "a") as fh:
                fh.write(json.dumps(entry) + "\n")

        # No transcript_path, and a missing file: silent.
        assert nudge_for({}) is None
        assert nudge_for({"transcript_path": os.path.join(td, "gone.jsonl")}) is None

        # An empty transcript, and one with no usage record: silent.
        open(path, "w").close()
        assert nudge_for({"transcript_path": path}) is None
        append(0, usage=False)
        assert nudge_for({"transcript_path": path}) is None

        # Below the threshold.
        append(FIRST_THRESHOLD - 1)
        assert nudge_for({"transcript_path": path}) is None

        # At the threshold: fires, naming the size in thousands.
        append(FIRST_THRESHOLD)
        msg = nudge_for({"transcript_path": path})
        assert msg and "110k" in msg, msg

        # Still inside the same band: does not re-fire.
        append(FIRST_THRESHOLD + BAND - 1)
        assert nudge_for({"transcript_path": path}) is None

        # The next band fires again.
        append(FIRST_THRESHOLD + BAND)
        msg = nudge_for({"transcript_path": path})
        assert msg and "140k" in msg, msg

        # A sidechain record is not the main thread, so the band does not move.
        append(FIRST_THRESHOLD + 5 * BAND, sidechain=True)
        assert nudge_for({"transcript_path": path}) is None

        # The NEWEST record wins: a compaction drops the size and silences it.
        append(20_000)
        assert nudge_for({"transcript_path": path}) is None

        # Growing back past an already-fired band stays silent; a new one fires.
        append(FIRST_THRESHOLD + BAND)
        assert nudge_for({"transcript_path": path}) is None
        append(FIRST_THRESHOLD + 2 * BAND)
        msg = nudge_for({"transcript_path": path})
        assert msg and "170k" in msg, msg

        # A partial trailing line is skipped, and the record before it is used.
        with open(path, "a") as fh:
            fh.write('{"type":"assistant","isSidechain":false')
        assert nudge_for({"transcript_path": path}) is None

        # A record for a vanished transcript is dropped from the state file.
        os.unlink(path)
        assert path not in load_state()

    print("handoff-nudge.py selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
