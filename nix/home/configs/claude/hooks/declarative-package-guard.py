#!/usr/bin/env python3
"""PreToolUse guard: package sets are declared in this repo, never installed imperatively.

This machine is managed declaratively -- `nix/home/mise-global.toml` is "the
single source of truth for tool versions across every host",
`nix/darwin/default.nix` holds `homebrew.brews`/`homebrew.casks`, and
`nix/flake.nix` + `nix/flake.lock` pin the nix inputs. An imperative install
lands outside all three: it survives until the next rebuild, then vanishes or
silently shadows the declared version, and no other host ever gets it.

Incident (2026-08-31): an agent ran `npm i -g corepack npm pi-subagents` and
`brew upgrade` instead of editing `nix/home/mise-global.toml`, leaving
`pi-subagents` at a version no file declares. The rule the user set in response
is "always be declarative, forced". A prose rule gets violated eventually, so
it is mechanized here.

Parsing reuses `git-push-guard.py`'s single-pass, O(n), quote-aware tokenizer.
That shape is deliberate: an earlier regex-based command parser in that hook
could ReDoS for minutes on a long command whose quoted text held a shell
operator, hanging every Bash call on the machine.

Fail open, always. A `PreToolUse` hook on the `Bash` matcher runs in front of
every Bash call in every session, so an unparseable payload, an unknown command
shape, or any unexpected exception allows the call. A false deny costs more
than a missed install.
"""
import json
import sys

MISE = "nix/home/mise-global.toml"
DARWIN = "nix/darwin/default.nix"
FLAKE = "nix/flake.nix"

# Wrappers that sit in front of the real command without changing what it does.
WRAPPERS = {"sudo", "command", "env", "nohup", "nice", "time", "doas", "exec"}


