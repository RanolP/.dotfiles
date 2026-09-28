#!/usr/bin/env python3
"""PreToolUse guard: hard-deny any Bash command that reaches a remote device.

The agent is not allowed to read or write an arbitrary remote host, so every
remote-shell and remote-copy program is denied wherever it sits in the command
line, with no hand-off to the user: ssh, scp, sftp, mosh, sshpass, autossh,
sshfs, ssh-keyscan, and rsync when it names a remote spec or a remote shell.
Secondary reason: ssh can also drop into a host-key/password prompt that
hijacks Claude Code's TTY and hangs it.

A "command position" is the head of every simple command: after leading
`NAME=val` assignments, after each shell operator, after wrapper commands
(sudo, env, command, exec, nohup, time, timeout, nice, xargs, watch), and
inside `sh -c`/`eval` strings and `$(...)`/backtick substitutions. Local key
tools (ssh-keygen, ssh-add, ssh-agent), sshd, git's own transport, and a
program merely named as an argument (`man ssh`, `rg ssh`) stay allowed.

On a parse error, or a command over 64KB, the guard fails closed when a
blocked program appears as a whole word in the raw text, and allows otherwise. A malformed payload
(empty, non-JSON, non-string command) is no opinion.

Self-check: `python3 ssh-guard.py --selftest`.
"""
import json
import re
import shlex
import sys

DENY_HEAD = "You are not allowed to read/write any arbitrary remote device."

REMOTE_PROGRAMS = {"ssh", "scp", "sftp", "mosh", "sshpass", "autossh", "sshfs", "ssh-keyscan"}
SHELLS = {"bash", "sh", "zsh", "dash", "fish"}
KEYWORDS = {"{", "}", "!", "if", "then", "else", "elif", "do", "while", "until", "fi", "done"}
SEPARATOR_CHARS = set("();&|\n")
MAX_DEPTH = 8

# Options that consume the following token, per wrapper.
WRAPPER_ARG_OPTS = {
    "sudo": {"-u", "-g", "-p", "-C", "-D", "-h", "-r", "-t", "-U", "-T"},
    "env": {"-u", "-C", "-S", "--unset", "--chdir", "--split-string"},
    "command": set(),
    "exec": {"-a"},
    "nohup": set(),
    "time": set(),
    "timeout": {"-s", "-k", "--signal", "--kill-after"},
    "nice": {"-n", "--adjustment"},
    "xargs": {"-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a", "--max-args",
              "--max-procs", "--delimiter", "--arg-file", "--max-lines", "--replace"},
    "watch": {"-n", "--interval"},
}

FALLBACK_RE = re.compile(
    r"(?<![\w.-])(?:ssh-keyscan|ssh|scp|sftp|mosh|sshpass|autossh|sshfs)(?![\w-])")
RSYNC_REMOTE_RE = re.compile(r"^(?:rsync://|[^/:]+:)")
# Every block needs one of these names in the text, so a command without one
# skips shlex, which spends ~8s on a 1MB command.
PREFILTER_RE = re.compile(r"ssh|scp|sftp|mosh|rsync")
# Past this size, lexing blows the hook's time budget: judge by FALLBACK_RE.
MAX_LEX_CHARS = 64 * 1024


def is_env_assign(tok):
    eq = tok.find("=")
    if eq <= 0:
        return False
    name = tok[:eq]
    if not (name[0] == "_" or name[0].isalpha()):
        return False
    return all(c == "_" or c.isalnum() for c in name)


def is_separator(tok):
    return bool(tok) and all(c in SEPARATOR_CHARS for c in tok)


def is_redirect(tok):
    return bool(tok) and all(c in "<>&" for c in tok) and tok[0] in "<>"


def lex(cmd):
    """Word/operator tokens; newlines are kept as separators. Raises ValueError."""
    lx = shlex.shlex(cmd, posix=True, punctuation_chars="();&|\n<>")
    lx.whitespace = " \t\r"
    lx.whitespace_split = True
    return list(lx)


