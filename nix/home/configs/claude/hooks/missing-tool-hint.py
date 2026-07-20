#!/usr/bin/env python3
"""PostToolUse hint: when a Bash command hits "command not found", inject a
reminder to check mise and project-local shims before declaring the tool
absent or installing a global replacement.

A hint, not a gate: it emits hookSpecificOutput.additionalContext (the only
PostToolUse output form Claude actually sees; plain stdout is debug-log-only)
and never blocks anything. Covers the zsh, bash, and POSIX-sh phrasings of the
error. Fail-open on any parse problem.

Self-check: `python3 missing-tool-hint.py --selftest`.
"""
import json
import re
import signal
import sys

NAME = r"([A-Za-z0-9._+-]+)"
NOT_FOUND_RES = (
    re.compile(r"command not found:\s*" + NAME),   # zsh: command not found: foo
    re.compile(NAME + r": command not found"),      # bash: foo: command not found
    re.compile(NAME + r":(?: \d+:)? not found"),    # sh: foo: not found
)


def missing_tool(text):
    """Name of the first tool a not-found error names, or None."""
    for rx in NOT_FOUND_RES:
        m = rx.search(text)
        if m:
            return m.group(1)
    return None


def hint(name):
    return (
        f"`{name}` was not found on PATH. Before declaring it absent or "
        f"installing a global replacement, check the toolchains: "
        f"`mise ls {name}` (installed versions), `mise which {name}` (active "
        f"binary), then project-local shims (`pnpm exec {name}`, package "
        f"scripts)."
    )


def main():
    # Bound the stdin read so a stalled harness pipe can never hang the tool.
    signal.signal(signal.SIGALRM, lambda *_: sys.exit(0))
    signal.alarm(5)
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open
    finally:
        signal.alarm(0)

    if data.get("tool_name") != "Bash":
        sys.exit(0)
    try:
        blob = json.dumps(data.get("tool_response", ""))
    except (TypeError, ValueError):
        sys.exit(0)

    name = missing_tool(blob)
    if name:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": hint(name),
        }}))
    sys.exit(0)


def selftest():
    assert missing_tool("zsh: command not found: rg") == "rg"
    assert missing_tool("bash: jq: command not found") == "jq"
    assert missing_tool("sh: 1: node: not found") == "node"
    assert missing_tool("/bin/sh: biome: not found") == "biome"
    assert missing_tool("error: file not found") is None
    assert missing_tool("all tests passed") is None
    assert "mise ls rg" in hint("rg")
    print("missing-tool-hint selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
