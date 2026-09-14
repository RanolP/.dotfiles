#!/usr/bin/env python3
"""Bridge Claude hook guards to Codex's canonical tool names.

Codex sends one ``apply_patch`` event for a patch that can change several
files, while the existing guards consume one Claude ``Edit`` or ``Write``
event per file.  Codex also calls its subagent tool ``spawn_agent`` and sends
the agent configuration under Codex field names.  This adapter keeps the
guards as the single policy implementation and translates only those wire
differences.

Malformed input fails open.  A valid PreToolUse event whose child guard cannot
finish is denied explicitly, because silently skipping that guard would make
the call unprotected.  Other event failures become advisory context.

Run with one existing guard as the final argument, for example::

    python3 claude-hook-adapter.py ~/.codex/hooks/prompt-authoring-guard.py

The child timeout defaults to two seconds; network-backed guards can opt into
a larger value with ``--timeout 25``.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from collections.abc import Iterable


DEFAULT_TIMEOUT = 2.0
PATCH_BEGIN = "*** Begin Patch"
PATCH_END = "*** End Patch"
FILE_MARKER = re.compile(r"^\*\*\* (Add|Update|Delete) File: (.+?)\s*$")
MOVE_MARKER = re.compile(r"^\*\*\* Move to: (.+?)\s*$")
PATCH_TOOLS = frozenset({"apply_patch"})
SPAWN_TOOLS = frozenset({"spawn_agent"})


class ChildFailure(RuntimeError):
    """A child hook failed in a way the caller must see."""


def _path_from_cwd(path: str, cwd: str | None) -> str:
    expanded = os.path.expanduser(path)
    if not os.path.isabs(expanded):
        expanded = os.path.join(cwd or os.getcwd(), expanded)
    return os.path.normpath(expanded)


def _clean_patch_path(raw: str) -> str:
    path = raw.strip()
    if not path or "\x00" in path:
        raise ValueError("empty or NUL-containing patch path")
    return path


def parse_patch(patch: str) -> list[str]:
    """Extract every file touched by an apply_patch document in source order.

    ``Move to`` follows an ``Update File`` marker in the apply_patch grammar,
    so both the old and new path are returned.  Returning both matters because
    a move removes the old file and writes the new one.
    """
    if not isinstance(patch, str):
        return []
    lines = patch.strip().splitlines()
    if not lines or lines[0] != PATCH_BEGIN:
        return []
    try:
        end = next(i for i, line in enumerate(lines[1:], 1) if line == PATCH_END)
    except StopIteration:
        return []
    if any(line.strip() for line in lines[end + 1 :]):
        return []

    paths: list[str] = []
    current = False
    for line in lines[1:end]:
        marker = FILE_MARKER.match(line)
        if marker:
            paths.append(_clean_patch_path(marker.group(2)))
            current = True
            continue
        move = MOVE_MARKER.match(line)
        if move:
            if not current:
                return []
            paths.append(_clean_patch_path(move.group(1)))
            continue
    return list(dict.fromkeys(paths))


def _patch_text(tool_input: object) -> str | None:
    if isinstance(tool_input, str):
        return tool_input if PATCH_BEGIN in tool_input else None
    if not isinstance(tool_input, dict):
        return None
    # Codex 0.154 sends the apply_patch document in `tool_input.command`;
    # accept the older/source spelling as a compatibility fallback.
    for key in ("command", "input", "patch", "patch_text"):
        value = tool_input.get(key)
        if isinstance(value, str) and PATCH_BEGIN in value:
            return value
    return None


def _synthetic_payload(data: dict, tool: str, tool_input: dict) -> dict:
    payload = dict(data)
    payload["tool_name"] = tool
    payload["tool_input"] = tool_input
    return payload


def normalized_payloads(data: dict) -> list[dict]:
    """Return one Claude-shaped payload per Codex operation being checked."""
    tool = data.get("tool_name")
    if tool in PATCH_TOOLS:
        patch = _patch_text(data.get("tool_input"))
        paths = parse_patch(patch) if patch is not None else []
        if not paths:
            return []
        cwd = data.get("cwd") if isinstance(data.get("cwd"), str) else None
        return [
            _synthetic_payload(
                data, "Edit", {"file_path": _path_from_cwd(path, cwd)}
            )
            for path in paths
        ]

    if tool in SPAWN_TOOLS:
        original = data.get("tool_input")
        child_input = dict(original) if isinstance(original, dict) else {}
        if "subagent_type" not in child_input:
            agent_type = child_input.get("agent_type")
            if isinstance(agent_type, str) and agent_type.strip():
                child_input["subagent_type"] = agent_type
            elif child_input.get("fork_context") is True:
                child_input["subagent_type"] = "fork"
        return [_synthetic_payload(data, "Agent", child_input)]

    return [data]


def _kill_process_group(process: subprocess.Popen[bytes]) -> None:
    if os.name != "nt":
        try:
            os.killpg(process.pid, signal.SIGKILL)
            return
        except OSError:
            pass
    try:
        process.kill()
    except OSError:
        pass


def run_child(source: str, payload: dict, timeout: float) -> dict | str | None:
    """Run one existing hook without importing its process-exit entry point."""
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        process = subprocess.Popen(
            [sys.executable, source],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=os.name != "nt",
        )
    except OSError as exc:
        raise ChildFailure(f"could not start {source}: {exc}") from exc

    try:
        stdout, stderr = process.communicate(encoded, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        _kill_process_group(process)
        process.communicate()
        raise ChildFailure(f"{source} exceeded the {timeout:g}s child timeout") from exc

    if process.returncode != 0:
        detail = stderr.decode("utf-8", "replace").strip()
        raise ChildFailure(
            f"{source} exited {process.returncode}"
            + (f": {detail[:300]}" if detail else "")
        )
    text = stdout.decode("utf-8", "replace").strip()
    if not text:
        return None
    try:
        result = json.loads(text)
    except ValueError:
        # UserPromptSubmit accepts plain stdout as context.  Preserve that
        # form for the one event where it is part of the hook contract.
        if payload.get("hook_event_name") in {"UserPromptSubmit", "SessionStart", "SubagentStart"}:
            return text
        raise ChildFailure(f"{source} emitted malformed hook JSON")
    if not isinstance(result, dict):
        raise ChildFailure(f"{source} emitted a non-object hook result")
    return result


def _hook_specific(result: dict) -> dict | None:
    value = result.get("hookSpecificOutput")
    return value if isinstance(value, dict) else None


def _valid_result(result: dict | str | None, event: str) -> bool:
    if result is None or isinstance(result, str):
        return True
    specific = _hook_specific(result)
    if specific is not None:
        return True
    return any(key in result for key in ("systemMessage", "decision", "continue", "stopReason"))


def merge_results(results: Iterable[dict | str | None], event: str) -> dict | str | None:
    """Merge per-file child results while keeping Codex's event output shape."""
    values = [result for result in results if result is not None]
    if not values:
        return None
    if any(not _valid_result(result, event) for result in values):
        raise ChildFailure("child emitted an unsupported hook output shape")

    if event == "PreToolUse":
        for result in values:
            if isinstance(result, dict):
                specific = _hook_specific(result) or {}
                if specific.get("permissionDecision") == "deny" or result.get("decision") == "block":
                    return result
        for result in values:
            if isinstance(result, dict):
                specific = _hook_specific(result) or {}
                if specific.get("permissionDecision") in {"allow", "ask"}:
                    return result

    plain = [result for result in values if isinstance(result, str)]
    if plain:
        return "\n\n".join(dict.fromkeys(plain))

    first = next((result for result in values if isinstance(result, dict)), None)
    if first is None:
        return None
    merged = dict(first)
    specifics = [
        _hook_specific(result)
        for result in values
        if isinstance(result, dict) and _hook_specific(result) is not None
    ]
    if specifics:
        specific = dict(specifics[0])
        contexts = [
            value.get("additionalContext")
            for value in specifics
            if isinstance(value.get("additionalContext"), str) and value.get("additionalContext")
        ]
        if contexts:
            specific["additionalContext"] = "\n\n".join(dict.fromkeys(contexts))
        merged["hookSpecificOutput"] = specific
    messages = [
        result.get("systemMessage")
        for result in values
        if isinstance(result, dict) and isinstance(result.get("systemMessage"), str)
    ]
    if messages:
        merged["systemMessage"] = "\n\n".join(dict.fromkeys(messages))
    return merged


