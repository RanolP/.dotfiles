#!/usr/bin/env python3
"""SessionStart hook: pick the session's delegation policy from its main model.

Two policies contradict each other by design. `## Architect mode` puts every
code mutation in a parallel worker and keeps the main thread on assessment,
which is right when the main model's own tokens are the expensive ones. `## Delegation threshold` makes
inline work the default until the task outgrows the thread, which is right
otherwise. Holding both in CLAUDE.md left a live conflict on the page and cost
every session -- and every subagent spawn -- the bytes of the one it ignores,
while CLAUDE.md had crossed the 40,000-char limit the harness warns about.

So both moved here and exactly one is emitted per session. The model is read from the
SessionStart payload, which per the hooks reference is the ONLY event that can
carry a `model` field -- and "it is not guaranteed to be present". When it is
missing, the transcript tail is read the way subagent-model-guard.py reads it
(last `assistant` entry's `message.model`), which covers resume/clear/compact
where a transcript already exists.

When BOTH sources come up empty the architect rules are emitted. The asymmetry
is deliberate: a Sonnet session that receives them over-delegates a few tasks,
while a Fable or Opus session that loses them grinds execution loops inline at
the priciest per-token rate in the fleet.

Self-check: `python3 architect-rules.py --selftest`.
"""
import json
import os
import sys

# Tail of the transcript to scan for the last assistant model, in bytes.
TRANSCRIPT_TAIL = 262144

# Main models whose own tokens are costly enough that delegation beats inline
# work. Matched as substrings of the model id, so `claude-opus-5[1m]` counts.
ARCHITECT_MODELS = ("fable", "opus")

RULES = """## Architect mode: the main thread talks, workers mutate
- Main thread assesses (read, diagnose, scope, plan, brief, decide); every code mutation runs in a background worker, keeping main context free of read-before-write traces.
- Spawn one worker per unit as it starts; send every unit with no unmet dependency in one message so they run in parallel; adopt each checked result as it lands.
- Route by tier label: `haiku` mechanical, `sonnet` well-scoped, `opus` deep -- for research, lookups, and edits needing this session's Claude-side context (model-facing prompt text); Fable only via `oracle`.
- Code from a settled plan goes to `codex-subagent:sol`, or `codex-subagent:luna` when slow-but-cheap fits, in the background. Codex sees none of this thread: the brief opens with `Budget: <N> min`, then `writable: /abs/workdir, /abs/other` listing every directory it writes (checked against the plan's files), then goal, files, constraints, plan decisions, verification commands, exact return shape.
- At the final gate (all units landed, before commit or push) spawn ONE `code-reviewer` on the combined diff; SendMessage each finding scored 70+ to the implementer owning those lines, re-review only changed lines, max 3 rounds, then report open findings to the user. When the user said push, fixes ship once type-check and lint pass, without re-review.
- Main keeps the plan file, memory/evidence files, and short read-only inspection (a couple of tool calls)."""

LAZY_RULES = """## Delegation threshold: work inline until the task outgrows the thread
- Work inline while one thread holds the task; a spawn re-sends the whole system prompt, so a needless one costs more tokens than it saves.
- Delegate once the task is too heavy for one thread: a large multi-file investigation, wide parallel steps, or execution whose trace would bloat main context.
- Tiny one-liners, uncertain scope, and active dialogue with the user stay inline."""


def payload_model(data):
    """Return the SessionStart payload's model as a lowercased string, or None.

    The field's shape is undocumented, so a bare string and an object carrying
    `id`/`display_name` are both accepted."""
    raw = data.get("model")
    if isinstance(raw, str):
        return raw.strip().lower() or None
    if isinstance(raw, dict):
        for key in ("id", "model", "display_name", "displayName"):
            val = raw.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip().lower()
    return None


def transcript_model(data):
    """Return the last assistant entry's model, lowercased, or None.

    Mirrors subagent-model-guard.py: only the tail is read, newest-first."""
    path = data.get("transcript_path")
    if not path:
        return None
    try:
        with open(path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            fh.seek(max(0, fh.tell() - TRANSCRIPT_TAIL))
            lines = fh.read().decode("utf-8", "replace").splitlines()
    except OSError:
        return None
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except ValueError:
            continue  # partial first line, or a non-JSON line
        if entry.get("type") != "assistant":
            continue
        model = (entry.get("message") or {}).get("model")
        if isinstance(model, str) and model.strip():
            return model.strip().lower()
    return None


def rules_for(data):
    """Return the delegation policy this session should receive."""
    model = payload_model(data) or transcript_model(data)
    if model is None or any(name in model for name in ARCHITECT_MODELS):
        return RULES
    return LAZY_RULES


def main():
    try:
        data = json.load(sys.stdin)
    except (ValueError, OSError):
        data = {}  # unreadable stdin -> unknown model -> inject
    if not isinstance(data, dict):
        data = {}
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": rules_for(data),
            }
        },
        sys.stdout,
    )


def selftest():
    def architect(data):
        return rules_for(data) is RULES

    assert architect({"model": "claude-fable-5"})
    assert architect({"model": "claude-fable-5[1m]"})
    assert architect({"model": {"id": "claude-fable-5", "display_name": "Fable"}})
    assert architect({"model": {"display_name": "Fable"}})
    assert architect({"model": "claude-opus-5"})
    assert architect({"model": "claude-opus-5[1m]"})
    assert architect({"model": {"id": "claude-opus-5", "display_name": "Opus"}})
    assert not architect({"model": "claude-sonnet-5"})
    assert not architect({"model": "Sonnet"})
    assert not architect({"model": {"id": "claude-haiku-4-5-20251001"}})
    # No model field and no transcript -> unknown -> the architect policy.
    assert architect({})
    assert architect({"model": "", "transcript_path": "/nonexistent/x.jsonl"})

    import tempfile

    with tempfile.TemporaryDirectory() as td:
        def transcript(name, model):
            path = os.path.join(td, name)
            with open(path, "w") as fh:
                fh.write('{"type":"user"}\n')
                fh.write(json.dumps({"type": "assistant", "message": {"model": model}}))
                fh.write("\n")
            return path

        assert architect({"transcript_path": transcript("f.jsonl", "claude-fable-5")})
        assert not architect(
            {"transcript_path": transcript("s.jsonl", "claude-sonnet-5")}
        )
        # The payload field wins over the transcript when both are present.
        assert not architect(
            {
                "model": "claude-sonnet-5",
                "transcript_path": transcript("f2.jsonl", "claude-fable-5"),
            }
        )
    # A transcript with no assistant entry falls back to unknown -> architect.
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        fh.write('{"type":"user"}\n')
        empty = fh.name
    try:
        assert architect({"transcript_path": empty})
    finally:
        os.unlink(empty)

    assert RULES.startswith("## Architect mode")
    assert LAZY_RULES.startswith("## Delegation threshold")
    print("architect-rules.py selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
