#!/usr/bin/env python3
"""PreToolUse guard: route UI automation to agent-browser and agent-device.

Two CLIs on PATH cover this ground better than the alternatives Claude reaches
for by reflex:

  agent-browser -- browser automation, including `connect <port|url>` to attach
                   to an already-running Chrome over CDP
  agent-device  -- iOS, Android, macOS, TV and web app UI, plus logs, install,
                   screenshots, perf and React Native helpers

The reflex paths -- the claude-in-chrome MCP tools, and raw `adb` / `xcrun
simctl` / `idb` / `cliclick` -- both raise "ask" ONCE per session. The first
call of each family puts the CLI equivalent in front of the user, so picking the
reflex path is a decision rather than a habit. Every later call of that family
in the same session falls through untouched: a 20-step browser or device task
must not cost 20 prompts, so the reminder fires once and gets out of the way.

A third family covers the CLIs themselves: the first `agent-browser` or
`agent-device` command of a session that drives UI is denied once, with the
`ui-automation` skill inlined, so the model re-plans the whole scenario as ONE
batch call before it starts firing single steps. Reading commands (`help`,
`skills`, `devices`, ...) and an already-batched call pass through.

The three families are tracked separately, so one prompt never swallows another.

Only the LEADING Bash token is checked, after any `NAME=val` env assignments, so
`echo adb`, `grep simctl log.txt`, or a path containing "adb" is left alone.
Fail open on a parse error (no opinion).

Self-check: `python3 agent-tooling-guard.py --selftest`.
"""
import json
import os
import shlex
import sys

CHROME_TOOL_PREFIX = "mcp__claude-in-chrome__"
STATE_DIR = os.path.expanduser("~/.claude-personal/state/agent-tooling-guard")
SKILL_PATH = os.environ.get(
    "AGENT_TOOLING_GUARD_SKILL",
    os.path.expanduser("~/.agents/skills/ui-automation/SKILL.md"),
)

SCENARIO_BINS = ("agent-browser", "agent-device")
# Subcommands that read rather than drive: no scenario to batch.
SCENARIO_EXEMPT = {
    "help", "--help", "-h", "skills", "version", "--version", "-v",
    "devices", "sessions", "doctor", "batch", "replay", "test",
}

# Leading Bash token -> the agent-device command family that replaces it.
DEVICE_BINS = {
    "adb": "agent-device (click/find/type/scroll, logs, install, screenshot, devices)",
    "idb": "agent-device (click/find/type/scroll, screenshot, devices)",
    "cliclick": "agent-device (click <target>, press, longpress)",
    "fbsimctl": "agent-device (boot, devices, install, open)",
    "xcrun simctl": (
        "agent-device (boot, shutdown, devices, install, reinstall, open, "
        "screenshot, record, settings, push, orientation)"
    ),
}

CHROME_REASON = (
    "Review `agent-browser` before taking this one. It is on PATH and covers "
    "this ground: open/click/type/fill/press, snapshot (accessibility tree with "
    "refs), get text|html|value, find by role|text|label|testid, eval, "
    "screenshot, pdf, upload, download, scroll, wait.\n"
    "Start with `agent-browser skills get core --full` -- the skills ship with "
    "the CLI and are version-matched, so they beat guessing from flag docs.\n"
    "To drive the browser the user already has open, attach over CDP with "
    "`agent-browser connect <port|url>` -- that is the usual reason the "
    "extension looked necessary, and it is covered.\n"
    "Approve this call only after saying which agent-browser command you "
    "checked and why it does not fit.\n"
    "(This prompt fires once per session. Later claude-in-chrome calls in this "
    "session pass through under the normal permission rules.)"
)


def device_reason(binary, cmd):
    return (
        f"Review `agent-device` before taking this one. It is on PATH and "
        f"replaces `{binary}`: {DEVICE_BINS[binary]}.\n"
        "Run `agent-device help commands` for the full catalog, and "
        "`agent-device help <command>` for exact flags. `agent-device devices` "
        "lists targets, `agent-device find <query> <action>` is the workhorse, "
        "and `--json` gives parseable output.\n"
        f"The command you are about to run is:\n  {cmd}\n"
        "Approve this call only after saying which agent-device command you "
        "checked and why it does not fit.\n"
        "(This prompt fires once per session. Later adb / simctl / idb / "
        "cliclick calls in this session pass through under the normal "
        "permission rules.)"
    )


