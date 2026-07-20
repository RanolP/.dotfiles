#!/usr/bin/env python3
"""Multi-event hook: make "rebuild after dotfiles edits" a gate, not a hint.

Wired to three events in settings.json, dispatched on hook_event_name:

  PostToolUse Edit|Write : an edit under ~/.dotfiles/nix/home/configs/ marks
      the session "rebuild pending" and, on the FIRST pending edit, injects an
      additionalContext reminder. (Plain PostToolUse stdout is debug-log-only;
      only the JSON hookSpecificOutput form reaches Claude -- the previous
      inline reminder in settings.json printed plain text and was invisible.)
  PostToolUse Bash       : a `darwin-rebuild ... switch` invocation clears the
      pending state. Attempt-based: tool_response carries no reliable exit
      status, so a failed rebuild also clears -- the failure output itself is
      in context for Claude to act on.
  Stop                   : while edits are pending, block the stop ONCE with
      the rebuild command as the reason. stop_hook_active plus a nagged
      timestamp prevent loops and per-turn nagging: it re-blocks only after a
      NEW edit lands.

State is one JSON file per session under $TMPDIR. Fail-open everywhere -- a
bug here must never wedge a session.

Self-check: `python3 rebuild-enforcer.py --selftest`.
"""
import json
import os
import re
import shlex
import signal
import sys
import tempfile
import time

CONFIGS_DIR = os.path.expanduser("~/.dotfiles/nix/home/configs") + os.sep
REBUILD_CMD = "sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26"


def state_path(session_id):
    slug = re.sub(r"[^A-Za-z0-9._-]", "_", session_id or "default")
    return os.path.join(tempfile.gettempdir(), f"claude-rebuild-state-{slug}.json")


def load_state(path):
    try:
        with open(path) as fh:
            st = json.load(fh)
        if isinstance(st, dict):
            return st
    except (OSError, ValueError):
        pass
    return {"last_edit": 0, "last_rebuild": 0, "nagged_at": 0, "files": []}


def save_state(path, st):
    try:
        with open(path, "w") as fh:
            json.dump(st, fh)
    except OSError:
        pass


def is_config_edit(file_path):
    if not file_path:
        return False
    p = os.path.normpath(os.path.expanduser(file_path))
    return p.startswith(CONFIGS_DIR)


def is_rebuild(command):
    """True when the command invokes the darwin-rebuild `switch` subcommand."""
    try:
        toks = shlex.split(command or "")
    except ValueError:
        return False
    return any(t.rsplit("/", 1)[-1] == "darwin-rebuild" for t in toks) and "switch" in toks


def pending(st):
    return st["last_edit"] > st["last_rebuild"]


def emit(payload):
    print(json.dumps(payload))


def handle(data, now):
    """Process one hook event; returns the JSON payload to emit, or None."""
    event = data.get("hook_event_name", "")
    path = state_path(data.get("session_id", ""))
    st = load_state(path)

    if event == "PostToolUse":
        tool = data.get("tool_name", "")
        ti = data.get("tool_input", {}) or {}
        if tool in ("Edit", "Write") and is_config_edit(ti.get("file_path", "")):
            first = not pending(st)
            st["last_edit"] = now
            rel = os.path.normpath(os.path.expanduser(ti["file_path"]))[len(CONFIGS_DIR):]
            if rel not in st["files"]:
                st["files"].append(rel)
            save_state(path, st)
            if first:
                return {"hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "additionalContext": (
                        "nix config edited -- changes apply only after "
                        f"`{REBUILD_CMD}`. The Stop hook blocks finishing "
                        "while the rebuild is outstanding."),
                }}
        elif tool == "Bash" and is_rebuild(ti.get("command", "")):
            st["last_rebuild"] = now
            st["files"] = []
            save_state(path, st)
        return None

    if event == "Stop":
        if data.get("stop_hook_active"):
            return None
        if pending(st) and st["last_edit"] > st["nagged_at"]:
            st["nagged_at"] = now
            save_state(path, st)
            files = ", ".join(st["files"]) or "files under nix/home/configs/"
            return {"decision": "block", "reason": (
                f"Edited without applying: {files}. Run `{REBUILD_CMD}` now, "
                "or -- if the user deferred the rebuild -- state that it is "
                "pending and stop.")}
        return None

    return None


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

    try:
        payload = handle(data, time.time())
    except Exception:
        sys.exit(0)  # fail-open
    if payload:
        emit(payload)
    sys.exit(0)


def selftest():
    sid = "selftest-rebuild-enforcer"
    try:
        os.remove(state_path(sid))
    except OSError:
        pass
    cfg = CONFIGS_DIR + "claude/settings.json"

    def ev(**kw):
        return {"session_id": sid, **kw}

    # An edit outside configs is ignored; stop passes.
    assert handle(ev(hook_event_name="PostToolUse", tool_name="Edit",
                     tool_input={"file_path": "/etc/hosts"}), 1) is None
    assert handle(ev(hook_event_name="Stop"), 2) is None
    # First config edit injects context; second stays silent.
    out = handle(ev(hook_event_name="PostToolUse", tool_name="Write",
                    tool_input={"file_path": cfg}), 3)
    assert out and "additionalContext" in out["hookSpecificOutput"]
    assert handle(ev(hook_event_name="PostToolUse", tool_name="Edit",
                     tool_input={"file_path": cfg}), 4) is None
    # Pending edit blocks stop once, then stays quiet until a new edit.
    out = handle(ev(hook_event_name="Stop"), 5)
    assert out and out["decision"] == "block" and "claude/settings.json" in out["reason"]
    assert handle(ev(hook_event_name="Stop"), 6) is None
    assert handle(ev(hook_event_name="Stop", stop_hook_active=True), 7) is None
    # A new edit re-arms the nag; a rebuild clears it.
    handle(ev(hook_event_name="PostToolUse", tool_name="Edit",
              tool_input={"file_path": cfg}), 8)
    assert handle(ev(hook_event_name="Stop"), 9)["decision"] == "block"
    handle(ev(hook_event_name="PostToolUse", tool_name="Edit",
              tool_input={"file_path": cfg}), 10)
    handle(ev(hook_event_name="PostToolUse", tool_name="Bash",
              tool_input={"command": "sudo darwin-rebuild switch --flake x"}), 11)
    assert handle(ev(hook_event_name="Stop"), 12) is None
    # Rebuild detection.
    assert is_rebuild("sudo darwin-rebuild switch --flake ~/.dotfiles/nix#x")
    assert not is_rebuild("darwin-rebuild build")
    assert not is_rebuild("git switch main")
    os.remove(state_path(sid))
    print("rebuild-enforcer selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