def substitutions(cmd):
    """Bodies of `$(...)` and backtick substitutions outside single quotes."""
    out, i, n = [], 0, len(cmd)
    in_dq = False
    while i < n:
        c = cmd[i]
        if c == "\\":
            i += 2
            continue
        if c == "'" and not in_dq:
            j = cmd.find("'", i + 1)
            i = n if j < 0 else j + 1
            continue
        if c == '"':
            in_dq = not in_dq
        elif c == "$" and cmd.startswith("$(", i):
            depth, j = 1, i + 2
            while j < n and depth:
                if cmd[j] == "(":
                    depth += 1
                elif cmd[j] == ")":
                    depth -= 1
                j += 1
            out.append(cmd[i + 2:j - 1] if depth == 0 else cmd[i + 2:])
            i = j
            continue
        elif c == "`":
            j = cmd.find("`", i + 1)
            out.append(cmd[i + 1:] if j < 0 else cmd[i + 1:j])
            i = n if j < 0 else j + 1
            continue
        i += 1
    return out


def rsync_is_remote(args):
    for a in args:
        if a == "--rsh" or a.startswith("--rsh=") or a.startswith("-e"):
            return True
        if a.startswith("-") and not a.startswith("--") and "e" in a[1:]:
            return True
        if not a.startswith("-") and RSYNC_REMOTE_RE.match(a):
            return True
    return False


def skip_wrapper_opts(name, words, i):
    arg_opts = WRAPPER_ARG_OPTS[name]
    while i < len(words):
        w = words[i]
        if name in ("sudo", "env") and is_env_assign(w):
            i += 1
        elif w == "--":
            return i + 1
        elif w.startswith("-") and len(w) > 1:
            i += 2 if w in arg_opts else 1
        elif name == "env" and w == "-":
            i += 1
        else:
            break
    if name == "timeout" and i < len(words):
        i += 1  # the duration
    return i


def check_segment(words, depth):
    """Name of the blocked program heading this simple command, else None."""
    i = 0
    while i < len(words):
        w = words[i]
        if is_env_assign(w) or w in KEYWORDS:
            i += 1
            continue
        if is_redirect(w):
            i += 2
            continue
        name = w.rsplit("/", 1)[-1]
        rest = words[i + 1:]
        if name in REMOTE_PROGRAMS:
            return name
        if name == "rsync":
            return name if rsync_is_remote(rest) else None
        if name == "command" and any(a in ("-v", "-V") for a in rest[:1]):
            return None
        if name in WRAPPER_ARG_OPTS:
            i = skip_wrapper_opts(name, words, i + 1)
            continue
        if name in SHELLS:
            for k, a in enumerate(rest):
                if a.startswith("-") and not a.startswith("--") and "c" in a[1:]:
                    if k + 1 < len(rest):
                        return blocked_program(rest[k + 1], depth + 1)
                    return None
                if not a.startswith("-"):
                    return None
            return None
        if name == "eval":
            return blocked_program(" ".join(rest), depth + 1)
        return None
    return None


def blocked_program(cmd, depth=0):
    """Name of a remote-access program run anywhere in `cmd`, else None."""
    if depth > MAX_DEPTH or not PREFILTER_RE.search(cmd):
        return None
    try:
        if len(cmd) > MAX_LEX_CHARS:
            raise ValueError("too long to lex")
        toks = lex(cmd)
    except ValueError:
        m = FALLBACK_RE.search(cmd)
        return m.group(0) if m else None
    seg = []
    for tok in toks + [";"]:
        if is_separator(tok):
            hit = check_segment(seg, depth)
            if hit:
                return hit
            seg = []
        else:
            seg.append(tok)
    for body in substitutions(cmd):
        hit = blocked_program(body, depth + 1)
        if hit:
            return hit
    return None


