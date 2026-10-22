#!/usr/bin/env python3
"""PreToolUse guard: a desktop GUI app is launched by the user, not from Bash.

An Electron or other desktop app launched from an agent's shell lands on the
user's screen. From a sandbox with no WindowServer access the launch aborts and
pops a crash dialog that reads as an app bug. The rule was prose in the
ui-automation skill; a prose rule aimed at a model is a request, so it is
mechanized here.

Denied, with the launch handed back as a `! <command>` line for the user:
- `open -a <App>`, `open -b <bundle-id>`, `open <path>.app`
- executing `<path>.app/Contents/MacOS/<binary>` bare or with flags only; a
  positional, a `+action`, an info flag or `--headless` marks a CLI use and passes
- `electron <path>` / `electron .`, also through `npx`, `bunx`, `pnpx`,
  `npm|pnpm|yarn exec`, `pnpm|yarn dlx`, `bun x`, and `pnpm|yarn electron`
- `electron-forge start`

Passed:
- `open -g ...` / `--background`: the screen rule's sanctioned background
  launch (`open -gna "Google Chrome" --args ...`) for a runtime check
- `open <url>` and `open <file>` for any path that is not an `.app`
- `agent-browser` / `agent-device`, `npm|pnpm run dev`, and everything else

Parsing reuses declarative-package-guard.py's single-pass, O(n), quote-aware
tokenizer. Fail open, always: this hook runs in front of every Bash call in
every session, so an unparseable payload or any exception allows the call.
"""
import json
import shlex
import sys

WRAPPERS = {"sudo", "command", "env", "nohup", "nice", "time", "doas", "exec", "caffeinate"}
# `open` options whose value is the next token.
OPEN_OPT_WITH_ARG = {"-u", "-s", "--env", "--stdin", "--stdout", "--stderr", "--arch"}
# Package-runner options whose value is the next token.
RUNNER_OPT_WITH_ARG = {"-p", "--package", "-c", "--call", "--filter", "-F", "-C", "--dir"}
ELECTRON_INFO_FLAGS = {"--version", "-v", "--help", "-h", "--abi"}


def _is_name_char(ch):
    return ch == "_" or ("a" <= ch <= "z") or ("A" <= ch <= "Z") or ("0" <= ch <= "9")


def is_env_assign(tok):
    eq = tok.find("=")
    if eq <= 0:
        return False
    first = tok[0]
    if not (first == "_" or ("a" <= first <= "z") or ("A" <= first <= "Z")):
        return False
    return all(_is_name_char(c) for c in tok[:eq])


HEREDOC_WORD_END = " \t\r\n;&|<>()"


def read_heredoc_word(command, i):
    """Read the delimiter after an unquoted `<<` starting at `i`. Returns
    (next index, word, strip_tabs); `<<-` strips leading tabs from the body."""
    n = len(command)
    strip_tabs = i < n and command[i] == "-"
    if strip_tabs:
        i += 1
    while i < n and command[i] in " \t":
        i += 1
    word = []
    while i < n and command[i] not in HEREDOC_WORD_END:
        c = command[i]
        if c in ("'", '"'):
            end = command.find(c, i + 1)
            if end == -1:
                return n, "", strip_tabs
            word.append(command[i + 1:end])
            i = end + 1
        elif c == "\\" and i + 1 < n:
            word.append(command[i + 1])
            i += 2
        else:
            word.append(c)
            i += 1
    return i, "".join(word), strip_tabs


def skip_heredoc_bodies(command, i, heredocs):
    """Skip the body of each pending heredoc, starting at the line after the
    one that opened them, through its delimiter line."""
    n = len(command)
    for word, strip_tabs in heredocs:
        while i < n:
            j = command.find("\n", i)
            line = command[i:j if j != -1 else n]
            i = j + 1 if j != -1 else n
            if (line.lstrip("\t") if strip_tabs else line) == word:
                break
    return i


def parse_segments(command):
    """Split a shell command into operator-separated segments of unquoted
    tokens in one pass. `&& || ; & |` and a newline split only outside
    quotes, and a heredoc body is skipped. A segment
    with an unterminated quote is marked so the caller skips it."""
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

    heredocs = []
    i, n = 0, len(command)
    while i < n:
        c = command[i]
        if c == "\n":
            # A newline ends a command like `;`, then any heredoc body follows
            # as data, never as commands.
            flush_segment()
            i = skip_heredoc_bodies(command, i + 1, heredocs)
            heredocs = []
            continue
        if command.startswith("<<", i) and not command.startswith("<<<", i):
            flush_token()
            i, word, strip_tabs = read_heredoc_word(command, i + 2)
            if word:
                heredocs.append((word, strip_tabs))
            continue
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
        if c == "\\" and command.startswith("\n", i + 1):
            # A line continuation joins the two lines and starts no token.
            i += 2
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
        if c in " \t\r":
            flush_token()
            i += 1
            continue
        if command[i:i + 2] in ("&&", "||"):
            flush_segment()
            i += 2
            continue
        if c in (";", "&", "|", "(", ")"):
            flush_segment()
            i += 1
            continue
        tok_started = True
        tok.append(c)
        i += 1

    flush_segment()
    return segments


