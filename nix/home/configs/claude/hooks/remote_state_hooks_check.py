#!/usr/bin/env python3
"""Focused regression checks for the remote repository state hooks."""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HOOKS = Path(__file__).parent
TRACKER = HOOKS / "remote-repo-tracker.py"
SNAPSHOT = HOOKS / "remote-state-snapshot.py"


def invoke(script, payload, env):
    return subprocess.run(
        [sys.executable, str(script)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        env=env,
        timeout=12,
    )


with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    state = root / "state"
    repo = root / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(
        ["git", "-C", str(repo), "remote", "add", "origin",
         "git@github.com:acme/infra.git"],
        check=True,
    )
    env = os.environ.copy()
    env["CLAUDE_REMOTE_REPOS_DIR"] = str(state)
    tracked = invoke(TRACKER, {
        "session_id": "check", "cwd": str(root),
        "tool_input": {"command": f"gh pr list -R acme/web-app; git -C {repo} log"},
    }, env)
    assert tracked.returncode == 0, tracked.stderr
    assert tracked.stdout == "", tracked.stdout
    entries = json.loads((state / "check.json").read_text())
    by_slug = {entry["slug"]: entry for entry in entries}
    assert "acme/web-app" in by_slug, entries
    assert Path(by_slug["acme/infra"]["path"]).resolve() == repo.resolve(), entries

    quiet = invoke(SNAPSHOT, {
        "session_id": "check", "cwd": str(root), "prompt": "고마워",
    }, env)
    assert quiet.returncode == 0, quiet.stderr
    assert quiet.stdout == "", quiet.stdout

    missing_env = env.copy()
    missing_env["PATH"] = ""
    missing = invoke(SNAPSHOT, {
        "session_id": "check", "cwd": str(root), "prompt": "PR 상태 알려줘",
    }, missing_env)
    assert missing.returncode == 0, missing.stderr
    context = json.loads(missing.stdout)["hookSpecificOutput"]["additionalContext"]
    assert "gh pr list failed" in context and "No such file" in context, context

print("remote state hooks check ok")