def is_env_assign(tok):
    """True for a leading `NAME=value` shell env assignment (ASCII NAME)."""
    eq = tok.find("=")
    if eq <= 0:
        return False
    name = tok[:eq]
    return name[0].isalpha() or name[0] == "_"


def leading_tokens(cmd):
    """The command's leading tokens with env assignments stripped, or []."""
    try:
        toks = shlex.split(cmd)
    except ValueError:
        return []
    while toks and is_env_assign(toks[0]):
        toks.pop(0)
    return toks


def reflex_binary(cmd):
    """Name of the raw device binary this command runs, or None."""
    toks = leading_tokens(cmd)
    if not toks:
        return None
    head = os.path.basename(toks[0])
    if head in DEVICE_BINS:
        return head
    # `xcrun simctl ...` drives simulators; other xcrun subcommands are fine.
    if head == "xcrun" and len(toks) > 1 and toks[1] == "simctl":
        return "xcrun simctl"
    return None


def scenario_binary(cmd):
    """Name of the UI-driving agent-* CLI this command runs, or None."""
    toks = leading_tokens(cmd)
    if not toks:
        return None
    head = os.path.basename(toks[0])
    if head not in SCENARIO_BINS:
        return None
    # A read, a help lookup, or an already-batched call needs no nudge.
    for tok in toks[1:]:
        if tok.startswith("--session") or tok in ("--json", "-j"):
            continue
        return None if tok in SCENARIO_EXEMPT else head
    return None


def read_skill(path):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return ""  # not deployed yet (pre-rebuild): nothing to inject


def decision(kind, reason):
    return {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": kind,
        "permissionDecisionReason": reason,
    }}


def state_path(state_dir, session_id):
    return os.path.join(state_dir, f"{session_id}.json")


def already_asked(state_dir, session_id, family):
    """True once this session has seen the prompt for this tool family."""
    try:
        with open(state_path(state_dir, session_id)) as fh:
            state = json.load(fh)
    except (OSError, ValueError):
        return False
    return family in (state.get("asked") or [])


def mark_asked(state_dir, session_id, family):
    path = state_path(state_dir, session_id)
    try:
        with open(path) as fh:
            state = json.load(fh)
        asked = list(state.get("asked") or [])
    except (OSError, ValueError):
        asked = []
    if family not in asked:
        asked.append(family)
    try:
        os.makedirs(state_dir, exist_ok=True)
        with open(path, "w") as fh:
            json.dump({"asked": asked}, fh)
    except OSError:
        pass  # an unwritable state dir costs one extra prompt, never a block


def ask_once(state_dir, session_id, family, reason):
    """The ask payload the first time this family comes up, then None."""
    if already_asked(state_dir, session_id, family):
        return None
    mark_asked(state_dir, session_id, family)
    return decision("ask", reason)


def handle(data, state_dir=None, skill_path=None):
    """Process one PreToolUse event; returns the payload to emit, or None."""
    tool = data.get("tool_name", "")
    sdir = state_dir or STATE_DIR
    session = data.get("session_id") or "no-session"

    if tool.startswith(CHROME_TOOL_PREFIX):
        return ask_once(sdir, session, "chrome", CHROME_REASON)

    if tool != "Bash":
        return None

    cmd = data.get("tool_input", {}).get("command", "")
    binary = reflex_binary(cmd)
    if binary:
        return ask_once(sdir, session, "device", device_reason(binary, cmd))

    binary = scenario_binary(cmd)
    if binary and not already_asked(sdir, session, "scenario"):
        skill = read_skill(skill_path or SKILL_PATH)
        if not skill:
            return None
        mark_asked(sdir, session, "scenario")
        return decision("deny", (
            "[agent-tooling-guard] ui-automation skill injected -- this "
            f"session's first UI-driving `{binary}` command. A single step per "
            "Bash call puts a model turn between every interaction, so any "
            "timing-bound UX (a toast, an animation, a debounce) is already "
            "gone by the next call. Plan the whole scenario and send it as ONE "
            "batch, per the skill below, then run that batch; it will pass.\n\n"
            + skill))
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open

    out = handle(data)
    if out:
        print(json.dumps(out))
    sys.exit(0)


