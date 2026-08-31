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
import re
import subprocess
import sys

data = json.load(sys.stdin)
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


def push_target_dir(toks, idx, cwd):
    """Directory the push actually operates on, which is what the bypass is read from.

    `git -C <path> push` pushes the repo at <path>, so the shell's cwd says
    nothing about which repo is being published. Reading the bypass from cwd let
    a `.nanno-workers.json` in ~/.dotfiles authorise a `main` push into an
    unrelated repo, and blocked a dotfiles push issued from anywhere else.
    Multiple `-C` options compose relatively, as in git itself; `--git-dir` and
    `--work-tree` count too, and a `.git` directory still resolves because
    `bypass_enabled` walks upward.
    """
    d = os.path.abspath(cwd or ".")
    i = 0
    while i < len(toks) and is_env_assign(toks[i]):
        i += 1
    i += 1  # the `git` token itself
    while i < idx:
        t = toks[i]
        if t in ("-C", "--git-dir", "--work-tree"):
            if i + 1 < idx:
                d = os.path.abspath(os.path.join(d, toks[i + 1]))
            i += 2
            continue
        if t.startswith(("--git-dir=", "--work-tree=")):
            d = os.path.abspath(os.path.join(d, t.split("=", 1)[1]))
            i += 1
            continue
        if t in GLOBAL_OPT_WITH_ARG:
            i += 2
            continue
        i += 1
    return d


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

toks, idx = push_segments[0]
target_dir = push_target_dir(toks, idx, data.get("cwd") or os.getcwd())

# Escape hatch: a .nanno-workers.json opting in bypasses every push restriction.
# Evaluated at the repo being pushed, never at the shell's cwd.
if bypass_enabled(target_dir):
    decide("allow", "Push guard bypassed via .nanno-workers.json "
                    "(git_push_guard_bypass) at %s." % target_dir)

# A push mixed into a compound command is hard to reason about.
if is_compound:
    decide("deny", "Run git push as a standalone command (no &&/||/;/| chaining).")

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

# `claude/local-dev` clears the claude/* test but must never be published. It is
# the local checkpoint stack -- a stash replacement that holds a stack instead of
# a pile -- and it is rewritten freely precisely because nothing downstream reads
# it. One push would make that rewriting a history rewrite, so the name is denied
# here even though the prefix rule above admits it.
LOCAL_ONLY = "claude/local-dev"
local_only = [
    r for r in refspecs
    if dest(r) == LOCAL_ONLY or dest(r).startswith(LOCAL_ONLY + "/")
]
if local_only:
    decide("deny", "claude/local-dev is the local checkpoint stack and stays on this "
                   "machine. Publish a rebuilt stack on a claude/<topic> branch instead. "
                   "Offending refspec(s): " + ", ".join(local_only))


SHA_IN_TEXT = re.compile(r"\b[0-9a-f]{7,40}\b")


def body_sha_drift(cwd, branch):
    """Reminder text when the open PR's body names commits the branch no longer has.

    A PR body whose 작업 내역 items are keyed by commit sha goes stale the moment
    the stack is rebased, and a body pointing at a dead hash is worse than one
    with no hash at all. This never denies: the user granted standing permission
    to refresh hashes on every push ("해시는 허락 받지 말고 푸시 될 때마다 고치쇼"),
    so the guard only makes the delta visible. Fails silent on anything odd.
    """
    def run(argv):
        return subprocess.run(argv, capture_output=True, text=True, timeout=15, cwd=cwd)

    try:
        p = run(["gh", "pr", "view", branch, "--json", "body,number,baseRefName"])
        if p.returncode:
            return ""
        pr = json.loads(p.stdout)
        body, base = pr.get("body") or "", pr.get("baseRefName") or ""
        if not body or not base:
            return ""
        q = run(["git", "log", "--format=%H", "origin/%s..%s" % (base, branch)])
        if q.returncode:
            return ""
        commits = q.stdout.split()
    except (OSError, ValueError, subprocess.SubprocessError):
        return ""

    named = set(SHA_IN_TEXT.findall(body))
    if not named or not commits:
        return ""
    stale = sorted(s for s in named if not any(c.startswith(s) for c in commits))
    unlisted = [c[:9] for c in commits if not any(c.startswith(s) for s in named)]
    if not stale and not unlisted:
        return ""
    lines = ["PR #%s body drift — refresh it after this push:" % pr.get("number")]
    if stale:
        lines.append("  named in the body but not on the branch: " + ", ".join(stale[:8]))
    if unlisted:
        lines.append("  on the branch but not named in the body: " + ", ".join(unlisted[:8]))
    return "\n".join(lines)


note = body_sha_drift(data.get("cwd") or os.getcwd(), dest(refspecs[0]))
decide("allow", "Push to claude/* branch permitted." + ("\n\n" + note if note else ""))