def deny(program):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": f"{DENY_HEAD} Blocked: `{program}` reaches a remote host.",
    }}))
    sys.exit(0)


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace"))
    except ValueError:
        sys.exit(0)
    if not isinstance(data, dict):
        sys.exit(0)
    tool_input = data.get("tool_input")
    cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(cmd, str):
        sys.exit(0)
    hit = blocked_program(cmd)
    if hit:
        deny(hit)
    sys.exit(0)


def selftest():
    b = blocked_program
    # leading ssh, the original case
    assert b("ssh host") == "ssh"
    assert b("ssh user@host 'ls'") == "ssh"
    # absolute path must match by basename
    assert b("/usr/bin/ssh host") == "ssh"
    # leading env assignment must not hide the command
    assert b("FOO=1 ssh host") == "ssh"
    # every remote program is blocked, not only ssh
    for p in ("scp a host:b", "sftp host", "mosh host", "sshpass -p x ssh host",
              "autossh -M 0 host", "sshfs host:/ /mnt", "ssh-keyscan host"):
        assert b(p), p
    # ssh after each shell operator
    for op in ("&&", "||", ";", "|", "&", "|&", "\n"):
        assert b(f"ls {op} ssh host") == "ssh", op
    # subshell and brace group heads
    assert b("(ssh host)") == "ssh"
    assert b("{ ssh host; }") == "ssh"
    # compound-command keywords must not hide the head
    assert b("if true; then ssh host; fi") == "ssh"
    # wrapper commands and their options
    for w in ("sudo -u root ssh host", "env -i FOO=1 ssh host", "command ssh host",
              "exec ssh host", "nohup ssh host", "time ssh host",
              "timeout -s KILL 5 ssh host", "nice -n 10 ssh host",
              "xargs -I{} ssh {} uptime", "xargs -I {} scp {} h:/", "watch -n 1 ssh host"):
        assert b(w), w
    # string re-evaluation: sh -c, eval, substitutions
    for s in ("bash -c 'ssh host'", "sh -lc \"ssh host\"", "zsh -c 'ls; scp a h:b'",
              "eval ssh host", "echo $(ssh host)", 'echo "$(ssh host)"', "echo `ssh host`",
              "x=$(ls $(ssh host))"):
        assert b(s), s
    # rsync only when remote
    assert b("rsync -a a/ host:b/") == "rsync"
    assert b("rsync -a a/ user@host:/b") == "rsync"
    assert b("rsync rsync://host/mod ./") == "rsync"
    assert b("rsync -e ssh a b") == "rsync"
    assert b("rsync --rsh=ssh a b") == "rsync"
    assert b("rsync -avze ssh a b") == "rsync"
    # local rsync is a local copy
    assert b("rsync -a a/ b/") is None
    # local key tools and sshd are not remote access
    for ok in ("ssh-keygen -t ed25519", "ssh-add -l", "ssh-agent -s", "sshd -t"):
        assert b(ok) is None, ok
    # ssh as a mere argument
    for ok in ("echo ssh host", "rg ssh", "man ssh", "cat ~/.ssh/config", "command -v ssh"):
        assert b(ok) is None, ok
    # git's own transport, including GIT_SSH_COMMAND as an assignment value
    for ok in ("git push origin main", "git fetch", "git clone git@github.com:a/b",
               "GIT_SSH_COMMAND='ssh -i k' git push"):
        assert b(ok) is None, ok
    # single-quoted literal substitution is text, not a command
    assert b("echo '$(ssh host)'") is None
    assert b("") is None
    # parse failure fails closed on a whole-word program
    assert b("ssh 'unterminated") == "ssh"
    assert b("ls; scp a 'b") == "scp"
    # parse failure without a remote program is allowed
    assert b("echo 'unclosed") is None
    assert b("ssh-keygen 'unclosed") is None
    assert b("cat ~/.ssh/config 'unclosed") is None
    # an oversized command is judged by the raw-text regex, not lexed past the time budget
    assert b("ssh host " + "x" * 100_000) == "ssh"
    assert b("echo " + "x" * 100_000) is None
    print("ssh-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
