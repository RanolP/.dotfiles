#!/usr/bin/env python3
"""Catch unsupported Codex settings and stale hook trust hashes without inference."""

import collections
import json
import os
from pathlib import Path
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import tomllib


ROOT = Path(__file__).resolve().parents[1]
EVENTS = {
    "PreToolUse": "preToolUse",
    "PostToolUse": "postToolUse",
    "UserPromptSubmit": "userPromptSubmit",
    "Stop": "stop",
}


def declarations(config):
    return collections.Counter(
        (EVENTS[event], group.get("matcher"), hook["command"])
        for event, groups in config.get("hooks", {}).items()
        if event != "state"
        for group in groups
        for hook in group["hooks"]
    )


def read_responses(stream, replies):
    for line in stream:
        replies.put(line)
    replies.put(None)


def request(process, replies, request_id, method, params):
    process.stdin.write(json.dumps({"id": request_id, "method": method, "params": params}) + "\n")
    process.stdin.flush()
    deadline = time.monotonic() + 10
    while True:
        try:
            line = replies.get(timeout=max(0, deadline - time.monotonic()))
        except queue.Empty:
            raise RuntimeError(f"{method} timed out; app-server exit={process.poll()}") from None
        if line is None:
            raise RuntimeError(f"app-server closed during {method}; exit={process.poll()}")
        response = json.loads(line)
        if response.get("id") != request_id:
            continue
        if "error" in response:
            raise RuntimeError(f"{method}: {response['error']}")
        return response["result"]


def check():
    source = (ROOT / "nix/home/configs/codex/config.toml").read_text()
    config = tomllib.loads(source)
    project = (ROOT / ".codex/config.toml").read_text()
    expected = declarations(config) + declarations(tomllib.loads(project))
    with tempfile.TemporaryDirectory(prefix="codex-config-check-") as directory:
        base = Path(directory).resolve()
        codex_home, cwd = base / "codex", base / "project"
        codex_home.mkdir()
        (cwd / ".codex").mkdir(parents=True)
        config_path = codex_home / "config.toml"
        project_path = cwd / ".codex/config.toml"
        project_path.write_text(project)
        rendered = source.replace("@codexConfig@", str(config_path)).replace("@dotfilesConfig@", str(project_path))
        config_path.write_text(rendered + f'\n[projects.{json.dumps(str(cwd))}]\ntrust_level = "trusted"\n')
        shutil.copytree(ROOT / "nix/home/configs/codex/agents", codex_home / "agents")
        environment = dict(os.environ, CODEX_HOME=str(codex_home), HOME=str(base / "home"))
        Path(environment["HOME"]).mkdir()
        for key in ("OPENAI_API_KEY", "CODEX_API_KEY", "CHATGPT_API_KEY"):
            environment.pop(key, None)
        with tempfile.TemporaryFile(mode="w+") as errors:
            process = subprocess.Popen(
                ["codex", "--strict-config", "app-server", "--listen", "stdio://"],
                cwd=cwd, env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=errors, text=True, start_new_session=True,
            )
            replies = queue.Queue()
            reader = threading.Thread(target=read_responses, args=(process.stdout, replies), daemon=True)
            reader.start()
            try:
                request(process, replies, 1, "initialize", {
                    "clientInfo": {"name": "codex-config-check", "version": "1"},
                    "capabilities": {"experimentalApi": True},
                })
                process.stdin.write('{"method":"initialized"}\n')
                process.stdin.flush()
                loaded = request(process, replies, 2, "config/read", {"cwd": str(cwd), "includeLayers": False})["config"]
                for key in ("default_subagent_model", "default_subagent_reasoning_effort"):
                    if loaded["agents"].get(key) != config["agents"][key]:
                        raise RuntimeError(f"Codex did not load agents.{key}: {loaded['agents'].get(key)!r}")
                entries = request(process, replies, 3, "hooks/list", {"cwds": [str(cwd)]})["data"]
                entry = next(item for item in entries if item["cwd"] == str(cwd))
                if entry["warnings"] or entry["errors"]:
                    raise RuntimeError(f"hooks/list: {entry['warnings']} {entry['errors']}")
                actual = collections.Counter((hook["eventName"], hook.get("matcher"), hook["command"]) for hook in entry["hooks"])
                if actual != expected:
                    raise RuntimeError(f"hook declarations differ: missing={expected - actual}, extra={actual - expected}")
                for hook in entry["hooks"]:
                    if not hook["enabled"] or hook["trustStatus"] != "trusted":
                        raise RuntimeError(f"hook is disabled or untrusted: {hook['command']}; currentHash={hook['currentHash']}")
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait(timeout=2)
                reader.join(timeout=1)
                errors.seek(0)
                diagnostics = errors.read().strip()
                if diagnostics:
                    print(diagnostics, file=sys.stderr)
                process.stdin.close()
                process.stdout.close()
            if diagnostics:
                raise RuntimeError("app-server emitted diagnostics shown above")
    return sum(expected.values())


if __name__ == "__main__":
    try:
        count = check()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"codex config check: FAIL: {error}", file=sys.stderr)
        sys.exit(1)
    print(f"codex config check: ok ({count} trusted hooks)")
