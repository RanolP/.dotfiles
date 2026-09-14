#!/usr/bin/env python3
"""Exercise the Codex hook adapter through its real command-line interface.

The Claude contract runner cannot cover this bridge because it invokes a hook
without its required child-script argument and its fixtures omit
``hook_event_name``.  These checks use Codex's canonical event and tool fields
and fail when translation, policy output, or the child timeout regresses.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ADAPTER = os.path.join(ROOT, "nix/home/configs/codex/hooks/claude-hook-adapter.py")
CLAUDE_HOOKS = os.path.join(ROOT, "nix/home/configs/claude/hooks")


def hook(name: str) -> str:
    return os.path.join(CLAUDE_HOOKS, name)


def run(source: str, payload: dict, *args: str) -> dict | None:
    result = subprocess.run(
        [sys.executable, ADAPTER, *args, source],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        timeout=5,
        check=True,
    )
    return json.loads(result.stdout) if result.stdout.strip() else None


def specific(result: dict | None) -> dict:
    assert result is not None, "adapter returned no hook output"
    value = result.get("hookSpecificOutput")
    assert isinstance(value, dict), result
    return value


def test_multi_file_translation() -> None:
    with tempfile.TemporaryDirectory() as td:
        child = os.path.join(td, "child.py")
        with open(child, "w") as fh:
            fh.write(
                "import json, sys\n"
                "p=json.load(sys.stdin)\n"
                "ti=p.get('tool_input', {})\n"
                "print(json.dumps({'hookSpecificOutput': {\n"
                "  'hookEventName': p['hook_event_name'],\n"
                "  'additionalContext': p['tool_name'] + ':' + ti.get('file_path', '')\n"
                "}}))\n"
            )
        patch = """*** Begin Patch
*** Add File: add.md
+add
*** Update File: update.md
*** Move to: moved.md
*** Delete File: delete.md
*** End Patch
"""
        result = run(
            child,
            {
                "hook_event_name": "PostToolUse",
                "tool_name": "apply_patch",
                "cwd": td,
                "tool_input": {"command": patch},
            },
        )
        context = specific(result)["additionalContext"]
        for name in ("add.md", "update.md", "moved.md", "delete.md"):
            assert os.path.join(td, name) in context, context


def test_real_guards() -> None:
    force = run(
        hook("git-integrity-guard.py"),
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "cwd": "/tmp",
            "tool_input": {"command": "git push --force origin main"},
        },
    )
    assert specific(force)["permissionDecision"] == "deny", force

    edit = run(
        hook("claude-dir-edit-guard.py"),
        {
            "hook_event_name": "PreToolUse",
            "tool_name": "apply_patch",
            "cwd": os.path.expanduser("~"),
            "tool_input": {
                "command": "*** Begin Patch\n"
                "*** Update File: .claude/settings.json\n"
                "*** End Patch\n"
            },
        },
    )
    edit_specific = specific(edit)
    assert edit_specific["permissionDecision"] == "deny", edit
    assert "Home-Manager-owned" in edit_specific["permissionDecisionReason"], edit


def test_timeout_and_spawn_alias() -> None:
    with tempfile.TemporaryDirectory() as td:
        child = os.path.join(td, "child.py")
        # A stalled policy process must produce a denial instead of hanging the tool.
        with open(child, "w") as fh:
            fh.write("import sys, time\nsys.stdin.read()\ntime.sleep(1)\n")
        stalled = run(child, {
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "echo ok"},
        }, "--timeout", "0.05")
        assert specific(stalled)["permissionDecision"] == "deny", stalled
        assert "child timeout" in specific(stalled)["permissionDecisionReason"], stalled

        with open(child, "w") as fh:
            fh.write(
                "import json, sys\n"
                "p=json.load(sys.stdin)\n"
                "assert p['tool_name'] == 'Agent'\n"
                "assert p['tool_input']['subagent_type'] == 'reviewer'\n"
                "print(json.dumps({'hookSpecificOutput': {\n"
                "  'hookEventName': 'PreToolUse', 'additionalContext': 'mapped'\n"
                "}}))\n"
            )
        result = run(
            child,
            {
                "hook_event_name": "PreToolUse",
                "tool_name": "spawn_agent",
                "tool_input": {"agent_type": "reviewer"},
            },
        )
        assert specific(result)["additionalContext"] == "mapped", result


def test_patch_cannot_replace_managed_configuration() -> None:
    for path in (".codex/config.toml", ".codex/agents/oracle.toml", ".nanno-workers.json"):
        result = run(hook("claude-dir-edit-guard.py"), {
            "hook_event_name": "PreToolUse",
            "tool_name": "apply_patch",
            "cwd": os.path.expanduser("~"),
            "tool_input": {"command": (
                "\n*** Begin Patch\n*** Update File: source.toml\n"
                f"*** Move to: {path}\n@@\n-old\n+new\n*** End Patch\n"
            )},
        })
        assert specific(result)["permissionDecision"] == "deny", result


def main() -> None:
    test_multi_file_translation()
    test_real_guards()
    test_timeout_and_spawn_alias()
    test_patch_cannot_replace_managed_configuration()
    print("codex-hook-adapter CLI checks: ok")


if __name__ == "__main__":
    main()
