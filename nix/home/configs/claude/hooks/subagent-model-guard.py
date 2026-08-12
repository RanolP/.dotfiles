#!/usr/bin/env python3
"""PreToolUse guard: force a deliberate model choice on every subagent spawn.

Problem: an Agent/Task call that omits `model` defaults to `inherit`, and the
main session runs opus -- so every un-annotated spawn silently runs opus. That
makes "judge how much intelligence each spawn needs" a matter of goodwill.

This hook makes the judgment non-optional. It DENIES a spawn that would fall
through to inherit-opus, forcing Claude to re-issue with an explicit tier. It
leaves alone the spawns where a deliberate choice already exists:

  * forks (subagent_type == "fork") -- inherit the parent model by design; the
    `model` param is ignored, so requiring one is meaningless.
  * named agents that pin a concrete `model:` in their own frontmatter -- the
    choice lives in the agent file, so an omitted param is fine, except a Fable
    pin is allowed only for the `oracle` agent.
  * namespaced plugin agents (type contains ":") -- their model lives in the
    plugin, which this hook cannot read; trust it rather than false-positive.

An explicit `fable` model is DENIED outright. A pinned Fable agent is allowed
only when its subagent_type is `oracle`. `opus` is denied too -- but only while
the main thread itself runs opus, where top-tier reasoning belongs in the main
thread. When the main thread runs Fable it is the architect, not the top tier,
so an opus subagent IS the implementer and is allowed. The main model is read
back from the transcript (PreToolUse stdin carries no model field).

Fail-open: any parse problem lets the normal permission flow run, so a bug here
never blocks legitimate work.
"""
import json
import os
import re
import sys

# Tier a subagent may never run, whatever the main thread is. Matched as a
# substring so alias and full id both hit (`fable`, `claude-fable-5`).
ALWAYS_BLOCKED = "fable"
# The only named agent allowed to pin Fable in frontmatter.
FABLE_AGENT = "oracle"
# Tier a subagent may run only under a Fable main thread (`opus`,
# `claude-opus-5`).
OPUS_TOKEN = "opus"
AGENTS_DIR = os.path.expanduser("~/.claude/agents")
# Matches a frontmatter `model:` line, capturing its value.
MODEL_LINE_RE = re.compile(r"^\s*model\s*:\s*(.+?)\s*$", re.MULTILINE)
# Tail of the transcript to scan for the last assistant model, in bytes.
TRANSCRIPT_TAIL = 32768

RUBRIC = (
    "Subagent spawned without an explicit `model` -- it would inherit the "
    "expensive main-thread model. Re-issue the Agent call with a deliberate "
    "tier:\n"
    "  - haiku  : mechanical work (fmt, lint, search, rename, file reads, "
    "pattern matching, data collection)\n"
    "  - sonnet : everything else (DEFAULT)\n"
    "Nothing above sonnet is allowed for subagents -- hard reasoning belongs "
    "in the main thread.\n"
    "Under a Fable main thread the tiers shift up: opus is the implementer / "
    "hard-reasoning tier, sonnet the default, haiku mechanical."
)

TIER_DENY = (
    "Subagents run sonnet or haiku only -- opus and fable are blocked. "
    "Re-issue with model: sonnet (or haiku for mechanical work); if the task "
    "truly needs top-tier reasoning, do it in the main thread."
)

FABLE_DENY = (
    "Fable subagents run only through the `oracle` agent. Re-issue with "
    "subagent_type: oracle, omit the model param, and pass one question plus "
    "enough context to judge."
)

PINNED_FABLE_DENY = (
    "Only the `oracle` agent may pin Fable in agent frontmatter. Use "
    "subagent_type: oracle with no model param, or choose opus, sonnet, or "
    "haiku for this agent."
)


