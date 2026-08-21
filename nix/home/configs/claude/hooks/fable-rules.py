#!/usr/bin/env python3
"""SessionStart hook: load the Fable architect rules only in a Fable session.

The `## Fable = architect` section is 1.3KB of CLAUDE.md that every session and
every subagent spawn paid for, while its own first line reads `WHEN: this
session's main model is Fable`. In an Opus or Sonnet session it is dead weight,
and CLAUDE.md had crossed the 40,000-char limit the harness warns about.

So the section moved here and loads conditionally. The model is read from the
SessionStart payload, which per the hooks reference is the ONLY event that can
carry a `model` field -- and "it is not guaranteed to be present". When it is
missing, the transcript tail is read the way subagent-model-guard.py reads it
(last `assistant` entry's `message.model`), which covers resume/clear/compact
where a transcript already exists.

When BOTH sources come up empty the rules are emitted anyway. The asymmetry is
deliberate: a non-Fable session that receives them wastes 1.3KB on a section
whose WHEN line tells it to skip, while a Fable session that loses them loses
the cost discipline the section exists to enforce.

Self-check: `python3 fable-rules.py --selftest`.
"""
import json
import os
import sys

# Tail of the transcript to scan for the last assistant model, in bytes.
TRANSCRIPT_TAIL = 262144

RULES = """## Fable = architect: assess the state, delegate the change
- PURPOSE: spend as few Fable tokens as possible -- every rule below is a derivative of that goal, so when two of them seem to conflict, pick whichever burns less main-thread context
- WHEN: this session's main model is Fable (the statusline names it)
- DO: keep the main thread on assessment only -- read, diagnose, scope, brief, review the worker's result, decide; the thread's outputs are assessments, briefs, plans and decisions
- DO: put every code mutation inside a worker's turn -- route by tier: opus subagent (`Agent` with `model: opus`) for implementation and hard reasoning, sonnet for well-scoped edits and research, haiku for mechanical work
- DO (codex): `codex exec -o <outfile> "<self-contained brief>"` in the foreground when a second, outside implementer is wanted (gpt-5.5 / xhigh / workspace-write); codex sees none of this thread -- the brief carries goal, files, and the exact return shape, and the result is read back from `<outfile>`
- DO: invert the LAZY DEFAULT in `## Orchestrate via subagents` -- under Fable delegation IS the default and inline work is the exception; spawn one worker per unit of work rather than fanning out speculatively
- EXCEPT: the plan file, memory/evidence files, and read-only inspection stay the main thread's own work"""


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


def wants_rules(data):
    """True when the Fable rules should be injected into this session."""
    model = payload_model(data) or transcript_model(data)
    return model is None or "fable" in model


def main():
    try:
        data = json.load(sys.stdin)
    except (ValueError, OSError):
        data = {}  # unreadable stdin -> unknown model -> inject
    if not isinstance(data, dict):
        data = {}
    if not wants_rules(data):
        return
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": RULES,
            }
        },
        sys.stdout,
    )


def selftest():
    assert wants_rules({"model": "claude-fable-5"})
    assert wants_rules({"model": "claude-fable-5[1m]"})
    assert wants_rules({"model": {"id": "claude-fable-5", "display_name": "Fable"}})
    assert wants_rules({"model": {"display_name": "Fable"}})
    assert not wants_rules({"model": "claude-opus-5"})
    assert not wants_rules({"model": "Sonnet"})
    assert not wants_rules({"model": {"id": "claude-haiku-4-5-20251001"}})
    # No model field and no transcript -> unknown -> inject rather than lose them.
    assert wants_rules({})
    assert wants_rules({"model": "", "transcript_path": "/nonexistent/x.jsonl"})

    import tempfile

    with tempfile.TemporaryDirectory() as td:
        def transcript(name, model):
            path = os.path.join(td, name)
            with open(path, "w") as fh:
                fh.write('{"type":"user"}\n')
                fh.write(json.dumps({"type": "assistant", "message": {"model": model}}))
                fh.write("\n")
            return path

        assert wants_rules({"transcript_path": transcript("f.jsonl", "claude-fable-5")})
        assert not wants_rules(
            {"transcript_path": transcript("o.jsonl", "claude-opus-5")}
        )
        # The payload field wins over the transcript when both are present.
        assert not wants_rules(
            {
                "model": "claude-opus-5",
                "transcript_path": transcript("f2.jsonl", "claude-fable-5"),
            }
        )
    # A transcript with no assistant entry falls back to unknown -> inject.
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        fh.write('{"type":"user"}\n')
        empty = fh.name
    try:
        assert wants_rules({"transcript_path": empty})
    finally:
        os.unlink(empty)

    assert RULES.startswith("## Fable = architect")
    print("fable-rules.py selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
