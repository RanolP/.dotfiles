#!/usr/bin/env python3
"""Semantics test for commit-check-guard.py.

The guard denies a `git commit` when a file edited this session has a check
this repo ships and that check never ran after the edit -- the b28bf99 failure,
where a hook was committed without `scripts/verify-claude-hook.sh` and without
its settings.json registration. It stays silent on every non-commit command, on
paths no rule covers, and on anything it cannot read: it fronts every Bash call
in every session, so fail-open is the whole design.

Usage: commit-check-guard-test.py   (exit 0 when every case passes)
"""

import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
HOOK = os.path.join(REPO, "nix", "home", "configs", "claude", "hooks",
                    "commit-check-guard.py")
CWD = os.path.abspath(REPO)


def edit(path):
    return {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Edit",
         "input": {"file_path": os.path.join(CWD, path)}}]}}


def bash(command):
    return {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Bash", "input": {"command": command}}]}}


def run(events, command, transcript=None):
    """Returns the guard's decision, or 'passthrough'/'error(...)'."""
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as fh:
        for e in events:
            fh.write(e if isinstance(e, str) else json.dumps(e))
            fh.write("\n")
        path = fh.name
    try:
        payload = {"tool_name": "Bash", "cwd": CWD,
                   "transcript_path": transcript if transcript is not None else path,
                   "tool_input": {"command": command}}
        p = subprocess.run([sys.executable, HOOK], text=True, capture_output=True,
                           timeout=30, input=json.dumps(payload))
    finally:
        os.unlink(path)
    if p.returncode != 0:
        return "error(%d): %s" % (p.returncode, p.stderr.strip()[-200:]), ""
    if not p.stdout.strip():
        return "passthrough", ""
    out = json.loads(p.stdout)["hookSpecificOutput"]
    return out["permissionDecision"], out["permissionDecisionReason"]


HOOK_PATH = "nix/home/configs/claude/hooks/declarative-package-guard.py"
NEW_HOOK = "nix/home/configs/claude/hooks/brand-new-guard.py"
VERIFY = "./scripts/verify-claude-hook.sh " + NEW_HOOK
BUILD = "cd ~/.dotfiles/nix && nix build .#darwinConfigurations.ranolp-work-MBP-26.system --no-link"

# Every hook file also sits under nix/, so the build rule applies to it as well
# as the verify rule -- a passthrough case has to satisfy both.
CASES = [
    # the b28bf99 incident itself
    ("hook edit, no verify", [edit(NEW_HOOK)], "git commit -m x", "deny"),
    ("hook edit, verify + build", [edit(NEW_HOOK), bash(VERIFY), bash(BUILD)],
     "git commit -m x", "passthrough"),
    ("hook edit, build but no verify", [edit(NEW_HOOK), bash(BUILD)], "git commit -m x", "deny"),
    ("verify before the edit", [bash(VERIFY), edit(NEW_HOOK), bash(BUILD)], "git commit -m x",
     "deny"),

    ("nix edit then build", [edit("nix/home/default.nix"), bash(BUILD)], "git commit -m x",
     "passthrough"),
    ("nix edit, build ran first", [bash(BUILD), edit("nix/home/default.nix")], "git commit -m x",
     "deny"),
    ("nix edit, darwin-rebuild", [edit("nix/home/default.nix"),
                                  bash("sudo darwin-rebuild switch --flake ~/.dotfiles/nix#h")],
     "git commit -m x", "passthrough"),
    ("nix edit, no build", [edit("nix/home/default.nix")], "git commit -m x", "deny"),

    # a hook with a sibling test needs the test too
    ("hook edit, verify only", [edit(HOOK_PATH), bash("./scripts/verify-claude-hook.sh " + HOOK_PATH)],
     "git commit -m x", "deny"),
    ("hook edit, verify + test + build",
     [edit(HOOK_PATH), bash("./scripts/verify-claude-hook.sh " + HOOK_PATH),
      bash("python3 scripts/declarative-package-guard-test.py"), bash(BUILD)],
     "git commit -m x", "passthrough"),

    # not a commit, or nothing a rule covers
    ("non-commit command", [edit(NEW_HOOK)], "git status", "passthrough"),
    ("git add is not a commit", [edit(NEW_HOOK)], "git add -A", "passthrough"),
    ("unrelated path", [edit("README.md")], "git commit -m x", "passthrough"),
    ("empty transcript", [], "git commit -m x", "passthrough"),

    # commit spellings the guard still has to recognize
    ("git -C path commit", [edit(NEW_HOOK)], "git -C /Users/ranolp/.dotfiles commit -m x", "deny"),
    ("git commit -am", [edit(NEW_HOOK)], "git commit -am x", "deny"),
    ("commit in a second segment", [edit(NEW_HOOK)], "git add -A && git commit -m x", "deny"),
    ("in-flight build satisfies", [edit("nix/home/default.nix")], BUILD + " && git commit -m x",
     "passthrough"),

    # fail open
    ("unterminated quote", [edit(NEW_HOOK)], "git commit -m 'unclosed", "passthrough"),
    ("commit word inside quotes", [edit(NEW_HOOK)], "echo 'git commit -m x'", "passthrough"),
    ("empty command", [edit(NEW_HOOK)], "", "passthrough"),
]


def main():
    failures = 0
    for name, events, command, want in CASES:
        got, _ = run(events, command)
        ok = got == want
        failures += not ok
        print("%s  %-34s want=%-11s got=%s" % ("ok  " if ok else "FAIL", name, want, got))

    # A missing transcript file must never be treated as "nothing was checked".
    got, _ = run([edit(NEW_HOOK)], "git commit -m x",
                 transcript="/nonexistent/transcript-does-not-exist.jsonl")
    ok = got == "passthrough"
    failures += not ok
    print("%s  %-34s want=%-11s got=%s" % ("ok  " if ok else "FAIL", "missing transcript",
                                           "passthrough", got))

    # A truncated write mid-session leaves a half line; the good lines still count.
    got, _ = run(['{"type": "assistant", "message": {"content": [{"type": "tool_use"',
                  edit(NEW_HOOK), "not json at all", bash(VERIFY), bash(BUILD)],
                 "git commit -m x")
    ok = got == "passthrough"
    failures += not ok
    print("%s  %-34s want=%-11s got=%s" % ("ok  " if ok else "FAIL", "malformed line among good",
                                           "passthrough", got))

    got, _ = run(['{"type": "assistant", "message": {"content": [{"type": "tool_use"',
                  edit(NEW_HOOK)], "git commit -m x")
    ok = got == "deny"
    failures += not ok
    print("%s  %-34s want=%-11s got=%s" % ("ok  " if ok else "FAIL", "malformed line, edit stands",
                                           "deny", got))

    # A deny is only useful if it names the command to run.
    _, text = run([edit(NEW_HOOK)], "git commit -m x")
    for needle in ("./scripts/verify-claude-hook.sh", "nix/home/default.nix",
                   "settings.json", "b28bf99"):
        ok = needle in text
        failures += not ok
        print("%s  b28bf99 deny reason names %s" % ("ok  " if ok else "FAIL", needle))

    total = len(CASES) + 3 + 4
    print("%d/%d passed" % (total - failures, total))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
