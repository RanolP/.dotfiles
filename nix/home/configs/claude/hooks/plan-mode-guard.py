#!/usr/bin/env python3
"""Plan mode is transcribe-only: the plan is finished in auto mode BEFORE
EnterPlanMode, and plan mode exists only to carry that finished text out. So
every tool is denied here except writing the plan file and ExitPlanMode.
AskUserQuestion stays available for requirement clarification, and ToolSearch
for loading the deferred ExitPlanMode schema -- without it a session already in
plan mode could never exit.

Read-only lookups are denied too, Read and Grep included. They were once open
on the theory that distilling a plan surfaces gaps and reading one file is
cheaper than leaving and re-entering. That theory is wrong for the purpose:
removing context is what a handoff is for, and every file read inside plan mode
puts back some of what the reset was supposed to drop. A gap found here means
the research was unfinished, so the answer is to exit, research in auto mode,
and re-enter with the plan complete.

A Write/Edit of the plan file itself is auto-allowed rather than merely
permitted: distilling the plan is the ONE thing plan mode is for, so prompting
for it is pure friction. Any other Write/Edit still falls through to the normal
permission flow. Read of that same file is the one lookup left open -- see the
comment on the Read branch in main().

The plan directory is per auth profile, so it is resolved rather than fixed.
`ccc <profile>` (nix/home/configs/nushell/config.nu) runs claude under
CLAUDE_CONFIG_DIR=~/.claude-<profile>, and plans land in that dir's plans/.
Pinning this to ~/.claude/plans/ made the auto-allow dead code under every
profile: measured 2026-08-31, ~/.claude/plans held 7 files against 37 in
~/.claude-personal/plans. The write then fell into the normal permission flow,
Write demanded a prior Read of a file it had just created, and the turn ended
inside plan mode with ExitPlanMode never called -- 4 of the 5 abandoned plan
files found across 1491 transcripts, ~8k tokens of finished plan discarded.

CLAUDE_CONFIG_DIR is read when present, and any ~/.claude*/plans/ is accepted
too so the guard still works if the hook is spawned without that variable.

The plan-file write is also budgeted. The handoff skill asked for ~100 lines of
short English as prose, and prose was not obeyed, so the write is denied when
the resulting document exceeds MAX_LINES or MAX_BYTES, or when Hangul makes up
MAX_HANGUL_RATIO or more of the letters outside the `## User constraints`
section (which quotes the user verbatim) and outside ``` fences. For Edit the
size is measured on the file with the replacement applied and the language on
`new_string` alone. The deny reason names the measured numbers and the fix.
Any exception in this check falls through to the existing allow.

Self-check: `python3 plan-mode-guard.py --selftest`.
"""

import json
import os
import re
import sys

# Budget for the handoff plan file. Measured 2026-09-21 over the 8 most recent
# files in ~/.claude-personal/plans: 55-123 lines, 5.8-13.5 KB, and 60-80% of
# their lines carried Hangul, against a prose budget of ~100 lines of English.
MAX_LINES = 100
MAX_BYTES = 8000
MAX_HANGUL_RATIO = 0.03

VERBATIM_SECTION = "## User constraints"
HANGUL = re.compile(r"[가-힣ㄱ-ㆎ]")

# ToolSearch is here for one reason only: ExitPlanMode is a deferred tool, so a
# session that entered plan mode without its schema loaded needs the search to
# be able to leave at all.
ALLOWED = frozenset({
    "ExitPlanMode",
    "Write",
    "Edit",
    "AskUserQuestion",
    "ToolSearch",
})


def config_plans_dir(env):
    """The active profile's plans/, from CLAUDE_CONFIG_DIR when it is set."""
    cfg = (env or {}).get("CLAUDE_CONFIG_DIR", "")
    if not cfg:
        return None
    return os.path.join(
        os.path.normpath(os.path.expanduser(cfg)), "plans"
    ) + os.sep


def is_profile_plans_dir(dir_path, home):
    """True for ~/.claude/plans and every ~/.claude-<profile>/plans."""
    parent, base = os.path.split(dir_path)
    if base != "plans":
        return False
    grandparent, profile = os.path.split(parent)
    if grandparent != home:
        return False
    return profile == ".claude" or profile.startswith(".claude-")


