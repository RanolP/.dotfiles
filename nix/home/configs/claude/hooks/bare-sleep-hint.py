#!/usr/bin/env python3
"""PreToolUse hint: steer fixed sleeps toward condition-based waits.

A fixed delay can finish before the condition is ready or waste time after it
is ready. Condition-wait loops already express the intended synchronization,
so sleeps in their bodies pass without a hint. This hook only adds context and
never denies the Bash call.

Self-check: `python3 bare-sleep-hint.py --selftest`.
"""
import json
import re
import shlex
import sys

DELAY_RE = re.compile(r"(?:\d+(?:\.\d*)?|\.\d+)s?\Z")
ASSIGNMENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")
LOOP_WORDS = ("for", "select", "until", "while")
WAIT_LOOP_WORDS = ("until", "while")
# shlex appends one character at a time, so bound the work on every Bash call.
MAX_SCAN_CHARS = 64 * 1024
HINT = (
    "block on the condition instead of a clock: "
    "`gh run watch <id> --exit-status`, "
    "`agent-browser wait --load networkidle`, "
    "`agent-device wait stable`, else "
    "`until <check>; do sleep 2; done`; see skill metro-wait."
)


def shell_tokens(command):
    lexer = shlex.shlex(
        command,
        posix=True,
        punctuation_chars=";&|()\n",
    )
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    return list(lexer)


def has_bare_sleep(command):
    """Whether a command runs a fixed sleep outside a condition-wait loop."""
    if not isinstance(command, str):
        return False

    command = command[:MAX_SCAN_CHARS]
    tokens = shell_tokens(command)
    loops = []
    command_start = True

    for index, token in enumerate(tokens):
        if token and all(char in ";&|()\n" for char in token):
            command_start = any(char in ";&|(\n" for char in token)
            continue

        if command_start and token in LOOP_WORDS:
            loops.append([token, False])
            command_start = True
            continue

        if command_start and token == "do":
            if loops:
                loops[-1][1] = True
            command_start = True
            continue

        if command_start and token == "done":
            if loops:
                loops.pop()
            command_start = False
            continue

        if command_start and token in ("!", "elif", "else", "then", "{"):
            command_start = True
            continue

        if command_start and ASSIGNMENT_RE.match(token):
            continue

        if (
            command_start
            and token == "sleep"
            and index + 1 < len(tokens)
            and DELAY_RE.fullmatch(tokens[index + 1])
            and not any(kind in WAIT_LOOP_WORDS and body for kind, body in loops)
        ):
            return True

        command_start = False

    return False


def handle(data):
    if not isinstance(data, dict) or data.get("tool_name") != "Bash":
        return None
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return None
    if not has_bare_sleep(tool_input.get("command")):
        return None
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": HINT,
    }}


def main():
    try:
        data = json.loads(sys.stdin.read())
        payload = handle(data)
        if payload:
            print(json.dumps(payload))
    except Exception:
        pass  # a hint must never block or break a tool call


def selftest():
    assert has_bare_sleep("sleep 5")
    assert has_bare_sleep("echo ready; sleep 0.5s")
    assert has_bare_sleep("until check; do sleep 2; done; sleep 5")
    assert not has_bare_sleep("until check; do sleep 2; done")
    assert not has_bare_sleep("while ! check; do sleep 2s; done")
    assert not has_bare_sleep("echo sleep 5")
    assert handle({"tool_name": "Read", "tool_input": {"command": "sleep 5"}}) is None
    print("bare-sleep-hint selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
