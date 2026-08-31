#!/usr/bin/env python3
"""Contract test for a Claude Code hook, run inside a container.

A PreToolUse hook on the `Bash` matcher sits in front of every Bash call in
every session on the machine. When it crashes, Claude Code surfaces the crash
as a hook error and denies the call, so one bad hook is a total work stoppage
that only a rebuild can lift. That blast radius is why this runs against a
clean interpreter in a container before the hook is ever deployed.

The contract this asserts, per payload:

  - the process exits 0 (allow / decided in stdout) or 2 (block, reason on
    stderr); any other code is Claude Code's "hook error" path
  - stderr carries no Python traceback
  - stdout is empty or a single JSON object
  - the call finishes inside the time budget

Usage: hook-contract-test.py <hook.py> [<hook.py> ...]
Exit 0 when every hook passes, 1 otherwise.
"""

import json
import subprocess
import sys
import time

TIME_BUDGET_S = 3.0

# Every payload here is a shape a real session can produce. A hook is free to
# allow, block, or stay silent on any of them -- it is not free to crash.
PAYLOADS = [
    ("read command", {"tool_name": "Bash", "tool_input": {"command": "grep -rn foo ."}, "cwd": "/repo"}),
    ("write command", {"tool_name": "Bash", "tool_input": {"command": "sed -i '' s/a/b/ x.py"}, "cwd": "/repo"}),
    ("heredoc", {"tool_name": "Bash", "tool_input": {"command": "python3 <<'PY'\nopen('x.py','w')\nPY\n"}, "cwd": "/repo"}),
    ("empty command", {"tool_name": "Bash", "tool_input": {"command": ""}, "cwd": "/repo"}),
    ("missing cwd", {"tool_name": "Bash", "tool_input": {"command": "ls"}}),
    ("missing command", {"tool_name": "Bash", "tool_input": {}, "cwd": "/repo"}),
    ("missing tool_input", {"tool_name": "Bash", "cwd": "/repo"}),
    ("empty object", {}),
    ("null command", {"tool_name": "Bash", "tool_input": {"command": None}, "cwd": "/repo"}),
    ("numeric command", {"tool_name": "Bash", "tool_input": {"command": 42}, "cwd": "/repo"}),
    ("list command", {"tool_name": "Bash", "tool_input": {"command": ["ls"]}, "cwd": "/repo"}),
    ("other tool", {"tool_name": "Edit", "tool_input": {"file_path": "/repo/x.py"}, "cwd": "/repo"}),
    ("agent tool", {"tool_name": "Agent", "tool_input": {"prompt": "hi"}, "cwd": "/repo"}),
    ("unicode", {"tool_name": "Bash", "tool_input": {"command": "echo '한글 🎉' > /tmp/x"}, "cwd": "/repo"}),
    ("quote soup", {"tool_name": "Bash", "tool_input": {"command": "sed -i \"s/'/\\\"/g\" 'a b.py'"}, "cwd": "/repo"}),
    ("unterminated quote", {"tool_name": "Bash", "tool_input": {"command": "echo 'unclosed"}, "cwd": "/repo"}),
    ("unterminated heredoc", {"tool_name": "Bash", "tool_input": {"command": "cat <<'EOF'\nno end\n"}, "cwd": "/repo"}),
    ("1MB command", {"tool_name": "Bash", "tool_input": {"command": "echo " + "x" * 1_000_000}, "cwd": "/repo"}),
    ("deep nesting", {"tool_name": "Bash", "tool_input": {"command": "ls"}, "extra": json.loads("[" * 40 + "]" * 40)}),
]

RAW_PAYLOADS = [
    ("empty stdin", b""),
    ("not json", b"this is not json at all"),
    ("truncated json", b'{"tool_name": "Bash", "tool_inp'),
    ("json array", b"[1, 2, 3]"),
    ("json scalar", b'"just a string"'),
    ("invalid utf-8", b'{"tool_name": "Bash", "tool_input": {"command": "\xff\xfe"}}'),
]