def is_plan_file(file_path, cwd, env=None, home=None):
    if not file_path:
        return False
    home = os.path.normpath(home or os.path.expanduser("~"))
    p = os.path.expanduser(file_path)
    if not os.path.isabs(p):
        p = os.path.join(cwd or os.getcwd(), p)
    p = os.path.normpath(p)
    active = config_plans_dir(env if env is not None else os.environ)
    if active and p.startswith(active):
        return True
    # A plan file sits directly in the plans dir, so its parent is that dir.
    return is_profile_plans_dir(os.path.dirname(p), home)


def decide(decision, reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))


def checkable_text(text):
    """The document minus the verbatim section and every ``` fence."""
    kept = []
    in_fence = False
    in_verbatim = False
    for line in text.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if line.startswith("## "):
            in_verbatim = line.rstrip() == VERBATIM_SECTION
            continue
        if not in_verbatim:
            kept.append(line)
    return "\n".join(kept)


def hangul_ratio(text):
    """Hangul share of all letters in text, or 0.0 when there are none."""
    hangul = len(HANGUL.findall(text))
    letters = hangul + sum(
        1 for c in text if c.isalpha() and not HANGUL.match(c)
    )
    return hangul / letters if letters else 0.0


def budget_violation(size_text, lang_text=None):
    """The deny reason when the plan breaks the budget, else None.

    size_text is the whole document as it will exist after the write;
    lang_text is the newly written text (the whole doc for Write, new_string
    for Edit), defaulting to size_text. None for size_text skips the size
    check, which is how an unreadable Edit target fails open.
    """
    if lang_text is None:
        lang_text = size_text
    problems = []
    if size_text is not None:
        lines = len(size_text.splitlines())
        nbytes = len(size_text.encode("utf-8"))
        if lines > MAX_LINES or nbytes > MAX_BYTES:
            problems.append(
                f"{lines} lines / {nbytes:,} bytes "
                f"(budget: {MAX_LINES} lines, {MAX_BYTES:,} bytes)"
            )
    ratio = hangul_ratio(checkable_text(lang_text))
    if ratio >= MAX_HANGUL_RATIO:
        problems.append(
            f"{ratio:.0%} Hangul outside {VERBATIM_SECTION} "
            f"(budget: <{MAX_HANGUL_RATIO:.0%})"
        )
    if not problems:
        return None
    return (
        "Handoff plan is " + " and ".join(problems) + ". Rewrite in short "
        "English -- isolated bullets, 3-5 sentences per entry -- then Write "
        "again. Korean stays only in verbatim quotes under "
        f"{VERBATIM_SECTION} and inside code fences."
    )


def plan_write_violation(tool, tool_input, cwd):
    """budget_violation() applied to a Write or Edit payload."""
    if tool == "Write":
        return budget_violation(tool_input.get("content", ""))
    new = tool_input.get("new_string", "")
    old = tool_input.get("old_string", "")
    path = os.path.expanduser(tool_input.get("file_path", ""))
    if not os.path.isabs(path):
        path = os.path.join(cwd or os.getcwd(), path)
    try:
        with open(path, encoding="utf-8") as f:
            current = f.read()
    except OSError:
        return budget_violation(None, new)
    if tool_input.get("replace_all"):
        result = current.replace(old, new)
    else:
        result = current.replace(old, new, 1)
    return budget_violation(result, new)


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    # A non-object payload has no fields to read; staying silent leaves the
    # call to the normal permission flow, where a crash would leave it
    # unguarded instead.
    if not isinstance(data, dict):
        return
    if data.get("permission_mode") != "plan":
        return
    tool = data.get("tool_name", "")
    tool_input = data.get("tool_input", {}) or {}
    if tool in ("Write", "Edit") and is_plan_file(
        tool_input.get("file_path", ""), data.get("cwd")
    ):
        try:
            reason = plan_write_violation(tool, tool_input, data.get("cwd"))
        except Exception:
            reason = None
        if reason:
            decide("deny", reason)
            return
        decide("allow", "Writing the plan file is what plan mode is for.")
        return
    # Write/Edit refuse to touch an existing file this context has not Read, so
    # denying Read outright deadlocks the second EnterPlanMode of a session: the
    # plan path is reused and already on disk, Write demands a Read, and the
    # Read is denied. Reading back the plan file is distillation, not research.
    if tool == "Read" and is_plan_file(
        (data.get("tool_input", {}) or {}).get("file_path", ""), data.get("cwd")
    ):
        return
    if tool in ALLOWED:
        return
    decide("deny", (
        f"Plan mode is transcribe-only and {tool} is blocked here -- "
        "every lookup, read and search happens BEFORE EnterPlanMode, "
        "because clearing context is what this mode is for. Write the "
        "already-drafted plan file and call ExitPlanMode now. If the "
        "research is genuinely missing, present what you have and let "
        "the user redirect."
    ))


