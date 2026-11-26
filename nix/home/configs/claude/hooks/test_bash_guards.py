#!/usr/bin/env python3
"""Catch lost denials/context and guard crashes when sharing a Python process."""
import json
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import time

HOOKS = Path(__file__).resolve().parent
DISPATCHER = HOOKS / "bash-guards.py"
MODULE = runpy.run_path(str(DISPATCHER))
GUARDS = MODULE["GUARDS"]


def invoke(path, payload):
    result = subprocess.run(
        [sys.executable, str(path)], input=payload, text=True,
        capture_output=True, check=False,
    )
    return result.returncode, result.stdout, result.stderr


def expected(results):
    # Independent contract oracle for standalone process results.
    denials, asks, allows, context, messages = [], [], [], [], []
    ordered_reasons = []
    for code, stdout, stderr in results:
        if code == 2:
            denials.append(stderr.strip())
            ordered_reasons.append(("deny", stderr.strip()))
        if code:
            continue
        if not stdout.strip():
            continue
        data = json.loads(stdout)
        hook = data.get("hookSpecificOutput", {})
        kind = hook.get("permissionDecision")
        reason = hook.get("permissionDecisionReason", "")
        if kind in ("deny", "ask", "allow"):
            {"deny": denials, "ask": asks, "allow": allows}[kind].append(reason)
            ordered_reasons.append((kind, reason))
        if hook.get("additionalContext"):
            context.append(hook["additionalContext"])
        if data.get("systemMessage"):
            messages.append(data["systemMessage"])
    hook = {}
    if ordered_reasons:
        kind, first = ("deny", denials[0]) if denials else ("ask", asks[0]) if asks else ("allow", allows[0])
        rest = ordered_reasons.copy()
        rest.remove((kind, first))
        hook.update(permissionDecision=kind, permissionDecisionReason="\n\n".join(
            reason for reason in [first] + [reason for _, reason in rest] if reason
        ))
    if context:
        hook["additionalContext"] = "\n\n".join(context)
    output = {"hookSpecificOutput": {"hookEventName": "PreToolUse", **hook}} if hook else {}
    if messages:
        output["systemMessage"] = "\n\n".join(messages)
    return output


def record(kind=None, reason="", context="", message=""):
    hook = {}
    if kind:
        hook.update(permissionDecision=kind, permissionDecisionReason=reason)
    if context:
        hook["additionalContext"] = context
    return 0, json.dumps({"hookSpecificOutput": hook, "systemMessage": message}), ""


def main():
    settings = json.loads((HOOKS.parent / "settings.json").read_text())
    groups = settings["hooks"]["PreToolUse"]
    registered = [Path(hook["command"]).name for group in groups
                  for hook in group["hooks"]
                  if group["matcher"] == "Bash" or "agent-tooling-guard.py" in hook["command"]]
    assert tuple(registered) == GUARDS
    for command in ("ls", "git push --force", "sleep 30", "ssh example.invalid", "npm publish"):
        payload = json.dumps({"tool_name": "Bash", "cwd": str(HOOKS),
                              "tool_input": {"command": command}})
        separate = [invoke(HOOKS / name, payload) for name in GUARDS]
        code, stdout, stderr = invoke(DISPATCHER, payload)
        assert code == 0, (command, stderr)
        assert not stderr, (command, stderr)
        actual = json.loads(stdout) if stdout.strip() else {}
        assert actual == expected(separate), (command, actual, expected(separate))
        if command == "ls":
            assert actual == {}
        elif command == "sleep 30":
            assert "block on the condition" in actual["hookSpecificOutput"]["additionalContext"]
        else:
            assert actual["hookSpecificOutput"]["permissionDecision"] == "deny"
        if command == "git push --force":
            integrity = json.loads(separate[GUARDS.index("git-integrity-guard.py")][1])
            assert actual["hookSpecificOutput"]["permissionDecisionReason"].startswith(
                integrity["hookSpecificOutput"]["permissionDecisionReason"])

    combine = MODULE["combine"]
    cases = [
        [record("allow", "allowed"), record("ask", "approval"), record(context="hint", message="notice")],
        [record("ask", "approval"), (2, "ignored", "blocked"), record("deny", "second block", "hint", "notice")],
        [record("deny", "first"), (2, "", "second"), record("allow", "allowed")],
        [record(context="one", message="first"), record(context="two", message="second")],
        [(1, record("deny", "ignored")[1], "failure"), record("allow", "allowed")],
    ]
    for results in cases:
        assert combine(results) == expected(results)
    assert combine([(0, "not JSON", ""), (0, "[]", "")]) == {}

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        broken = root / "broken.py"
        broken.write_text("raise RuntimeError('guard crashed')\n")
        survivor = root / "survivor.py"
        survivor.write_text(
            "import json, sys\nfrom pathlib import Path\n"
            "assert Path(__file__).parent == Path(sys.argv[0]).parent\n"
            "assert sys.stdin.buffer.read() == b'payload'\n"
            "print(json.dumps({'hookSpecificOutput': {'additionalContext': 'survived'}}))\n"
        )
        argv, search_path, stdin = sys.argv[:], sys.path[:], sys.stdin
        results = [MODULE["run_guard"](path, "payload") for path in (broken, survivor)]
        assert results[0][0] == 1 and "guard crashed" in results[0][2]
        assert results[1][0] == 0
        assert combine(results)["hookSpecificOutput"]["additionalContext"] == "survived"
        assert (sys.argv, sys.path, sys.stdin) == (argv, search_path, stdin)
    print("test_bash_guards: 5 payload comparisons, 6 merge cases, exception isolation passed")

    if "--benchmark" in sys.argv:
        payload = json.dumps({"tool_name": "Bash", "tool_input": {"command": "ls"}})
        totals = {"dispatcher": 0.0, "separate": 0.0}
        for _ in range(20):
            for label, paths in (("dispatcher", [DISPATCHER]), ("separate", [HOOKS / name for name in GUARDS])):
                start = time.perf_counter()
                for path in paths:
                    code, stdout, stderr = invoke(path, payload)
                    assert (code, stdout, stderr) == (0, "", "")
                totals[label] += time.perf_counter() - start
        print("20 ls runs: dispatcher=%.3fs separate=%.3fs speedup=%.2fx" % (
            totals["dispatcher"], totals["separate"], totals["separate"] / totals["dispatcher"]))


if __name__ == "__main__":
    main()