def run(hook, stdin_bytes):
    started = time.monotonic()
    try:
        p = subprocess.run(
            [sys.executable, hook],
            input=stdin_bytes,
            capture_output=True,
            timeout=TIME_BUDGET_S,
        )
    except subprocess.TimeoutExpired:
        return None, b"", b"", time.monotonic() - started
    return p.returncode, p.stdout, p.stderr, time.monotonic() - started


def check(hook, label, stdin_bytes):
    """Returns (severity, message), or None when the payload met the contract.

    Exit codes are measured, not assumed (python3 3.14.6, 2026-08-28):
    a missing script file exits 2, and PreToolUse treats exit 2 as a block --
    that pair is exactly how one unregistered hook denied every Bash call on
    this machine. An uncaught exception exits 1, which Claude Code surfaces as
    a non-blocking error: the tool still runs, so the guard has silently
    stopped guarding rather than stopped the session.
    """
    code, out, err, elapsed = run(hook, stdin_bytes)
    tail = err.decode("utf-8", "replace").strip().splitlines()[-1:] or [""]

    if code is None:
        return ("STOP", f"timed out after {TIME_BUDGET_S}s -- every matched call would hang this long")
    if code == 2 and b"Traceback (most recent call last)" in err:
        return ("STOP", f"exit 2 with a traceback -- PreToolUse reads exit 2 as a block: {tail[0]}")
    if code not in (0, 2):
        return ("OPEN", f"exit {code} -- the guard crashed and the call proceeds unguarded: {tail[0]}")
    if b"Traceback (most recent call last)" in err:
        return ("OPEN", f"traceback on stderr -- the guard crashed and the call proceeds: {tail[0]}")

    # stdout is free-form context text for UserPromptSubmit/SessionStart hooks,
    # so only a payload that opens like a decision object has to parse as one.
    text = out.decode("utf-8", "replace").strip()
    if text.startswith("{"):
        try:
            json.loads(text)
        except json.JSONDecodeError as e:
            return ("STOP", f"stdout opens as JSON but does not parse ({e}): {text[:120]!r}")

    if elapsed > 1.0:
        return ("SLOW", f"took {elapsed:.2f}s -- it is charged to every matched call")
    return None


def selftest(hook):
    """Runs the hook's own --selftest when it advertises one."""
    with open(hook, "r", encoding="utf-8", errors="replace") as f:
        if "--selftest" not in f.read():
            return None
    p = subprocess.run([sys.executable, hook, "--selftest"], capture_output=True, timeout=60)
    if p.returncode != 0:
        return f"--selftest exited {p.returncode}: {p.stderr.decode('utf-8', 'replace').strip()[:300]}"
    return None


def verify(hook):
    print(f"\n== {hook}")
    failures = []

    err = selftest(hook)
    if err is not None:
        print(f"  OPEN --selftest: {err}")
        failures.append(("OPEN", "--selftest", err))

    cases = [(label, json.dumps(p).encode()) for label, p in PAYLOADS] + RAW_PAYLOADS
    for label, stdin_bytes in cases:
        result = check(hook, label, stdin_bytes)
        if result is not None:
            severity, msg = result
            print(f"  {severity} {label}: {msg}")
            failures.append((severity, label, msg))
    if not failures:
        print("  clean")
    return failures


def main():
    hooks = sys.argv[1:]
    if not hooks:
        print(__doc__)
        return 2

    all_failures = []
    for hook in hooks:
        all_failures += verify(hook)

    stops = [f for f in all_failures if f[0] == "STOP"]
    opens = [f for f in all_failures if f[0] == "OPEN"]
    slows = [f for f in all_failures if f[0] == "SLOW"]

    print(f"\n-- {len(hooks)} hook(s) on python {sys.version.split()[0]}")
    print(f"STOP {len(stops):>3}  blocks or hangs every matched call -- never register this")
    print(f"OPEN {len(opens):>3}  the guard crashes and the call proceeds unguarded")
    print(f"SLOW {len(slows):>3}  over 1s, charged to every matched call")
    return 1 if stops or opens else 0


if __name__ == "__main__":
    sys.exit(main())
