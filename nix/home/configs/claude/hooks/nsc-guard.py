#!/usr/bin/env python3
"""PreToolUse guard: a Namespace (`nsc`) command that bills by runtime asks first.

`nsc create`, `destroy`, `extend`, `build` and `run` start, keep alive, or end
a Namespace Cloud machine that is billed while it runs. The rule was prose in
AGENTS.md ("state the machine type and expected runtime in one line and wait
for a yes"); a prose rule aimed at a model is a request, so the yes is now
collected by Claude Code's own permission prompt. The decision is `ask`, never
`deny`: the user may well want the machine.

Read-only and local subcommands (`list`, `describe`, `version`, `help`, any
`--help`) pass untouched.

Parsing reuses declarative-package-guard.py's single-pass, O(n), quote-aware
tokenizer, so a shell operator inside quoted text never splits a segment and
the parser cannot ReDoS.

Fail open, always. This hook runs in front of every Bash call in every session,
so an unparseable payload, an unknown shape, or any exception allows the call.
"""
import json
import sys

BILLED = {"create", "destroy", "extend", "build", "run"}
# nsc's global flags that take the next token as their value.
NSC_OPT_WITH_ARG = {"--endpoint", "--keychain", "--region"}
WRAPPERS = {"sudo", "command", "env", "nohup", "nice", "time", "doas", "exec", "caffeinate"}


def _is_name_char(ch):
    return ch == "_" or ("a" <= ch <= "z") or ("A" <= ch <= "Z") or ("0" <= ch <= "9")


def is_env_assign(tok):
    eq = tok.find("=")
    if eq <= 0:
        return False
    first = tok[0]
    if not (first == "_" or ("a" <= first <= "z") or ("A" <= first <= "Z")):
        return False
    return all(_is_name_char(c) for c in tok[:eq])


def parse_segments(command):
    """Split a shell command into operator-separated segments of unquoted
    tokens in one pass. `&& || ; & |` split only outside quotes. A segment
    with an unterminated quote is marked so the caller skips it."""
    segments = []
    tokens = []
    tok = []
    tok_started = False
    seg_error = False

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
                seg_error = True
            else:
                i += 1
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
                seg_error = True
            else:
                i += 1
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
            flush_segment()
            i += 2
            continue
        if c in (";", "&", "|", "(", ")"):
            flush_segment()
            i += 1
            continue
        tok_started = True
        tok.append(c)
        i += 1

    flush_segment()
    return segments


def base(tok):
    return tok.rsplit("/", 1)[-1]


def strip_prefix(toks):
    """Drop env assignments and command wrappers, so `sudo -E nsc ...` reads as `nsc ...`."""
    i = 0
    while i < len(toks):
        if is_env_assign(toks[i]):
            i += 1
            continue
        if base(toks[i]) in WRAPPERS:
            i += 1
            while i < len(toks) and toks[i].startswith("-"):
                i += 1
            continue
        break
    return toks[i:]


def billed_subcommand(toks):
    """The billed subcommand this segment runs, or None."""
    toks = strip_prefix(toks)
    if not toks or base(toks[0]) != "nsc":
        return None
    if any(t in ("-h", "--help") for t in toks[1:]):
        return None
    skip = False
    for t in toks[1:]:
        if skip:
            skip = False
            continue
        if t in NSC_OPT_WITH_ARG:
            skip = True
            continue
        if t.startswith("-"):
            continue
        return t if t in BILLED else None
    return None


def main():
    data = json.load(sys.stdin)
    if not isinstance(data, dict):
        return
    tool_input = data.get("tool_input")
    cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(cmd, str) or "nsc" not in cmd:
        return
    for seg in parse_segments(cmd):
        if seg["parse_error"]:
            continue
        sub = billed_subcommand(seg["tokens"])
        if sub:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason":
                    "`nsc %s` is billed by runtime on Namespace Cloud; approve it only "
                    "if you want that machine time spent." % sub,
            }}))
            return


try:
    main()
except SystemExit:
    raise
except BaseException:
    pass
sys.exit(0)
