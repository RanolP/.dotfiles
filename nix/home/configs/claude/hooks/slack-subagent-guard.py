#!/usr/bin/env python3
"""PreToolUse guard: only the main session writes to Slack.

A worker spawned through the Agent tool inherits every MCP tool of the
session, the claude.ai Slack bundle included. That bundle has no update- or
delete-message tool, so a send is permanent, and the review path in skill
`slack-messaging` (draft shown in main's reply, sent on the user's go) runs
only in main: a worker's chat never reaches the user before it posts.

Claude Code puts `agent_id` in the hook payload only when the call comes from
a subagent and leaves it absent on the main thread (read off the PreToolUse
input schema in the installed claude 2.1.327). So: a Slack MCP call carrying
`agent_id` is allowed when it is a read (read/search/list/get) and denied
otherwise -- send, schedule, draft, reaction, canvas, list, upload, create.
An unknown Slack tool name from a worker counts as a write, so a new write
tool in the bundle is covered on arrival.

Matcher at registration: `mcp__.*[Ss]lack.*`.

Fail-open on a payload it cannot parse, so a bug here never blocks main.
"""
import json
import sys

READ_PREFIXES = ("slack_read_", "slack_search_", "slack_list_", "slack_get_")

DENY = (
    "Slack writes run from the main session only: this call came from a "
    "subagent (agent_id is set). Put the message text, channel id and "
    "thread_ts in your report instead; main shows the draft to the user and "
    "sends it on their go. Reads (slack_read_*, slack_search_*, slack_list_*, "
    "slack_get_*) stay open to workers."
)


def decision(data):
    """Returns the deny reason, or None to let the call through."""
    if not isinstance(data, dict):
        return None
    name = data.get("tool_name")
    if not isinstance(name, str) or not name.startswith("mcp__"):
        return None
    if "slack" not in name.lower():
        return None
    if not data.get("agent_id"):
        return None  # main thread: the skill's review path governs
    op = name.rsplit("__", 1)[-1].lower()
    # slack_get_file_upload_url reads like a get but opens an upload.
    if op.startswith(READ_PREFIXES) and "upload" not in op:
        return None
    return DENY


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "null")
        reason = decision(data)
        if reason is not None:
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            }))
    except Exception:
        pass  # fail-open: a bug here never blocks a call
    sys.exit(0)


def _selftest():
    """Catches a worker posting to Slack: every write tool from a subagent is
    denied, and reads plus every main-thread call pass."""
    p = "mcp__claude_ai_Slack__"
    sub = {"agent_id": "a1b2"}
    for op in ("slack_send_message", "slack_schedule_message",
               "slack_send_message_draft", "slack_add_reaction",
               "slack_update_canvas", "slack_create_conversation",
               "slack_complete_file_upload", "slack_get_file_upload_url",
               "slack_some_new_tool"):
        assert decision({"tool_name": p + op, **sub}) == DENY, op
        assert decision({"tool_name": p + op}) is None, op
    for op in ("slack_read_thread", "slack_search_users",
               "slack_list_user_channels", "slack_get_reactions"):
        assert decision({"tool_name": p + op, **sub}) is None, op
    assert decision({"tool_name": "Bash", **sub}) is None
    assert decision({"tool_name": p + "slack_send_message", "agent_id": ""}) is None
    assert decision([1, 2]) is None
    # fail-open: a stdin that cannot be read exits 0 with no output
    import io
    from contextlib import redirect_stdout

    class Broken:
        class buffer:
            @staticmethod
            def read():
                raise OSError("stdin closed")
    real_stdin, sys.stdin = sys.stdin, Broken()
    out = io.StringIO()
    try:
        with redirect_stdout(out):
            main()
    except SystemExit as e:
        assert e.code in (0, None), e.code
    finally:
        sys.stdin = real_stdin
    assert out.getvalue() == "", out.getvalue()
    print("all guard checks passed")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        _selftest()
    else:
        main()
