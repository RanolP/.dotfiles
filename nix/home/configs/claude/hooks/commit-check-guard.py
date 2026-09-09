#!/usr/bin/env python3
"""PreToolUse guard: a file this repo ships a check for is committed only after that check ran.

Incident (commit b28bf99): the commit added
`nix/home/configs/claude/hooks/declarative-package-guard.py` and its
`nix/home/default.nix` entry, but never registered the hook in
`nix/home/configs/claude/settings.json`. The guard sat deployed-but-inert for
weeks, and nothing caught it -- the repo already ships
`scripts/verify-claude-hook.sh`, whose output would have made the missing
registration obvious, and no one ran it.

So the check is attached to the commit instead of to goodwill. This hook reads
the session transcript, learns which files were edited and which Bash commands
ran, and denies a `git commit` when an edited file's check never ran after that
file's last edit. An earlier run does not count: it measured the file as it was
before the edit.

Rules are deliberately three and no more. Each names the exact command to run,
because a deny that only says "you skipped a check" costs a round-trip to
discover which one.

Parsing reuses `declarative-package-guard.py`'s single-pass, O(n), quote-aware
tokenizer. That shape is deliberate: an earlier regex-based command parser in
`git-push-guard.py` could ReDoS for minutes on a long command whose quoted text
held a shell operator, hanging every Bash call on the machine.

Fail open, always. A `PreToolUse` hook on the `Bash` matcher runs in front of
every Bash call in every session, so an unreadable transcript, an unterminated
quote, a path outside the session's cwd, or any unexpected exception allows the
call. A false deny costs more than a missed check.

Self-check: `python3 scripts/commit-check-guard-test.py`.
"""
import json
import os
import sys

# Wrappers that sit in front of the real command without changing what it does.
WRAPPERS = {"sudo", "command", "env", "nohup", "nice", "time", "doas", "exec"}

# Git's own options that consume the following token, so `git -C <path> commit`
# still reads as a commit.
GIT_OPTS_WITH_ARG = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}

HOOK_DIR = "nix/home/configs/claude/hooks/"

VERIFY_MSG = (
    "%s is a Claude Code hook and `scripts/verify-claude-hook.sh` never ran after the "
    "last edit. A PreToolUse hook fronts every Bash call in every session, so an "
    "unverified one is a total work stoppage that only a rebuild can lift.\n"
    "  Run: ./scripts/verify-claude-hook.sh %s\n"
    "  Then confirm the hook is BOTH declared and registered -- its own "
    "`\".claude/hooks/<name>.py\"` entry in nix/home/default.nix AND its command entry "
    "in nix/home/configs/claude/settings.json. Commit b28bf99 shipped the first without "
    "the second and left the guard deployed-but-inert for weeks."
)

TEST_MSG = (
    "%s has a sibling semantics test that never ran after the last edit.\n"
    "  Run: python3 %s"
)

BUILD_MSG = (
    "These files are under nix/ and the flake never built after their last edit: %s. "
    "--dry-run is blind "
    "to a hash mismatch, an eval error, or a failing builder, so only the real build "
    "proves the generation is green.\n"
    "  Run: cd ~/.dotfiles/nix && nix build .#darwinConfigurations.ranolp-work-MBP-26.system --no-link"
)