def failure_payload(event: str, detail: str) -> dict | str | None:
    message = f"Codex hook adapter could not run its guard: {detail}"
    if event == "PreToolUse":
        return {"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": message,
        }}
    if event in {"PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart"}:
        return {"hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": message,
        }}
    if event in {"Stop", "SubagentStop"}:
        return {"systemMessage": message}
    return None


def read_payload() -> dict | None:
    try:
        raw = sys.stdin.buffer.read()
        value = json.loads(raw.decode("utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def handle(data: dict, source: str, timeout: float) -> dict | str | None:
    event = data.get("hook_event_name")
    if not isinstance(event, str) or not event:
        return None
    payloads = normalized_payloads(data)
    # An invalid or empty apply_patch payload has no path that can be checked;
    # the normal Codex permission path remains in charge.
    if not payloads:
        return None
    results: list[dict | str | None] = []
    deadline = time.monotonic() + timeout
    for payload in payloads:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ChildFailure(f"{source} exceeded the {timeout:g}s child timeout")
        results.append(run_child(source, payload, remaining))
    return merge_results(results, event)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("source", help="existing Claude hook script to invoke")
    args = parser.parse_args(argv)
    if not args.source or args.timeout <= 0:
        return 0

    data = read_payload()
    if data is None:
        return 0
    event = data.get("hook_event_name") if isinstance(data.get("hook_event_name"), str) else ""
    try:
        result = handle(data, args.source, args.timeout)
    except ChildFailure as exc:
        result = failure_payload(event, str(exc))
    except Exception as exc:  # adapter bugs fail open outside a valid child failure
        result = failure_payload(event, f"internal error ({type(exc).__name__})")
    if result is not None:
        if isinstance(result, str):
            print(result)
        else:
            print(json.dumps(result, ensure_ascii=False))
    return 0


def selftest() -> None:
    patch = """*** Begin Patch
*** Add File: add.md
+add
*** Update File: update.md
@@
-old
+new
*** Move to: moved.md
*** Delete File: delete.md
*** End Patch
"""
    assert parse_patch(patch) == ["add.md", "update.md", "moved.md", "delete.md"]
    assert parse_patch("*** Begin Patch\n*** Move to: nowhere\n*** End Patch\n") == []
    assert parse_patch("*** Begin Patch\n*** Add File: x\n") == []
    spawn = normalized_payloads({
        "hook_event_name": "PreToolUse",
        "tool_name": "spawn_agent",
        "tool_input": {"agent_type": "code-reviewer"},
    })[0]
    assert spawn["tool_name"] == "Agent"
    assert spawn["tool_input"]["subagent_type"] == "code-reviewer"
    assert "model" not in spawn["tool_input"]
    print("claude-hook-adapter selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        raise SystemExit(main())
