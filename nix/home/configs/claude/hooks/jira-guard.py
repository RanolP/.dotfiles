#!/usr/bin/env python3
"""PreToolUse guard: force-inject the jira-master skill before any `jira edit`.

The Jira mechanics used to live in AGENTS.md, which every session and every
subagent spawn loads in full -- about 1.5KB of ADF workflow paid for on every
turn, in every repo, whether or not Jira comes up at all.

Description-based skill triggering is not a replacement: gh-guard.py measured
that only 11% of `gh pr create` runs had loaded github-master on their own. So
this hook copies that hook's shape exactly, for the one command that matters:

  `jira edit queue|apply|drop`  -> the jira-master skill must have been injected
      into THIS session within the last 3 hours. If it was not, the call is
      denied and the skill's full text is delivered in the deny reason. The
      injection is recorded per session, so re-running the same command passes.

Read-only verbs (`show`, `search`, `info`, `types`, `media ls`, `schema`,
`selfcheck`, and `edit status`) pass untouched -- a read costs nothing and
teaching the workflow before a read would deny work that is already correct.

The staged write is the right gate: `jira edit queue` is the first command that
can corrupt a card, and a markdown round-trip destroys an attached image
silently. Gating `apply` alone would be too late, because the queue is built by
then.

Fails open on every internal error -- a bug here must never make `jira`
unusable.

Self-check: `python3 jira-guard.py --selftest`.
"""
import json
import os
import re
import sys
import time

TTL_SECONDS = 3 * 3600
SKILL_PATH = os.environ.get(
    "JIRA_GUARD_SKILL",
    os.path.expanduser("~/.agents/skills/jira-master/SKILL.md"),
)
STATE_DIR = os.path.expanduser("~/.claude-personal/state/jira-guard")

# `jira edit queue ...`, also behind env prefixes, chains and subshells. A
# quoted mention can false-positive; the cost is one extra injection, so losing
# precision here is safe while losing recall is not.
JIRA_RE = re.compile(r"(?:^|[\s;&|(])jira\s+edit\s+([a-z-]+)")
MUTATING_SUBS = {"queue", "apply", "drop"}


def needs_guide(cmd):
    """True when this command stages, discards, or flushes a card edit."""
    return any(sub in MUTATING_SUBS for sub in JIRA_RE.findall(cmd))


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


def deny(reason):
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}


def handle(data, skill_path=None, state_dir=None, now=None):
    """Process one PreToolUse event; returns the payload to emit, or None."""
    if data.get("tool_name") not in (None, "Bash"):
        return None
    cmd = (data.get("tool_input") or {}).get("command", "")
    if not cmd or not needs_guide(cmd):
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
        pass

    return deny(
        "[jira-guard] jira-master skill injected -- this session had not loaded "
        "it within 3h. Follow it below, then re-run your jira command; the "
        "re-run will pass.\n\n" + skill)


def main():
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open
    try:
        payload = handle(data)
    except Exception as e:
        print(f"[jira-guard] internal error, failing open: {e}", file=sys.stderr)
        sys.exit(0)
    if payload:
        print(json.dumps(payload))
    sys.exit(0)


def selftest():
    import tempfile

    # Only the three mutating subcommands gate; every read passes.
    assert needs_guide("jira edit queue -i ABC-1 --set title")
    assert needs_guide("jira edit apply -i ABC-1")
    assert needs_guide("jira edit drop 2")
    assert needs_guide("cd /tmp && jira edit queue -i ABC-1")
    assert needs_guide("FOO=1 jira edit apply -i ABC-1")
    assert not needs_guide("jira edit status")
    assert not needs_guide("jira show -i ABC-1 --json")
    assert not needs_guide("jira info -i ABC-1")
    assert not needs_guide("jira search 'project = ABC'")
    assert not needs_guide("jira media ls -i ABC-1")

    tmp = tempfile.mkdtemp(prefix="jira-guard-selftest-")
    skill = os.path.join(tmp, "SKILL.md")
    with open(skill, "w") as fh:
        fh.write("# Jira master\nnever markdown\n")
    sdir = os.path.join(tmp, "state")

    def ev(cmd, sid="s1"):
        return {"tool_name": "Bash", "session_id": sid,
                "tool_input": {"command": cmd}}

    # First mutating call in a session is denied, carrying the whole skill.
    out = handle(ev("jira edit queue -i ABC-1"), skill, sdir, now=1000)
    hs = out["hookSpecificOutput"]
    assert hs["permissionDecision"] == "deny"
    assert "never markdown" in hs["permissionDecisionReason"]

    # The same session re-runs and passes -- that is the whole point.
    assert handle(ev("jira edit queue -i ABC-1"), skill, sdir, now=1001) is None
    assert handle(ev("jira edit apply -i ABC-1"), skill, sdir, now=1002) is None

    # A different session pays its own injection.
    assert handle(ev("jira edit apply -i ABC-1", sid="s2"), skill, sdir, now=1003)

    # Past the 3h TTL the same session is taught again.
    assert handle(ev("jira edit queue -i ABC-1"), skill, sdir, now=1000 + TTL_SECONDS + 1)

    # Reads never gate, whatever the state says.
    assert handle(ev("jira show -i ABC-1", sid="s3"), skill, sdir, now=2000) is None

    # A non-Bash tool and an undeployed skill both stay silent.
    assert handle({"tool_name": "Edit", "tool_input": {"command": "jira edit apply"}},
                  skill, sdir, now=3000) is None
    assert handle(ev("jira edit apply -i ABC-1", sid="s9"),
                  os.path.join(tmp, "missing.md"), sdir, now=3000) is None

    for dirpath, dirnames, filenames in os.walk(tmp, topdown=False):
        for n in filenames:
            os.remove(os.path.join(dirpath, n))
        for n in dirnames:
            os.rmdir(os.path.join(dirpath, n))
    os.rmdir(tmp)
    print("jira-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
