#!/usr/bin/env python3
"""Semantics test for nsc-guard.py.

The guard asks before an `nsc` subcommand that bills by runtime (`create`,
`destroy`, `extend`, `build`, `run`) and stays silent on every read-only query,
on `--help`, and on anything it cannot parse.

Usage: nsc-guard-test.py   (exit 0 when every case passes)
"""

import json
import os
import subprocess
import sys

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "nix", "home", "configs", "claude", "hooks", "nsc-guard.py")


def run(cmd):
    p = subprocess.run([sys.executable, HOOK], text=True, capture_output=True, timeout=30,
                       input=json.dumps({"tool_name": "Bash", "cwd": "/repo",
                                         "tool_input": {"command": cmd}}))
    if p.returncode != 0:
        return "error(%d): %s" % (p.returncode, p.stderr.strip()[-200:]), ""
    if not p.stdout.strip():
        return "passthrough", ""
    out = json.loads(p.stdout)["hookSpecificOutput"]
    return out["permissionDecision"], out["permissionDecisionReason"]


CASES = [
    # each billed subcommand reaching the machine without a yes
    ("create", "nsc create --machine_type 4x8 --duration 30m", "ask"),
    ("destroy", "nsc destroy abc123", "ask"),
    ("extend", "nsc extend abc123 --duration 1h", "ask"),
    ("build", "nsc build . -t img:latest", "ask"),
    ("run", "nsc run --image nginx -p 80", "ask"),
    # a billed call hidden behind an operator or a wrapper
    ("after &&", "cd /repo && nsc create", "ask"),
    ("after ;", "echo hi; nsc destroy abc", "ask"),
    ("after |", "echo y | nsc destroy abc", "ask"),
    ("env prefix", "env NSC_TOKEN=x nsc build .", "ask"),
    ("bare env assign", "NSC_REGION=eu nsc run --image x", "ask"),
    ("sudo", "sudo -E nsc create", "ask"),
    ("absolute path", "/usr/local/bin/nsc create", "ask"),
    ("global flag with value", "nsc --region eu create", "ask"),
    ("global flag =value", "nsc --region=eu extend abc", "ask"),
    ("subshell", "(nsc create)", "ask"),

    # read-only queries and help pass
    ("list", "nsc list", "passthrough"),
    ("describe", "nsc describe abc123", "passthrough"),
    ("version", "nsc version", "passthrough"),
    ("top-level help", "nsc --help", "passthrough"),
    ("sub help", "nsc create --help", "passthrough"),
    ("sub -h", "nsc run -h", "passthrough"),
    ("help subcommand", "nsc help create", "passthrough"),
    ("logs", "nsc logs abc123", "passthrough"),
    ("value equals a billed word", "nsc --region create list", "passthrough"),

    # quoting traps and fail open
    ("quoted text", "echo 'nsc create'", "passthrough"),
    ("grep for it", "rg -n 'nsc create' docs", "passthrough"),
    ("quoted operator", "echo 'a && nsc create'", "passthrough"),
    ("unterminated quote", "nsc create 'unclosed", "passthrough"),
    ("similar name", "nscx create", "passthrough"),
    ("empty", "", "passthrough"),
]


def main():
    failures = 0
    for name, cmd, want in CASES:
        got, _ = run(cmd)
        ok = got == want
        failures += not ok
        print("%s  %-28s want=%-11s got=%s" % ("ok  " if ok else "FAIL", name, want, got))

    # an ask is only useful when it names the command and that it is billed
    _, text = run("nsc extend abc")
    ok = "`nsc extend`" in text and "billed" in text
    failures += not ok
    print("%s  reason names the command and the bill: %s" % ("ok  " if ok else "FAIL", text))

    total = len(CASES) + 1
    print("%d/%d passed" % (total - failures, total))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