def decide(decision, reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def pinned_model(agent_type):
    """Return the agent file's concrete `model:` value, or None if the file is
    absent or leaves the model to inherit."""
    path = os.path.join(AGENTS_DIR, agent_type + ".md")
    try:
        with open(path) as fh:
            head = fh.read(4096)
    except OSError:
        return None
    m = MODEL_LINE_RE.search(head)
    if not m:
        return None
    val = m.group(1).strip().strip("'\"").lower()
    return None if val in ("", "inherit") else val


def session_model(data):
    """Return the main thread's model, lowercased, or None if it can't be read.

    PreToolUse stdin carries no model field -- only SessionStart does -- so the
    model is recovered from the transcript: the last `assistant` entry's
    `message.model`. Only the tail is read; entries are scanned newest-first."""
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
        if model:
            return model.strip().lower()
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open

    ti = data.get("tool_input", {}) or {}
    agent_type = (ti.get("subagent_type") or "").strip()
    model = (ti.get("model") or "").strip().lower()

    # Forks inherit the parent by design -- the model param is ignored.
    if agent_type == "fork":
        sys.exit(0)

    if model:
        if ALWAYS_BLOCKED in model:
            decide("deny", FABLE_DENY)
        # Opus is the architect's implementer under Fable, and off-limits
        # otherwise. An unreadable main model reads as "not fable" -- fail-safe.
        if OPUS_TOKEN in model:
            main_model = session_model(data) or ""
            if ALWAYS_BLOCKED not in main_model:
                decide("deny", TIER_DENY)
        sys.exit(0)

    # No explicit model from here on. Namespaced plugin agents carry their own
    # model that this hook cannot read -- trust it.
    if ":" in agent_type:
        sys.exit(0)

    # A named user agent that pins a concrete model needs no param. Fable is
    # the only exception: it is allowed through oracle and nowhere else.
    pinned = pinned_model(agent_type) if agent_type else None
    if pinned:
        if ALWAYS_BLOCKED in pinned and agent_type != FABLE_AGENT:
            decide("deny", PINNED_FABLE_DENY)
        sys.exit(0)

    # Generic/built-in spawn with no model -> would inherit opus. Force a choice.
    decide("deny", RUBRIC)


def _selftest():
    """`python3 subagent-model-guard.py --selftest` -- fails loudly if the
    decision logic breaks. No frameworks, no fixtures."""
    import io
    import tempfile
    from contextlib import redirect_stdout

    def decision(ti, transcript=None):
        buf = io.StringIO()
        payload = {"tool_input": ti}
        if transcript:
            payload["transcript_path"] = transcript
        try:
            with redirect_stdout(buf):
                json_in = json.dumps(payload)
                sys.stdin = io.StringIO(json_in)
                main()
        except SystemExit:
            pass
        out = buf.getvalue().strip()
        try:
            return json.loads(out).get("hookSpecificOutput", {}).get(
                "permissionDecision"), out
        except ValueError:
            return None, out

    assert decision({"subagent_type": "general-purpose"})[0] == "deny"
    assert decision({})[0] == "deny"
    assert decision({"subagent_type": "fork"}) == (None, "")
    assert decision({"model": "sonnet"}) == (None, "")
    assert decision({"model": "haiku"}) == (None, "")
    # No transcript to read -> main model unknown -> both tiers stay blocked.
    for blocked in ("opus", "claude-opus-5"):
        d, o = decision({"model": blocked})
        assert d == "deny" and "sonnet or haiku only" in o, blocked
    for blocked in ("fable", "claude-fable-5"):
        d, o = decision({"model": blocked})
        assert d == "deny" and "only through the `oracle` agent" in o, blocked
    assert decision({"subagent_type": "x:y"}) == (None, "")

    def transcript(td, name, model):
        path = os.path.join(td, name)
        with open(path, "w") as f:
            f.write(json.dumps({"type": "user", "message": {}}) + "\n")
            f.write(json.dumps(
                {"type": "assistant", "message": {"model": model}}) + "\n")
        return path

    with tempfile.TemporaryDirectory() as td:
        as_fable = transcript(td, "fable.jsonl", "claude-fable-5")
        as_opus = transcript(td, "opus.jsonl", "claude-opus-5")
        missing = os.path.join(td, "nope.jsonl")
        # Fable main thread: opus is the implementer tier.
        for m in ("opus", "claude-opus-5"):
            assert decision({"model": m}, as_fable) == (None, ""), m
        # Opus main thread, and an unreadable transcript, keep the block.
        for path in (as_opus, missing):
            d, o = decision({"model": "opus"}, path)
            assert d == "deny" and "sonnet or haiku only" in o, path
        # Fable subagents stay denied whatever the main thread is.
        for path in (as_fable, as_opus, missing):
            d, o = decision({"model": "fable"}, path)
            assert d == "deny" and "only through the `oracle` agent" in o, path

    global AGENTS_DIR
    with tempfile.TemporaryDirectory() as td:
        AGENTS_DIR = td
        with open(os.path.join(td, "pinned.md"), "w") as f:
            f.write("---\nname: pinned\nmodel: haiku\n---\n")
        with open(os.path.join(td, "loose.md"), "w") as f:
            f.write("---\nname: loose\nmodel: inherit\n---\n")
        with open(os.path.join(td, "oracle.md"), "w") as f:
            f.write("---\nname: oracle\nmodel: fable\n---\n")
        with open(os.path.join(td, "other-fable.md"), "w") as f:
            f.write("---\nname: other-fable\nmodel: fable\n---\n")
        assert decision({"subagent_type": "pinned"}) == (None, "")
        assert decision({"subagent_type": "loose"})[0] == "deny"
        assert decision({"subagent_type": "oracle"}) == (None, "")
        d, o = decision({"subagent_type": "other-fable"})
        assert d == "deny" and "Only the `oracle` agent may pin Fable" in o
    print("all guard checks passed")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    else:
        main()
