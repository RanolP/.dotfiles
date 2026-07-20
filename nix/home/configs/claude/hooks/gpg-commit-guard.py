#!/usr/bin/env python3
"""PreToolUse guard: before a *signed* `git commit`, verify the GPG key is
unlocked so pinentry can't hijack Claude Code's TTY and hang the session.

If the commit would be signed (commit.gpgsign true, or an explicit -S/--gpg-sign,
and not --no-gpg-sign) and a non-interactive test-sign fails (key locked), the
commit is denied with instructions to unlock via the user's own pinentry
(`! echo | gpg -s`). Everything else -- no commit, unsigned commit, key already
unlocked, gpg missing, parse failure -- falls through (exit 0, no opinion).

Runs on every Bash call, so it does zero subprocess work unless the command
actually contains a `git commit`. Uses stdlib shlex (linear, no ReDoS) rather
than a bespoke tokenizer.

Self-check: `python3 gpg-commit-guard.py --selftest`.
"""
import json
import os
import shlex
import signal
import subprocess
import sys

# git global options that consume the following token as their argument, so that
# `git -C path commit` resolves its subcommand to `commit`.
GIT_GLOBAL_OPT_WITH_ARG = {"-C", "-c", "--namespace", "--git-dir", "--work-tree",
                           "--exec-path", "--config-env"}
OPS = {"&&", "||", ";", "&", "|", "|&"}


def find_commit_args(toks):
    """If the token stream invokes `git commit`, return the commit's argument
    tokens (up to the next shell operator); otherwise return None. Scans for the
    first `git ... commit` occurrence; compound commands are handled by stopping
    at operator tokens."""
    i = 0
    n = len(toks)
    while i < n:
        if toks[i].rsplit("/", 1)[-1] == "git":
            j = i + 1
            while j < n:
                t = toks[j]
                if t in GIT_GLOBAL_OPT_WITH_ARG:
                    j += 2
                    continue
                if t.startswith("-"):
                    j += 1
                    continue
                break
            if j < n and toks[j] == "commit":
                args = []
                k = j + 1
                while k < n and toks[k] not in OPS:
                    args.append(toks[k])
                    k += 1
                return args
        i += 1
    return None


def signing_from_flags(args):
    """True/False if the commit flags force signing on/off, else None (defer to
    config). `-s`/`--signoff` is NOT signing; only `-S`/`--gpg-sign`."""
    for a in args:
        if a == "--no-gpg-sign":
            return False
    for a in args:
        if a == "-S" or (a.startswith("-S") and not a.startswith("-S=")) \
                or a == "--gpg-sign" or a.startswith("--gpg-sign="):
            return True
    return None


def signing_enabled(args, cwd):
    forced = signing_from_flags(args)
    if forced is not None:
        return forced
    try:
        out = subprocess.run(["git", "config", "--get", "commit.gpgsign"],
                             cwd=cwd, capture_output=True, text=True, timeout=3)
        return out.stdout.strip().lower() == "true"
    except Exception:
        return False


def key_unlocked():
    """True if a non-interactive test-sign succeeds. --batch/--pinentry-mode
    error/--no-tty guarantee gpg never prompts: it errors immediately when the
    key is locked instead of grabbing the TTY. Fail open on any exception (gpg
    missing, timeout) -- don't block commits over an unrelated gpg problem."""
    try:
        r = subprocess.run(
            ["gpg", "--batch", "--no-tty", "--pinentry-mode", "error", "-s"],
            input=b"", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            timeout=4)
        return r.returncode == 0
    except Exception:
        return True


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
    cwd = data.get("cwd") or os.getcwd()

    try:
        toks = shlex.split(cmd)
    except ValueError:
        sys.exit(0)  # unbalanced quotes -> can't reason, no opinion

    args = find_commit_args(toks)
    if args is None:
        sys.exit(0)
    if not signing_enabled(args, cwd):
        sys.exit(0)
    if key_unlocked():
        sys.exit(0)

    deny("GPG key is locked; a signed commit would trigger pinentry and hang "
         "Claude Code's TTY. Unlock it first by running `! echo | gpg -s` in "
         "the prompt, then re-run the commit.")


def selftest():
    assert find_commit_args(shlex.split("git commit -m x")) == ["-m", "x"]
    assert find_commit_args(shlex.split("git -C /p commit -S")) == ["-S"]
    assert find_commit_args(shlex.split("git push origin main")) is None
    assert find_commit_args(shlex.split("ls && git commit")) == []
    assert find_commit_args(shlex.split("git commit -m x && git push")) == ["-m", "x"]
    assert find_commit_args(shlex.split("git stash")) is None
    # signing flags
    assert signing_from_flags(["-m", "x"]) is None
    assert signing_from_flags(["-S"]) is True
    assert signing_from_flags(["-Skeyid"]) is True
    assert signing_from_flags(["--gpg-sign=abc"]) is True
    assert signing_from_flags(["--no-gpg-sign", "-S"]) is False  # off wins
    assert signing_from_flags(["-s"]) is None  # --signoff is not signing
    print("gpg-commit-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
