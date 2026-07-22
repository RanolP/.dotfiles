#!/usr/bin/env python3
"""PreToolUse guard: force-inject github-master per-command guides on gh usage.

Measured across all sessions, only 11% of `gh pr create` runs had loaded the
github-master skill first — the rest invented their own PR format instead of
filling the repo's PR template. Description-based skill triggering demonstrably
does not fire, so this hook enforces it at the tool layer:

- A MUTATING `gh pr ...` / `gh issue ...` command requires the matching guide
  (~/.agents/skills/github-master/guides/<group>.md) to have been injected into
  the CURRENT session within the last 3 hours.
- If not, the call is denied and the guide's full text is delivered in the deny
  reason (forced injection). The injection is recorded per session, so simply
  re-running the same command passes.
- Read-only verbs (list, view, status, diff, checks...) and every other gh
  subcommand pass untouched. Fail open on any internal error — this guard must
  never make gh unusable.
"""
import json
import os
import re
import signal
import sys
import time

signal.signal(signal.SIGALRM, lambda *_: sys.exit(0))
signal.alarm(5)
try:
    data = json.load(sys.stdin)
finally:
    signal.alarm(0)

cmd = data.get("tool_input", {}).get("command", "")
if not cmd or data.get("tool_name") not in (None, "Bash"):
    sys.exit(0)

TTL_SECONDS = 3 * 3600
MUTATING_VERBS = {
    "create", "edit", "comment", "close", "reopen", "merge",
    "ready", "review", "transfer", "delete", "lock", "unlock",
}
GUIDES_DIR = os.environ.get(
    "GH_GUARD_GUIDES_DIR",
    os.path.expanduser("~/.agents/skills/github-master/guides"),
)
STATE_DIR = os.path.expanduser("~/.claude-personal/state/gh-guard")

# `gh pr create ...`, also through env prefixes / chains. A quoted mention can
# false-positive; the cost is one extra injection, so precision loss is safe.
GH_RE = re.compile(r"(?:^|[\s;&|(])gh\s+(pr|issue)\s+([a-z-]+)")

needed = {
    group
    for group, verb in GH_RE.findall(cmd)
    if verb in MUTATING_VERBS
}
if not needed:
    sys.exit(0)


def decide(decision, reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


try:
    session_id = data.get("session_id") or "no-session"
    state_path = os.path.join(STATE_DIR, f"{session_id}.json")
    try:
        with open(state_path) as fh:
            state = json.load(fh)
        if not isinstance(state, dict):
            state = {}
    except (OSError, ValueError):
        state = {}

    now = time.time()
    stale = [g for g in sorted(needed) if now - state.get(g, 0) > TTL_SECONDS]
    if not stale:
        sys.exit(0)

    injected = []
    for group in stale:
        guide_path = os.path.join(GUIDES_DIR, f"{group}.md")
        try:
            with open(guide_path) as fh:
                injected.append(fh.read().strip())
            state[group] = now
        except OSError:
            # Guide not deployed (pre-rebuild or renamed): nothing to inject.
            continue

    if not injected:
        sys.exit(0)

    os.makedirs(STATE_DIR, exist_ok=True)
    with open(state_path, "w") as fh:
        json.dump(state, fh)

    decide(
        "deny",
        "[gh-guard] github-master guide injected — this session had not loaded "
        "it within 3h. Follow the guide below, then re-run your gh command; "
        "the re-run will pass.\n\n"
        + "\n\n---\n\n".join(injected),
    )
except SystemExit:
    raise
except Exception as e:
    print(f"[gh-guard] internal error, failing open: {e}", file=sys.stderr)
    sys.exit(0)
