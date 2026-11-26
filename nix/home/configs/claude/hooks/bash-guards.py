#!/usr/bin/env python3
"""Share one Python startup while preserving the ordered Bash guard decisions."""
import contextlib
import io
import json
import logging
import runpy
import sys
from pathlib import Path

GUARDS = (
    "agent-tooling-guard.py",
    "flake-stage-guard.py",
    "git-integrity-guard.py",
    "git-push-guard.py",
    "ssh-guard.py",
    "package-manager-guard.py",
    "publish-guard.py",
    "declarative-package-guard.py",
    "nsc-guard.py",
    "gui-launch-guard.py",
    "gh-guard.py",
    "jira-guard.py",
    "pr-body-guard.py",
    "file-edit-guard.py",
    "commit-check-guard.py",
    "leak-guard.py",
    "bare-sleep-hint.py",
    "baseline-lock-guard.py",
)


class HookInput(io.StringIO):
    def __init__(self, payload):
        super().__init__(payload)
        # ssh-guard and publish-guard consume bytes rather than text.
        self.buffer = io.BytesIO(payload.encode("utf-8"))


def run_guard(path, payload):
    stdout, stderr = io.StringIO(), io.StringIO()
    stdin, argv, search_path = sys.stdin, sys.argv, sys.path[:]
    status = 0
    try:
        sys.stdin = HookInput(payload)
        sys.argv = [str(path)]
        sys.path.insert(0, str(path.parent))
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                runpy.run_path(str(path), run_name="__main__")
            except SystemExit as exc:
                status = exc.code if isinstance(exc.code, int) else 0 if exc.code is None else 1
                if exc.code is not None and not isinstance(exc.code, int):
                    print(exc.code, file=sys.stderr)
            except BaseException:
                status = 1
                logging.getLogger("bash-guards").exception("Guard failed")
    finally:
        sys.stdin, sys.argv = stdin, argv
        sys.path[:] = search_path
    return status, stdout.getvalue(), stderr.getvalue()


def combine(results):
    decisions, contexts, messages = [], [], []
    for status, stdout, stderr in results:
        if status == 2:
            decisions.append(("deny", stderr.strip()))
        if status != 0:
            continue  # Claude ignores JSON from failed hooks, including exit 2.
        try:
            output = json.loads(stdout)
        except ValueError:
            continue
        if not isinstance(output, dict):
            continue
        specific = output.get("hookSpecificOutput") or {}
        if not isinstance(specific, dict):
            specific = {}
        decision = specific.get("permissionDecision")
        if decision in ("deny", "ask", "allow"):
            decisions.append((decision, specific.get("permissionDecisionReason", "")))
        if specific.get("additionalContext"):
            contexts.append(specific["additionalContext"])
        if output.get("systemMessage"):
            messages.append(output["systemMessage"])

    specific = {}
    if decisions:
        priority = {"allow": 0, "ask": 1, "deny": 2}
        winner = max(decisions, key=lambda item: priority[item[0]])
        specific["permissionDecision"] = winner[0]
        # Put the first winning reason first, followed by every other reason.
        index = decisions.index(winner)
        reasons = [winner[1]] + [reason for i, (_, reason) in enumerate(decisions) if i != index]
        specific["permissionDecisionReason"] = "\n\n".join(reason for reason in reasons if reason)
    if contexts:
        specific["additionalContext"] = "\n\n".join(contexts)
    output = {}
    if specific:
        output["hookSpecificOutput"] = {"hookEventName": "PreToolUse", **specific}
    if messages:
        output["systemMessage"] = "\n\n".join(messages)
    return output


def main():
    payload = sys.stdin.read()
    results = []
    for name in GUARDS:
        result = run_guard(Path(__file__).parent / name, payload)
        results.append(result)
        status, _, stderr = result
        if stderr:
            print(f"[bash-guards: {name}] {stderr}", file=sys.stderr, end="" if stderr.endswith("\n") else "\n")
        elif status not in (0, 2):
            print(f"[bash-guards: {name}] exited {status}", file=sys.stderr)
    output = combine(results)
    if output:
        print(json.dumps(output))


if __name__ == "__main__":
    main()
