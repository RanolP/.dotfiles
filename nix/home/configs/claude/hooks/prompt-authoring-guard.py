#!/usr/bin/env python3
"""PreToolUse hook: inject the prompt-authoring skill when behavior text is edited.

The authoring half of `## Lead with the action` -- write the DO sentence first,
keep a prohibition only when it carries its incident, cut one that restates its
DO backwards, leave migration notes to human docs -- used to sit in AGENTS.md,
which every session and every subagent spawn loads in full. It applies only when
a file a model reads as behavior is being written, which is a small fraction of
edits, and CLAUDE.md had crossed the 40,000-char limit the harness warns about.

The reading half stays in AGENTS.md on purpose: a prohibition can arrive in any
user message, with no tool call to hang a hook on. Only the authoring half has a
trigger, and this is it.

Description-based skill triggering is not a replacement: gh-guard.py measured
that only 11% of `gh pr create` runs had loaded github-master on their own.

Like orchestration-guard.py and unlike jira-guard.py, this hook does NOT deny.
The hooks reference allows `additionalContext` on PreToolUse, so the guidance
rides along with an edit that still happens and no round-trip is spent on a
denial. No `permissionDecision` is emitted, so claude-dir-edit-guard.py's deny
and the user's permission settings both stand untouched.

Injection is recorded per session with a 3h TTL, so editing twenty skill files
pays for the guidance once.

Fails open on every internal error -- a bug here must never block an edit.

Self-check: `python3 prompt-authoring-guard.py --selftest`.
"""
import json
import os
import sys
import time

TTL_SECONDS = 3 * 3600
SKILL_PATH = os.environ.get(
    "PROMPT_AUTHORING_GUARD_SKILL",
    os.path.expanduser("~/.agents/skills/prompt-authoring/SKILL.md"),
)
STATE_DIR = os.path.expanduser("~/.claude-personal/state/prompt-authoring-guard")
EDIT_TOOLS = ("Edit", "Write")
# Rules files whose whole purpose is to steer a model, wherever they sit.
BEHAVIOR_BASENAMES = ("SKILL.md", "AGENTS.md", "CLAUDE.md")

PREAMBLE = (
    "[prompt-authoring-guard] prompt-authoring skill injected -- this file is "
    "read by a model as behavior, and this session had not loaded the skill "
    "within 3h. Write each instruction in positive form; keep a prohibition "
    "only when it carries a fact its DO line cannot.\n\n"
)


def is_behavior_text(path):
    """True when the edited file is text a model reads as behavior.

    Matches by shape rather than by repo location, so the same rule applies to
    `~/.dotfiles/nix/home/configs/...` and to any project's own `.claude/`."""
    if not path:
        return False
    norm = path.replace("\\", "/")
    if os.path.basename(norm) in BEHAVIOR_BASENAMES:
        return True
    if not norm.endswith(".md"):
        return False
    parts = norm.split("/")
    # A reference page inside a skill, or an agent definition, steers a model
    # exactly as its SKILL.md does.
    return "skills" in parts or "agents" in parts


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
    if data.get("tool_name") not in EDIT_TOOLS:
        return None
    if not is_behavior_text((data.get("tool_input") or {}).get("file_path")):
        return None

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
        print(f"[prompt-authoring-guard] internal error, failing open: {e}",
              file=sys.stderr)
        sys.exit(0)
    if payload:
        print(json.dumps(payload))
    sys.exit(0)


def selftest():
    import tempfile

    # Behavior text, by basename or by containing directory.
    for path in (
        "/r/nix/home/configs/.agents/skills/git-master/SKILL.md",
        "/r/AGENTS.md",
        "/r/nix/home/configs/claude/CLAUDE.md",
        "/r/.claude/agents/code-reviewer.md",
        "/r/nix/home/configs/claude/agents/oracle.md",
        "/r/skills/github-master/guides/pr.md",
        r"C:\r\skills\foo\SKILL.md",
    ):
        assert is_behavior_text(path), path

    # Ordinary source, docs and data are not behavior text.
    for path in (
        "/r/src/main.py",
        "/r/docs/src/claude-code.md",
        "/r/README.md",
        "/r/nix/home/default.nix",
        "/r/skills/foo/config.json",
        "",
        None,
    ):
        assert not is_behavior_text(path), path

    with tempfile.TemporaryDirectory() as td:
        skill = os.path.join(td, "SKILL.md")
        with open(skill, "w") as fh:
            fh.write("# Prompt authoring\npositive form first\n")
        sdir = os.path.join(td, "state")

        def run(data, now=1000.0):
            return handle(data, skill_path=skill, state_dir=sdir, now=now)

        # Only an edit to behavior text triggers.
        assert run({"tool_name": "Bash", "session_id": "s1"}) is None
        assert run({"tool_name": "Write", "session_id": "s1",
                    "tool_input": {"file_path": "/r/src/main.py"}}) is None
        assert run({"tool_name": "Write", "session_id": "s1"}) is None

        out = run({"tool_name": "Write", "session_id": "s1",
                   "tool_input": {"file_path": "/r/skills/x/SKILL.md"}})
        assert out is not None
        hso = out["hookSpecificOutput"]
        assert hso["hookEventName"] == "PreToolUse"
        assert "positive form first" in hso["additionalContext"]
        # No verdict: claude-dir-edit-guard.py owns the deny decision on edits.
        assert "permissionDecision" not in hso, hso

        # Same session inside the TTL: taught once, not per file.
        assert run({"tool_name": "Edit", "session_id": "s1",
                    "tool_input": {"file_path": "/r/AGENTS.md"}}) is None
        # A different session gets its own injection.
        assert run({"tool_name": "Edit", "session_id": "s2",
                    "tool_input": {"file_path": "/r/AGENTS.md"}}) is not None
        # Past the TTL the same session is taught again.
        assert run({"tool_name": "Edit", "session_id": "s1",
                    "tool_input": {"file_path": "/r/AGENTS.md"}},
                   now=1000.0 + TTL_SECONDS + 1) is not None

        # An undeployed skill file injects nothing rather than an empty block.
        assert handle({"tool_name": "Write", "session_id": "s9",
                       "tool_input": {"file_path": "/r/AGENTS.md"}},
                      skill_path=os.path.join(td, "absent.md"),
                      state_dir=sdir) is None

    print("prompt-authoring-guard.py selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
