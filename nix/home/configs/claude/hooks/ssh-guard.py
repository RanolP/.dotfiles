#!/usr/bin/env python3
"""PreToolUse guard: hard-deny any Bash command that starts with `ssh`.

ssh may drop into an interactive session or a host-key/password prompt that
hijacks Claude Code's TTY and hangs it. Rather than run it, the guard denies and
promotes the command to the user to run themselves via `! <cmd>` in the prompt,
where their own TTY handles the interaction.

Only the LEADING command token is checked (`^ssh`, after any `NAME=val` env
assignments) -- `scp`, `git ... ssh`, or an ssh mentioned mid-command is left
alone. Fail open on a parse error (no opinion).

Self-check: `python3 ssh-guard.py --selftest`.
"""
import json
import shlex
import signal
import sys


def is_env_assign(tok):
    """True for a leading `NAME=value` shell env assignment (ASCII NAME)."""
    eq = tok.find("=")
    if eq <= 0:
        return False
    name = tok[:eq]
    if not (name[0] == "_" or name[0].isalpha()):
        return False
    return all(c == "_" or c.isalnum() for c in name)


def starts_with_ssh(cmd):
    """True if the first real command token is `ssh` (basename), skipping any
    leading env assignments. Returns False on an unparseable command."""
    try:
        toks = shlex.split(cmd)
    except ValueError:
        return False
    i = 0
    while i < len(toks) and is_env_assign(toks[i]):
        i += 1
    if i >= len(toks):
        return False
    return toks[i].rsplit("/", 1)[-1] == "ssh"


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    sys.exit(0)


def main():
    signal.signal(signal.SIGALRM, lambda *_: sys.exit(0))
    signal.alarm(5)
    try:
        data = json.load(sys.stdin)
    finally:
        signal.alarm(0)

    cmd = data.get("tool_input", {}).get("command", "")
    if not starts_with_ssh(cmd):
        sys.exit(0)

    deny("ssh is blocked in Claude Code's Bash: it can drop into an interactive "
         "session or a host-key/password prompt that hangs the TTY. Run it "
         "yourself in the prompt so your own terminal handles the interaction:\n"
         "  ! " + cmd)


def selftest():
    assert starts_with_ssh("ssh host")
    assert starts_with_ssh("ssh user@host 'ls'")
    assert starts_with_ssh("/usr/bin/ssh host")
    assert starts_with_ssh("FOO=1 ssh host")
    assert not starts_with_ssh("scp a host:b")
    assert not starts_with_ssh("git push origin main")
    assert not starts_with_ssh("echo ssh host")
    assert not starts_with_ssh("sshd -t")
    assert not starts_with_ssh("")
    assert not starts_with_ssh("ssh 'unterminated")
    print("ssh-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
