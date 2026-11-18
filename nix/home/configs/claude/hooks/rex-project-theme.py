#!/usr/bin/env python3
"""Keep the current Rex pane tinted for Claude Code's active project."""

import json
import os
import subprocess
import sys


SCRIPT = os.path.expanduser("~/.local/bin/rex-project-theme")
PATH_TOOLS = frozenset({"Read", "Edit", "Write", "MultiEdit", "Grep", "Glob"})


def target_path(data):
    cwd = data.get("cwd")
    if not isinstance(cwd, str) or not cwd:
        cwd = os.getcwd()
    if data.get("hook_event_name") == "SessionStart" or data.get("tool_name") == "Bash":
        return cwd
    if data.get("tool_name") not in PATH_TOOLS:
        return cwd
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return cwd
    path = tool_input.get("file_path") or tool_input.get("path")
    if not isinstance(path, str) or not path:
        return cwd
    if not os.path.isabs(path):
        path = os.path.join(cwd, path)
    return os.path.normpath(path)


def main():
    try:
        data = json.load(sys.stdin)
        if not isinstance(data, dict):
            return 0
        subprocess.run(
            [SCRIPT, target_path(data)],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
        )
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
