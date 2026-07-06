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
    choice lives in the agent file, so an omitted param is fine.
  * namespaced plugin agents (type contains ":") -- their model lives in the
    plugin, which this hook cannot read; trust it rather than false-positive.

When an explicit model IS given and it is opus, the spawn is allowed but a
non-blocking reminder asks Claude to confirm the escalation is warranted.

Fail-open: any parse problem lets the normal permission flow run, so a bug here
never blocks legitimate work.
"""
import json
import os
import re
import sys

OPUS_TOKENS = ("opus",)  # alias or full id like claude-opus-4-8
AGENTS_DIR = os.path.expanduser("~/.claude/agents")
# Matches a frontmatter `model:` line, capturing its value.
MODEL_LINE_RE = re.compile(r"^\s*model\s*:\s*(.+?)\s*$", re.MULTILINE)

RUBRIC = (
    "Subagent spawned without an explicit `model` -- it would inherit opus. "
    "Re-issue the Agent call with a deliberate tier:\n"
    "  - haiku  : mechanical work (fmt, lint, search, rename, file reads, "
    "pattern matching)\n"
    "  - sonnet : standard implementation / structured research (DEFAULT)\n"
    "  - opus   : only when you can NAME the hard reasoning (novel design, "
    "multi-file root-cause debugging, subtle correctness). Cannot name why "
    "sonnet fails? Use sonnet."
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
        if any(tok in model for tok in OPUS_TOKENS):
            # Explicit opus is allowed, but nudge Claude to confirm the tier.
            print("opus subagent requested -- confirm this needs deep "
                  "reasoning; if you cannot name why sonnet would fail, "
                  "downgrade to sonnet.")
        sys.exit(0)

    # No explicit model from here on. Namespaced plugin agents carry their own
    # model that this hook cannot read -- trust it.
    if ":" in agent_type:
        sys.exit(0)

    # A named user agent that pins a concrete model needs no param.
    if agent_type and pinned_model(agent_type):
        sys.exit(0)

    # Generic/built-in spawn with no model -> would inherit opus. Force a choice.
    decide("deny", RUBRIC)


def _selftest():
    """`python3 subagent-model-guard.py --selftest` -- fails loudly if the
    decision logic breaks. No frameworks, no fixtures."""
    import io
    import tempfile
    from contextlib import redirect_stdout

    def decision(ti):
        buf = io.StringIO()
        try:
            with redirect_stdout(buf):
                json_in = json.dumps({"tool_input": ti})
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
    d, o = decision({"model": "opus"})
    assert d is None and "opus" in o
    assert decision({"subagent_type": "x:y"}) == (None, "")

    global AGENTS_DIR
    with tempfile.TemporaryDirectory() as td:
        AGENTS_DIR = td
        with open(os.path.join(td, "pinned.md"), "w") as f:
            f.write("---\nname: pinned\nmodel: haiku\n---\n")
        with open(os.path.join(td, "loose.md"), "w") as f:
            f.write("---\nname: loose\nmodel: inherit\n---\n")
        assert decision({"subagent_type": "pinned"}) == (None, "")
        assert decision({"subagent_type": "loose"})[0] == "deny"
    print("all guard checks passed")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    else:
        main()