def selftest():
    import tempfile

    assert reflex_binary("adb shell input tap 100 200") == "adb"
    assert reflex_binary("/usr/local/bin/adb devices") == "adb"
    assert reflex_binary("ANDROID_SERIAL=abc adb logcat") == "adb"
    assert reflex_binary("xcrun simctl list devices") == "xcrun simctl"
    assert reflex_binary("cliclick c:100,200") == "cliclick"
    assert reflex_binary("idb ui tap 10 10") == "idb"
    assert reflex_binary("xcrun --find swift") is None
    assert reflex_binary("echo adb shell") is None
    assert reflex_binary("grep simctl notes.txt") is None
    assert reflex_binary("git status") is None
    assert reflex_binary("") is None
    assert reflex_binary("adb 'unterminated") is None

    with tempfile.TemporaryDirectory() as td:
        def chrome(session):
            return handle({"tool_name": "mcp__claude-in-chrome__computer",
                           "session_id": session}, state_dir=td)

        first = chrome("s1")
        assert first["hookSpecificOutput"]["permissionDecision"] == "ask"
        assert "agent-browser skills get core --full" in \
            first["hookSpecificOutput"]["permissionDecisionReason"]
        # Same session, later calls: silent, no second prompt.
        assert chrome("s1") is None
        assert chrome("s1") is None
        # A different session gets its own single reminder.
        assert chrome("s2") is not None
        assert chrome("s2") is None
        def bash(cmd, session="s1"):
            return handle({"tool_name": "Bash", "session_id": session,
                           "tool_input": {"command": cmd}}, state_dir=td)

        # The device family asks once too, and tracks apart from chrome --
        # session s1 already spent its chrome prompt above.
        first = bash("adb shell input tap 1 2")
        assert first["hookSpecificOutput"]["permissionDecision"] == "ask"
        assert "agent-device help commands" in \
            first["hookSpecificOutput"]["permissionDecisionReason"]
        assert bash("adb devices") is None
        assert bash("xcrun simctl list") is None
        assert bash("cliclick c:1,2") is None
        # s3 has spent neither prompt: the device one still fires on its own.
        assert bash("adb devices", session="s3") is not None
        assert chrome("s3") is not None
        assert bash("adb devices", session="s3") is None
        assert bash("git status") is None
        assert handle({"tool_name": "Read", "tool_input": {}}, state_dir=td) is None

    assert scenario_binary("agent-browser click @e7") == "agent-browser"
    assert scenario_binary("agent-device press 'id=\"ok\"'") == "agent-device"
    assert scenario_binary("agent-browser --session s open /") == "agent-browser"
    assert scenario_binary("agent-device help commands") is None
    assert scenario_binary("agent-browser skills get core --full") is None
    assert scenario_binary("agent-device batch --steps '[]'") is None
    assert scenario_binary("agent-device") is None
    assert scenario_binary("git status") is None

    with tempfile.TemporaryDirectory() as td:
        skill = os.path.join(td, "SKILL.md")
        with open(skill, "w") as fh:
            fh.write("# UI automation\nbatch the scenario\n")

        def ui(cmd, session="s1"):
            return handle({"tool_name": "Bash", "session_id": session,
                           "tool_input": {"command": cmd}},
                          state_dir=td, skill_path=skill)

        first = ui("agent-browser click @e7")
        assert first["hookSpecificOutput"]["permissionDecision"] == "deny"
        assert "batch the scenario" in \
            first["hookSpecificOutput"]["permissionDecisionReason"]
        # The re-run, and every later call this session, passes.
        assert ui("agent-browser click @e7") is None
        assert ui("agent-device press ok") is None
        assert ui("agent-browser click @e7", session="s4") is not None
        # An undeployed skill file blocks nothing.
        assert handle({"tool_name": "Bash", "session_id": "s5",
                       "tool_input": {"command": "agent-browser click @e7"}},
                      state_dir=td, skill_path=os.path.join(td, "gone.md")) is None

    print("agent-tooling-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