def selftest():
    home = os.path.expanduser("~")
    none = {}
    assert is_plan_file(home + "/.claude/plans/eager-skipping-turtle.md", None, none)
    assert is_plan_file("~/.claude/plans/p.md", None, none)
    assert is_plan_file("plans/p.md", home + "/.claude", none)
    assert not is_plan_file(home + "/.claude/plans", None, none)  # the dir itself
    assert not is_plan_file(home + "/.claude/settings.json", None, none)
    assert not is_plan_file(home + "/.dotfiles/nix/flake.nix", None, none)
    assert not is_plan_file("", None, none)

    # Every `ccc <profile>` dir counts, with or without CLAUDE_CONFIG_DIR set.
    assert is_plan_file(home + "/.claude-personal/plans/p.md", None, none)
    assert is_plan_file(home + "/.claude-work/plans/p.md", None, none)
    profile = {"CLAUDE_CONFIG_DIR": home + "/.claude-personal"}
    assert is_plan_file(home + "/.claude-personal/plans/p.md", None, profile)
    assert is_plan_file("~/.claude-personal/plans/p.md", None, profile)
    # The default dir stays allowed while a profile is active.
    assert is_plan_file(home + "/.claude/plans/p.md", None, profile)
    # A profile dir outside $HOME is reachable only through the env var.
    elsewhere = {"CLAUDE_CONFIG_DIR": "/opt/claude-alt"}
    assert is_plan_file("/opt/claude-alt/plans/p.md", None, elsewhere)
    assert not is_plan_file("/opt/claude-alt/plans/p.md", None, none)
    # Neighbours of the plans dir, and lookalike dirs, stay out.
    assert not is_plan_file(home + "/.claude-personal/settings.json", None, none)
    assert not is_plan_file(home + "/.claude-personal/plans/sub/p.md", None, none)
    assert not is_plan_file(home + "/.claudex/plans/p.md", None, none)
    assert not is_plan_file(home + "/proj/.claude/plans/p.md", None, none)
    assert not is_plan_file(home + "/.claude/plans/../settings.json", None, none)
    assert config_plans_dir({}) is None
    assert config_plans_dir(None) is None
    # Only the plan write and the exit survive; every lookup is denied so the
    # context the handoff just dropped cannot be pulled back in.
    assert ALLOWED == {
        "ExitPlanMode", "Write", "Edit", "AskUserQuestion", "ToolSearch"
    }
    for denied in ("Read", "Grep", "Glob", "WebFetch", "WebSearch",
                   "NotebookRead", "TaskGet", "Bash", "Agent"):
        assert denied not in ALLOWED, denied

    # The plan budget: short English passes, size and language breaks deny.
    english = "\n".join(f"- bullet {i} about the resume step" for i in range(50))
    assert budget_violation("# Handoff\n\n" + english) is None
    too_long = "\n".join(f"- line {i}" for i in range(101))
    reason = budget_violation(too_long)
    assert reason and "101 lines" in reason and "100 lines" in reason, reason
    too_big = "- " + "x" * (MAX_BYTES + 1)
    assert "bytes" in budget_violation(too_big)
    quoted = (
        "## Goal\nShip the guard.\n\n## User constraints\n"
        "- \"절대 브랜치 만들지 마\"\n- \"메인에서만 작업해\"\n\n"
        "## Decisions\n- guard over prose -- rejected: prose; why: unread\n"
    )
    assert budget_violation(quoted) is None
    korean_decision = (
        "## Goal\nShip the guard.\n\n## Decisions\n"
        "- 프로즈 대신 가드 -- rejected: prose; why: 안 읽힘\n"
    )
    reason = budget_violation(korean_decision)
    assert reason and "Hangul" in reason and "Decisions" not in reason, reason
    fenced = "## Context\nSee below.\n\n```\n한글 주석이 있는 코드\n```\n"
    assert budget_violation(fenced) is None
    # An Edit is judged on new_string alone, with the size check skipped
    # when the target cannot be read.
    assert budget_violation(None, "- 한글로 쓴 결정") is not None
    assert budget_violation(None, "- decided in English") is None
    assert budget_violation(too_long, "- short and English") is not None
    print("plan-mode-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