def base(tok):
    return tok.rsplit("/", 1)[-1]


def strip_prefix(toks):
    """Drop env assignments and command wrappers, so `nohup env X=1 open ...` reads as `open ...`."""
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


def is_app_path(tok):
    return tok.rstrip("/").lower().endswith(".app")


def open_launches_app(args):
    """True when `open` targets an application (-a, -b, or a .app path) without
    -g keeping it behind the user's windows."""
    background = False
    app = False
    skip = False
    for t in args:
        if skip:
            skip = False
            continue
        if t == "--args":
            break
        if t in OPEN_OPT_WITH_ARG:
            skip = True
        elif t == "--background":
            background = True
        elif t.startswith("-") and not t.startswith("--") and len(t) > 1:
            cluster = t[1:]
            if "g" in cluster:
                background = True
            if "a" in cluster or "b" in cluster:
                app = True
                skip = True
        elif not t.startswith("-") and is_app_path(t):
            app = True
    return app and not background


def first_positional(toks):
    """Index of the first token that is neither a runner option nor its value."""
    skip = False
    for idx, t in enumerate(toks):
        if skip:
            skip = False
            continue
        if t in RUNNER_OPT_WITH_ARG:
            skip = True
            continue
        if t.startswith("-"):
            continue
        return idx
    return None


def runner_target(toks):
    """For a package runner (`npx electron .`, `pnpm exec electron-forge start`),
    the tokens from the program it runs onward; otherwise None."""
    b = base(toks[0])
    rest = toks[1:]
    if b in ("npm", "pnpm", "yarn", "bun"):
        at = first_positional(rest)
        if at is None:
            return None
        verb = rest[at]
        if b in ("pnpm", "yarn") and verb.split("@", 1)[0] in ("electron", "electron-forge"):
            return rest[at:]
        launches = verb == "exec" or (verb == "dlx" and b in ("pnpm", "yarn")) \
            or (verb == "x" and b == "bun")
        if not launches:
            return None
        rest = rest[at + 1:]
    elif b not in ("npx", "bunx", "pnpx"):
        return None
    at = first_positional(rest)
    return rest[at:] if at is not None else None


def electron_launches(toks):
    """True when `toks` (program first) opens an Electron window."""
    prog = base(toks[0]).split("@", 1)[0]
    args = toks[1:]
    if prog == "electron":
        return not any(a in ELECTRON_INFO_FLAGS for a in args)
    if prog == "electron-forge":
        pos = [a for a in args if not a.startswith("-")]
        return bool(pos) and pos[0] == "start"
    return False


def is_cli_use(arg):
    """True for an argument that makes an app-bundle binary run as a CLI
    (`Tailscale status`, `ghostty +show-config`, `Google Chrome --version`)
    or headless, so no window opens."""
    return (arg in ELECTRON_INFO_FLAGS or arg.startswith("--headless")
            or arg.startswith("+") or not arg.startswith("-"))


def launches_gui(toks):
    toks = strip_prefix(toks)
    if not toks:
        return False
    if base(toks[0]) == "open":
        return open_launches_app(toks[1:])
    if ".app/Contents/MacOS/" in toks[0]:
        return not any(is_cli_use(a) for a in toks[1:])
    target = runner_target(toks)
    return electron_launches(target if target else toks)


def main():
    data = json.load(sys.stdin)
    if not isinstance(data, dict):
        return
    tool_input = data.get("tool_input")
    cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(cmd, str) or not cmd.strip():
        return
    if "open" not in cmd and ".app" not in cmd and "electron" not in cmd:
        return
    for seg in parse_segments(cmd):
        if seg["parse_error"] or not launches_gui(seg["tokens"]):
            continue
        line = shlex.join(seg["tokens"])
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "`%s` launches a desktop GUI app onto the user's screen; from this "
                "shell it can abort without WindowServer access and pop a crash dialog "
                "that reads as an app bug. Hand the launch to the user as a line they "
                "run in their own prompt:\n\n! %s\n\nVerify the app from here with its "
                "type-check and build. A browser for a runtime check runs headless "
                "through `agent-browser`, or behind the user's windows with "
                "`open -gna \"Google Chrome\" --args ...`." % (line, line)),
        }}))
        return


try:
    main()
except SystemExit:
    raise
except BaseException:
    pass
sys.exit(0)
