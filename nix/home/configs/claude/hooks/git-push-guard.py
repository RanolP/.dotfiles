#!/usr/bin/env python3
"""PreToolUse guard: allow `git push` only to claude/* branches, deny all else.

Static deny/allow glob rules cannot express "deny push EXCEPT claude/*" because
deny always wins over allow regardless of specificity. So the blanket
`Bash(git push*)` deny is removed from settings.json and this hook enforces the
policy at runtime instead.

Only the git `push` SUBCOMMAND is guarded -- the first non-option token after
`git` must be `push`. Commands like `git stash push` are a different subcommand
and are left alone.

Fail-safe: anything we cannot confidently prove targets claude/* exclusively is
denied. Some exotic push forms are therefore blocked by design.
"""
import json
import os
import re
import shlex
import sys

data = json.load(sys.stdin)
cmd = data.get("tool_input", {}).get("command", "")


def bypass_enabled(start):
    """True if a `.nanno-workers.json` with `"git_push_guard_bypass": true` sits
    at or above `start` (nearest wins). The file is globally gitignored, so it
    lives per-worktree and never gets committed. Fail-closed: a missing,
    unreadable, or malformed config never enables the bypass.
    """
    d = os.path.abspath(start or ".")
    while True:
        try:
            with open(os.path.join(d, ".nanno-workers.json")) as fh:
                cfg = json.load(fh)
            if isinstance(cfg, dict) and cfg.get("git_push_guard_bypass") is True:
                return True
        except (OSError, ValueError):
            pass
        parent = os.path.dirname(d)
        if parent == d:
            return False
        d = parent

# git global options that consume the following token as their argument.
GLOBAL_OPT_WITH_ARG = {"-C", "-c", "--namespace", "--git-dir", "--work-tree",
                       "--exec-path", "--config-env"}
ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
OPERATOR_RE = re.compile(r"&&|\|\||;|&|\|")
# Used only on segments shlex cannot parse: matches `git push` at the subcommand
# position (after optional env assignments, a path, and global options) so that
# `git stash push` and commit messages that merely mention git push do not trip.
PUSH_CMD_RE = re.compile(
    r"^\s*(?:[A-Za-z_]\w*=\S+\s+)*(?:\S*/)?git\s+"
    r"(?:--?\w[\w-]*(?:=\S+)?\s+|-[cC]\s+\S+\s+)*push(?:\s|$)"
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


def git_subcommand(toks):
    """Return (subcommand, index) for a git invocation, else (None, None).

    Skips leading `VAR=val` env assignments and any git global options so that
    `git -C path push` resolves to `push`, while `git stash push` resolves to
    `stash`.
    """
    i = 0
    while i < len(toks) and ENV_ASSIGN_RE.match(toks[i]):
        i += 1
    if i >= len(toks) or toks[i].rsplit("/", 1)[-1] != "git":
        return None, None
    i += 1
    while i < len(toks):
        t = toks[i]
        if t in GLOBAL_OPT_WITH_ARG:
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        return t, i
    return None, None


# Split on shell operators so a push hidden in a compound command is still seen,
# and so `git stash push && git push ...` is judged per segment.
segments_raw = OPERATOR_RE.split(cmd)
is_compound = len(segments_raw) > 1

push_segments = []
for seg in segments_raw:
    try:
        toks = shlex.split(seg)
    except ValueError:
        if PUSH_CMD_RE.match(seg):
            decide("deny", "Push blocked: command could not be parsed safely.")
        continue
    sub, idx = git_subcommand(toks)
    if sub == "push":
        push_segments.append((toks, idx))

# No git push subcommand anywhere -> no opinion, let normal permission flow run.
if not push_segments:
    sys.exit(0)

# Escape hatch: a .nanno-workers.json opting in bypasses every push restriction.
if bypass_enabled(data.get("cwd") or os.getcwd()):
    decide("allow", "Push guard bypassed via .nanno-workers.json (git_push_guard_bypass).")

# A push mixed into a compound command is hard to reason about.
if is_compound:
    decide("deny", "Run git push as a standalone command (no &&/||/;/| chaining).")

toks, idx = push_segments[0]
args = toks[idx + 1:]
positionals = [t for t in args if not t.startswith("-")]

if not positionals:
    decide("deny", "Bare 'git push' targets the current upstream; specify origin claude/<branch>.")

# Standard form: git push <remote> <refspec...>
refspecs = positionals[1:]
if not refspecs:
    decide("deny", "Specify an explicit claude/<branch> refspec to push.")


def dest(refspec):
    return refspec.split(":", 1)[1] if ":" in refspec else refspec


bad = [r for r in refspecs if not dest(r).startswith("claude/")]
if bad:
    decide("deny", "Only claude/* branches may be pushed. Offending refspec(s): " + ", ".join(bad))

decide("allow", "Push to claude/* branch permitted.")
