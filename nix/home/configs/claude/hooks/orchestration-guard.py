#!/usr/bin/env python3
"""PreToolUse hook: inject the subagent-orchestration skill at the first spawn.

The model tiers, the brief contents, the `fork` caveat, the oracle escalation
and the typed-handoff rules used to sit in CLAUDE.md, which every session and
every subagent spawn loads in full -- about 1.5KB paid for on every turn, in
every repo, whether or not anything was ever delegated. CLAUDE.md had crossed
the 40,000-char limit the harness warns about.

Description-based skill triggering is not a replacement: gh-guard.py measured
that only 11% of `gh pr create` runs had loaded github-master on their own. So
the mechanics moved into the skill and this hook delivers them at the exact
call that needs them -- the session's first `Agent`/`Task`.

Unlike jira-guard.py, this hook does NOT deny. The hooks reference allows
`additionalContext` on PreToolUse, so the skill rides along with a call that
still executes, and no round-trip is spent on a denial. That is the right shape
here because the typed-handoff rules govern how the RESULT is consumed, which
happens after the call returns -- there is nothing to re-issue. The verdict on
the call itself stays subagent-model-guard.py's job; no `permissionDecision` is
emitted here, so that hook's deny and the user's permission settings both stand
untouched.

Injection is recorded per session with a 3h TTL, so a fan-out of ten workers
pays for the skill once.

Spawns from INSIDE a subagent are skipped: a worker that is itself delegating
does not need the main thread's routing rules, and `agent_id` marks that case.

Fails open on every internal error -- a bug here must never block a spawn.

Self-check: `python3 orchestration-guard.py --selftest`.
"""
import json
import os
import sys
import time

TTL_SECONDS = 3 * 3600
SKILL_PATH = os.environ.get(
    "ORCHESTRATION_GUARD_SKILL",
    os.path.expanduser("~/.agents/skills/subagent-orchestration/SKILL.md"),
)
STATE_DIR = os.path.expanduser("~/.claude-personal/state/orchestration-guard")
SPAWN_TOOLS = ("Agent", "Task")

PREAMBLE = (
    "[orchestration-guard] subagent-orchestration skill injected -- this "
    "session had not loaded it within 3h. It carries the model tiers, the "
    "brief contents, the `fork` cost, the oracle escalation and the "
    "typed-handoff rules. Apply it to this spawn and to how you consume its "
    "result.\n\n"
)


def load_state(path):
    try:
        with open(path) as fh:
            st = json.load(fh)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


def read_skill(path):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return ""  # not deployed yet (pre-rebuild): nothing to inject


def context(text):
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": text,
    }}


def handle(data, skill_path=None, state_dir=None, now=None):
    """Process one PreToolUse event; returns the payload to emit, or None."""
    if data.get("tool_name") not in SPAWN_TOOLS:
        return None
    if data.get("agent_id"):
        return None  # a subagent delegating onward: not the main thread's call

    now = time.time() if now is None else now
    sdir = state_dir or STATE_DIR
    state_path = os.path.join(sdir, f"{data.get('session_id') or 'no-session'}.json")
    state = load_state(state_path)
    last = state.get("injected") or 0
    if last and now - last <= TTL_SECONDS:
        return None

    skill = read_skill(skill_path or SKILL_PATH)
    if not skill:
        return None

    state["injected"] = now
    try:
        os.makedirs(sdir, exist_ok=True)
        with open(state_path, "w") as fh:
            json.dump(state, fh)
    except OSError:
        pass  # an unwritable state dir costs a re-injection, never a block

    return context(PREAMBLE + skill)


def main():
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open
    if not isinstance(data, dict):
        sys.exit(0)
    try:
        payload = handle(data)
    except Exception as e:
        print(f"[orchestration-guard] internal error, failing open: {e}",
              file=sys.stderr)
        sys.exit(0)
    if payload:
        print(json.dumps(payload))
    sys.exit(0)


def selftest():
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        skill = os.path.join(td, "SKILL.md")
        with open(skill, "w") as fh:
            fh.write("# Subagent orchestration\nrules here\n")
        sdir = os.path.join(td, "state")

        def run(data, now=1000.0):
            return handle(data, skill_path=skill, state_dir=sdir, now=now)

        # Only a spawn triggers; every other tool passes untouched.
        assert run({"tool_name": "Bash", "session_id": "s1"}) is None
        assert run({"tool_name": "Edit", "session_id": "s1"}) is None
        assert run({"session_id": "s1"}) is None

        out = run({"tool_name": "Agent", "session_id": "s1"})
        assert out is not None
        hso = out["hookSpecificOutput"]
        assert hso["hookEventName"] == "PreToolUse"
        assert "rules here" in hso["additionalContext"]
        # No verdict is emitted: subagent-model-guard.py owns that decision.
        assert "permissionDecision" not in hso, hso

        # Same session inside the TTL: injected once, not per worker.
        assert run({"tool_name": "Agent", "session_id": "s1"}) is None
        assert run({"tool_name": "Task", "session_id": "s1"}) is None
        # A different session gets its own injection.
        assert run({"tool_name": "Agent", "session_id": "s2"}) is not None
        # Past the TTL the same session is taught again.
        assert run({"tool_name": "Agent", "session_id": "s1"},
                   now=1000.0 + TTL_SECONDS + 1) is not None

        # A spawn from inside a subagent is not the main thread's routing call.
        assert run({"tool_name": "Agent", "session_id": "s3",
                    "agent_id": "a1"}) is None

        # An undeployed skill file injects nothing rather than an empty block.
        assert handle({"tool_name": "Agent", "session_id": "s9"},
                      skill_path=os.path.join(td, "absent.md"),
                      state_dir=sdir) is None

    print("orchestration-guard.py selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
