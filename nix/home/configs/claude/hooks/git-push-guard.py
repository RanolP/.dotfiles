#!/usr/bin/env python3
"""PreToolUse guard: allow `git push` only to claude/* branches, deny all else.

Static deny/allow glob rules cannot express "deny push EXCEPT claude/*" because
deny always wins over allow regardless of specificity. So the blanket
`Bash(git push*)` deny is removed from settings.json and this hook enforces the
policy at runtime instead.

Only the git `push` SUBCOMMAND is guarded -- the first non-option token after
`git` must be `push`. Commands like `git stash push` are a different subcommand
and are left alone.

Parsing is a single-pass, O(n) shell-ish tokenizer (see `parse_segments`). It is
quote-aware, so an operator inside quotes (e.g. the `|` in `"$(a | b)"`) never
splits a segment, and it never backtracks -- an earlier regex-based version
(`OPERATOR_RE` split + `PUSH_CMD_RE` fallback) could ReDoS for minutes on long
commands whose quoted text contained a shell operator, hanging every Bash call.

Fail-safe: anything we cannot confidently prove targets claude/* exclusively is
denied. Some exotic push forms are therefore blocked by design.
"""
import json
import os
import signal
import sys

# A per-call PreToolUse hook must never be able to hang the Bash tool. If the
# harness ever stalls delivering/closing the stdin payload, json.load would
# block until the 2-minute tool timeout; bound the read and fail open (let the
# normal permission flow decide) instead of hanging.
signal.signal(signal.SIGALRM, lambda *_: sys.exit(0))
signal.alarm(5)
try:
    data = json.load(sys.stdin)
finally:
    signal.alarm(0)
cmd = data.get("tool_input", {}).get("command", "")

# git global options that consume the following token as their argument.
GLOBAL_OPT_WITH_ARG = {"-C", "-c", "--namespace", "--git-dir", "--work-tree",
                       "--exec-path", "--config-env"}


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


def decide(decision, reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def _is_name_char(ch):
    return ch == "_" or ("a" <= ch <= "z") or ("A" <= ch <= "Z") or ("0" <= ch <= "9")


def is_env_assign(tok):
    """True for a leading `NAME=value` shell env assignment (ASCII NAME)."""
    eq = tok.find("=")
    if eq <= 0:
        return False
    first = tok[0]
    if not (first == "_" or ("a" <= first <= "z") or ("A" <= first <= "Z")):
        return False
    return all(_is_name_char(c) for c in tok[:eq])


def parse_segments(command):
    """Single-pass, O(n) split of a shell command into operator-separated
    segments of whitespace-separated tokens.

    Walks the string once, tracking quote/backslash state so the control
    operators `&& || ; & |` split a segment ONLY when they appear outside
    quotes. Quote characters are consumed (tokens hold the unquoted value, like
    `shlex.split`). Never backtracks, so it cannot ReDoS.

    Returns (segments, is_compound) where each segment is a dict
    {"tokens": [...], "parse_error": bool}; parse_error marks an unterminated
    quote so the caller can fail safe.
    """
    segments = []
    tokens = []
    tok = []
    tok_started = False
    seg_error = False
    op_seen = False

    def flush_token():
        nonlocal tok, tok_started
        if tok_started:
            tokens.append("".join(tok))
        tok = []
        tok_started = False

    def flush_segment():
        nonlocal tokens, seg_error
        flush_token()
        segments.append({"tokens": tokens, "parse_error": seg_error})
        tokens = []
        seg_error = False

    i, n = 0, len(command)
    while i < n:
        c = command[i]
        if c == "'":
            tok_started = True
            i += 1
            while i < n and command[i] != "'":
                tok.append(command[i])
                i += 1
            if i >= n:
                seg_error = True  # unterminated single quote
            else:
                i += 1  # closing '
            continue
        if c == '"':
            tok_started = True
            i += 1
            while i < n and command[i] != '"':
                if command[i] == "\\" and i + 1 < n and command[i + 1] in ('"', "\\", "$", "`"):
                    tok.append(command[i + 1])
                    i += 2
                else:
                    tok.append(command[i])
                    i += 1
            if i >= n:
                seg_error = True  # unterminated double quote
            else:
                i += 1  # closing "
            continue
        if c == "\\":
            tok_started = True
            if i + 1 < n:
                tok.append(command[i + 1])
                i += 2
            else:
                tok.append(c)
                i += 1
            continue
        if c in " \t\n\r":
            flush_token()
            i += 1
            continue
        if command[i:i + 2] in ("&&", "||"):
            op_seen = True
            flush_segment()
            i += 2
            continue
        if c in (";", "&", "|"):
            op_seen = True
            flush_segment()
            i += 1
            continue
        tok_started = True
        tok.append(c)
        i += 1

    flush_segment()
    return segments, op_seen


def git_subcommand(toks):
    """Return (subcommand, index) for a git invocation, else (None, None).

    Skips leading `VAR=val` env assignments and any git global options so that
    `git -C path push` resolves to `push`, while `git stash push` resolves to
    `stash`.
    """
    i = 0
    while i < len(toks) and is_env_assign(toks[i]):
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


segments, is_compound = parse_segments(cmd)

push_segments = []
for seg in segments:
    sub, idx = git_subcommand(seg["tokens"])
    if sub == "push":
        if seg["parse_error"]:
            decide("deny", "Push blocked: command could not be parsed safely.")
        push_segments.append((seg["tokens"], idx))

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