def decide(decision, reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


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


def base(tok):
    return tok.rsplit("/", 1)[-1]


def strip_prefix(toks):
    """Drop env assignments and command wrappers, so `sudo -E npm ...` reads as `npm ...`."""
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


def has_flag(toks, *names):
    return any(t in names for t in toks)


def is_global(toks):
    """True when a `-g` / `--global` style global-install flag is present.

    A single-dash cluster counts, because `npm i -gD x` is a global install.
    """
    for t in toks:
        if t in ("--global", "--location=global"):
            return True
        if t.startswith("-") and not t.startswith("--") and "g" in t[1:]:
            return True
    return False


def positionals(toks):
    return [t for t in toks if not t.startswith("-")]


def subcommand(toks):
    """First non-option token after argv0, or None."""
    for t in toks[1:]:
        if not t.startswith("-"):
            return t
    return None


def pkg_list(toks, sub):
    """Package names: positional tokens after the subcommand."""
    pos = positionals(toks)
    if sub in pos:
        pos = pos[pos.index(sub) + 1:]
    return [p for p in pos if "=" not in p]


def mise_line(prefix, pkgs):
    name = pkgs[0] if pkgs else "<pkg>"
    return '"%s:%s" = "<version>"' % (prefix, name)


NODE_MUTATIONS = {"install", "i", "add", "update", "up", "upgrade", "uninstall",
                  "remove", "rm", "un", "unlink", "link"}


def classify(toks):
    """Deny reason for an imperative package mutation, or None to stay silent."""
    toks = strip_prefix(toks)
    if not toks:
        return None
    cmd = base(toks[0])
    sub = subcommand(toks)

    if cmd in ("npm", "pnpm", "bun"):
        if sub in NODE_MUTATIONS and is_global(toks):
            return ("A global %s install is imperative. Declare it in %s instead: add "
                    "%s to the [tools] table, then run `mise install`."
                    % (cmd, MISE, mise_line("npm", pkg_list(toks, sub))))
        return None

    if cmd == "yarn":
        if sub == "global":
            rest = pkg_list(toks, "global")[1:]  # drop the add/upgrade/remove action
            return ("`yarn global` is imperative. Declare it in %s instead: add "
                    "%s to the [tools] table, then run `mise install`."
                    % (MISE, mise_line("npm", rest)))
        return None

    if cmd == "pipx":
        if sub in ("install", "install-all", "upgrade", "upgrade-all", "uninstall",
                   "uninstall-all", "reinstall", "reinstall-all", "inject"):
            return ("`pipx %s` is imperative. Declare it in %s instead: add "
                    "%s to the [tools] table, then run `mise install`."
                    % (sub, MISE, mise_line("pipx", pkg_list(toks, sub))))
        return None

    if cmd == "uv":
        if sub == "tool":
            rest = positionals(toks)
            action = rest[2] if len(rest) > 2 else None
            if action in ("install", "upgrade", "uninstall"):
                return ("`uv tool %s` is imperative. Declare it in %s instead: add "
                        "%s to the [tools] table, then run `mise install`."
                        % (action, MISE, mise_line("pipx", rest[3:])))
        return None

    if cmd in ("pip", "pip3") or (cmd.startswith("python") and has_flag(toks, "-m")
                                  and "pip" in toks):
        pip_toks = toks[toks.index("pip"):] if "pip" in toks else toks
        if subcommand(pip_toks) != "install":
            return None
        if not has_flag(toks, "-g", "--user", "--break-system-packages"):
            return None
        return ("A user-wide pip install is imperative. Declare it in %s instead: add "
                "%s to the [tools] table, then run `mise install`. A venv-local "
                "`pip install` stays fine."
                % (MISE, mise_line("pipx", pkg_list(pip_toks, "install"))))

    if cmd == "cargo" and sub == "install":
        return ("`cargo install` compiles from source and lands outside the declaration. "
                "Declare the tool in %s instead (an `aqua:` or `ubi:` backend fetches a "
                "prebuilt binary), then run `mise install`." % MISE)

    if cmd == "go" and sub == "install":
        return ("`go install` is imperative. Declare the tool in %s instead, then run "
                "`mise install`." % MISE)

    if cmd == "gem" and sub == "install":
        return ("`gem install` is imperative. Declare the tool in %s instead, then run "
                "`mise install`." % MISE)

    if cmd == "brew":
        if sub in ("install", "upgrade", "uninstall", "remove", "reinstall", "tap", "untap"):
            pkgs = pkg_list(toks, sub)
            named = ", ".join(pkgs) if pkgs else "every installed formula"
            return ("`brew %s` is imperative (%s). Edit the homebrew.brews / homebrew.casks "
                    "lists in %s instead, then rebuild. nix-homebrew reconciles the "
                    "declared set." % (sub, named, DARWIN))
        return None

    if cmd == "mise":
        if sub == "use" and (is_global(toks) or has_flag(toks, "--global")):
            return ("`mise use -g` writes ~/.config/mise/config.toml, which no host but this "
                    "one sees. Edit the [tools] table in %s instead, then run `mise install`."
                    % MISE)
        if sub == "global":
            return ("`mise global` writes ~/.config/mise/config.toml, which no host but this "
                    "one sees. Edit the [tools] table in %s instead, then run `mise install`."
                    % MISE)
        return None

    if cmd == "nix":
        pos = positionals(toks)
        if len(pos) > 2 and pos[1] == "profile" and pos[2] in ("install", "remove", "upgrade"):
            return ("`nix profile %s` mutates an imperative profile. Change the inputs in %s "
                    "(and `nix flake update` to move %s/flake.lock) instead, then rebuild."
                    % (pos[2], FLAKE, FLAKE.rsplit("/", 1)[0]))
        return None

    if cmd == "nix-env":
        # `-iA` clusters the install flag with the attribute-path flag.
        clustered = any(t.startswith("-") and not t.startswith("--")
                        and any(c in t[1:] for c in "iue") for t in toks[1:])
        if clustered or has_flag(toks, "--install", "--uninstall", "--upgrade"):
            return ("`nix-env` mutates an imperative profile. Change the inputs in %s "
                    "instead, then rebuild." % FLAKE)
        return None

    return None


def main():
    data = json.load(sys.stdin)
    if not isinstance(data, dict):
        return
    cmd = data.get("tool_input", {}).get("command", "")
    if not isinstance(cmd, str) or not cmd.strip():
        return

    for seg in parse_segments(cmd):
        if seg["parse_error"]:
            continue
        reason = classify(seg["tokens"])
        if reason:
            decide("deny", "This machine is declared, not installed into. " + reason)


try:
    main()
except SystemExit:
    raise
except BaseException:
    pass
sys.exit(0)
