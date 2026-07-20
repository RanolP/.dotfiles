#!/usr/bin/env python3
"""Multi-event hook: hard-enforce the `ask:` = explain-only rule.

Wired to two events in settings.json, dispatched on hook_event_name:

  UserPromptSubmit : a prompt starting with `ask:` (leading whitespace ok,
      case-insensitive) drops a per-session flag file and prints a text-only
      reminder (plain UserPromptSubmit stdout is model-visible context). Any
      other prompt clears the flag, ending the text-only turn.
  PreToolUse (matcher *) : while the flag exists, EVERY tool call is denied,
      so "never call any tool" holds mechanically instead of by goodwill.

Fail-open on parse problems -- a bug here must never block normal work.

Self-check: `python3 ask-mode-guard.py --selftest`.
"""
import json
import os
import re
import signal
import sys
import tempfile

ASK_RE = re.compile(r"^\s*ask:", re.IGNORECASE)

CONTEXT = (
    "ask-mode-guard: this is an `ask:` turn -- answer with text only. Every "
    "tool call is blocked until the next user prompt."
)

DENY = (
    "ask: turn -- tools are blocked; explain with text only. If action is "
    "genuinely required, tell the user to resend the request without the "
    "`ask:` prefix."
)


def flag_path(session_id):
    slug = re.sub(r"[^A-Za-z0-9._-]", "_", session_id or "default")
    return os.path.join(tempfile.gettempdir(), f"claude-ask-mode-{slug}")


def handle(data):
    """Returns (stdout_text_or_None, flag_should_exist_after)."""
    event = data.get("hook_event_name", "")
    path = flag_path(data.get("session_id", ""))

    if event == "UserPromptSubmit":
        if ASK_RE.match(data.get("prompt", "") or ""):
            with open(path, "w") as fh:
                fh.write("1")
            return CONTEXT, True
        try:
            os.remove(path)
        except OSError:
            pass
        return None, False

    if event == "PreToolUse" and os.path.exists(path):
        return json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": DENY,
        }}), True

    return None, os.path.exists(path)


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
        out, _ = handle(data)
    except Exception:
        sys.exit(0)  # fail-open
    if out:
        print(out)
    sys.exit(0)


def selftest():
    sid = "selftest-ask-mode"
    try:
        os.remove(flag_path(sid))
    except OSError:
        pass

    def ev(**kw):
        return {"session_id": sid, **kw}

    # No flag -> tools pass.
    assert handle(ev(hook_event_name="PreToolUse")) == (None, False)
    # ask: prompt sets the flag and injects context; tools are denied.
    out, _ = handle(ev(hook_event_name="UserPromptSubmit", prompt="ask: why?"))
    assert out == CONTEXT
    out, _ = handle(ev(hook_event_name="PreToolUse", tool_name="Bash"))
    assert json.loads(out)["hookSpecificOutput"]["permissionDecision"] == "deny"
    # Case/whitespace variants match; a plain prompt clears the flag.
    assert handle(ev(hook_event_name="UserPromptSubmit", prompt="  ASK: hm"))[0] == CONTEXT
    assert handle(ev(hook_event_name="UserPromptSubmit", prompt="fix the bug")) == (None, False)
    assert handle(ev(hook_event_name="PreToolUse")) == (None, False)
    # "ask" without the colon-prefix shape does not trigger.
    assert handle(ev(hook_event_name="UserPromptSubmit", prompt="task: run it")) == (None, False)
    print("ask-mode-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