def decide(decision, reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def parse_segments(command):
    """Single-pass, O(n) split of a shell command into operator-separated
    segments of whitespace-separated tokens.

    Walks the string once, tracking quote/backslash state so the control
    operators `&& || ; & |` split a segment ONLY when they appear outside
    quotes. Quote characters are consumed (tokens hold the unquoted value, like
    `shlex.split`). Never backtracks, so it cannot ReDoS.

    Returns a list of {"tokens": [...], "parse_error": bool}; parse_error marks
    an unterminated quote so the caller can fail open on that segment.
    """
    segments = []
    tokens = []
    tok = []
    tok_started = False
    seg_error = False

    def flush_token():
        nonlocal tok, tok_started
        if tok_started:
            tokens.append("".join(tok))
        tok = []
        tok_started = False

    def flush_segment():
        nonlocal tokens, seg_error
        flush_token()
        segments.append({"tokens": tokens, "parse_error": seg_error})
        tokens = []
        seg_error = False

    i, n = 0, len(command)
    while i < n:
        c = command[i]
        if c == "'":
            tok_started = True
            i += 1
            while i < n and command[i] != "'":
                tok.append(command[i])
                i += 1
            if i >= n:
                seg_error = True
            else:
                i += 1
            continue
        if c == '"':
            tok_started = True
            i += 1
            while i < n and command[i] != '"':
                if command[i] == "\\" and i + 1 < n and command[i + 1] in ('"', "\\", "$", "`"):
                    tok.append(command[i + 1])
                    i += 2
                else:
                    tok.append(command[i])
                    i += 1
            if i >= n:
                seg_error = True
            else:
                i += 1
            continue
        if c == "\\":
            tok_started = True
            if i + 1 < n:
                tok.append(command[i + 1])
                i += 2
            else:
                tok.append(c)
                i += 1
            continue
        if c in " \t\n\r":
            flush_token()
            i += 1
            continue
        if command[i:i + 2] in ("&&", "||"):
            flush_segment()
            i += 2
            continue
        if c in (";", "&", "|"):
            flush_segment()
            i += 1
            continue
        tok_started = True
        tok.append(c)
        i += 1

    flush_segment()
    return segments


def _is_name_char(ch):
    return ch == "_" or ("a" <= ch <= "z") or ("A" <= ch <= "Z") or ("0" <= ch <= "9")


def is_env_assign(tok):
    """True for a leading `NAME=value` shell env assignment (ASCII NAME)."""
    eq = tok.find("=")
    if eq <= 0:
        return False
    first = tok[0]
    if not (first == "_" or ("a" <= first <= "z") or ("A" <= first <= "Z")):
        return False
    return all(_is_name_char(c) for c in tok[:eq])


def base(tok):
    return tok.rsplit("/", 1)[-1]


def strip_prefix(toks):
    """Drop env assignments and command wrappers, so `sudo -E git ...` reads as `git ...`."""
    i = 0
    while i < len(toks):
        if is_env_assign(toks[i]):
            i += 1
            continue
        if base(toks[i]) in WRAPPERS:
            i += 1
            while i < len(toks) and toks[i].startswith("-"):
                i += 1
            continue
        break
    return toks[i:]


def is_git_commit(toks):
    toks = strip_prefix(toks)
    if not toks or base(toks[0]) != "git":
        return False
    i = 1
    while i < len(toks):
        t = toks[i]
        if t in GIT_OPTS_WITH_ARG:
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        return t == "commit"
    return False


def command_is_commit(command):
    for seg in parse_segments(command):
        if seg["parse_error"]:
            continue
        if is_git_commit(seg["tokens"]):
            return True
    return False


def relativize(path, cwd):
    """Repo-relative form of an edited path, or None when it sits outside the session."""
    if not isinstance(path, str) or not path:
        return None
    if not os.path.isabs(path):
        rel = os.path.normpath(path)
        return None if rel.startswith("..") else rel
    if not cwd:
        return None
    rel = os.path.relpath(os.path.normpath(path), os.path.normpath(cwd))
    if rel.startswith(".."):
        return None
    return rel


def scan_transcript(path, cwd):
    """Ordered session history: {rel_path: last_edit_index} and [(index, command)].

    Streams the file once. Lines are prefiltered on the `tool_use` marker before
    they are parsed, because a long session's transcript reaches tens of MB and
    this runs in front of every Bash call.
    """
    edits = {}
    commands = []
    index = 0
    with open(path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            if '"tool_use"' not in line:
                continue
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            message = entry.get("message")
            if not isinstance(message, dict):
                continue
            content = message.get("content")
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict) or block.get("type") != "tool_use":
                    continue
                name = block.get("name")
                params = block.get("input")
                if not isinstance(params, dict):
                    continue
                index += 1
                if name == "Bash":
                    cmd = params.get("command")
                    if isinstance(cmd, str):
                        commands.append((index, cmd))
                elif name in ("Edit", "Write", "NotebookEdit"):
                    raw = params.get("file_path") or params.get("notebook_path")
                    rel = relativize(raw, cwd)
                    if rel:
                        edits[rel] = index
    return edits, commands


def rules_for(rel, cwd):
    """Check rules that apply to one edited path, as (needles, message)."""
    rules = []
    is_hook = rel.startswith(HOOK_DIR) and rel.endswith(".py")

    if is_hook:
        rules.append((("verify-claude-hook.sh",), VERIFY_MSG % (rel, rel)))

    if rel.endswith(".py") and (is_hook or rel.startswith("scripts/")):
        test = "scripts/%s-test.py" % os.path.basename(rel)[:-3]
        if cwd and os.path.isfile(os.path.join(cwd, test)):
            rules.append(((os.path.basename(test),), TEST_MSG % (rel, test)))

    return rules


BUILD_NEEDLES = ("nix build", "darwin-rebuild", "home-manager switch")


def violations(edits, commands, cwd):
    """Per-file check failures, plus the flake build collapsed into one message.

    The build covers the whole generation rather than one file, so repeating it
    per edited path would bury the per-file failures under identical prose.
    """
    found = []
    unbuilt = []
    for rel in sorted(edits):
        after = [cmd for idx, cmd in commands if idx > edits[rel]]
        satisfied = lambda needles: any(n in cmd for cmd in after for n in needles)
        for needles, message in rules_for(rel, cwd):
            if not satisfied(needles):
                found.append(message)
        if rel.startswith("nix/") and not satisfied(BUILD_NEEDLES):
            unbuilt.append(rel)
    if unbuilt:
        found.append(BUILD_MSG % ", ".join(unbuilt))
    return found


def main():
    data = json.load(sys.stdin)
    if not isinstance(data, dict):
        return
    command = data.get("tool_input", {}).get("command", "")
    if not isinstance(command, str) or not command.strip():
        return
    if not command_is_commit(command):
        return

    transcript = data.get("transcript_path")
    if not isinstance(transcript, str) or not os.path.isfile(transcript):
        return
    cwd = data.get("cwd")
    if not isinstance(cwd, str):
        cwd = None

    edits, commands = scan_transcript(transcript, cwd)
    # The in-flight command counts as the newest event, so `nix build && git
    # commit` satisfies its own rule whether or not the transcript holds it yet.
    last = max([i for i, _ in commands] + list(edits.values()) + [0])
    commands.append((last + 1, command))

    found = violations(edits, commands, cwd)
    if found:
        decide("deny", "A check this repo ships never ran after the file it checks was "
                       "edited. Run it, then commit.\n\n" + "\n\n".join(found))


try:
    main()
except SystemExit:
    raise
except BaseException:
    pass
sys.exit(0)
