#!/usr/bin/env python3
"""PreToolUse guard: deny the git flags that skip hooks or rewrite remote history.

Two rules were prose in AGENTS.md and got violated anyway -- force-push commands
were once handed over for four branches that already matched origin. A prose
NEVER aimed at a model is a request, not a guard, so both live here instead:

- `git commit --no-verify` / `-n`  -> denied. The hooks ARE the enforcement the
  repo was given; skipping them discards it silently.
- `git push --no-verify`          -> denied, same reason. (`git push -n` is
  --dry-run, not --no-verify, so a bare `-n` on push passes untouched.)
- `git push --force` / `-f` / `--force-with-lease` / `--force-if-includes`
                                  -> denied. Remote history is shared state.

Deliberately separate from git-push-guard.py: that hook answers "which refspec
may be pushed" and carries a per-worktree `.nanno-workers.json` bypass. These
two rules have no bypass, so they must not sit behind one.

Tokenizing uses stdlib shlex (linear, no ReDoS). An unparseable command falls
back to a literal scan for the long flags, so an unbalanced quote cannot smuggle
one through.

Self-check: `python3 git-integrity-guard.py --selftest`.
"""
import json
import shlex
import sys

GIT_GLOBAL_OPT_WITH_ARG = {"-C", "-c", "--namespace", "--git-dir", "--work-tree",
                           "--exec-path", "--config-env"}
OPS = {"&&", "||", ";", "&", "|", "|&"}
FORCE_LONG = {"--force", "--force-with-lease", "--force-if-includes"}


def git_invocations(toks):
    """Yield (subcommand, args) for every `git <sub>` in the token stream, where
    args runs to the next shell operator. Leading global options are skipped so
    `git -C path push` reports `push`."""
    i, n = 0, len(toks)
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
            if j < n and toks[j] not in OPS:
                args = []
                k = j + 1
                while k < n and toks[k] not in OPS:
                    args.append(toks[k])
                    k += 1
                yield toks[j], args
                i = k
                continue
        i += 1


def has_short(args, letter):
    """True if a single-dash cluster carries `letter` (`-n`, `-nm`, `-fv`)."""
    return any(a.startswith("-") and not a.startswith("--") and letter in a[1:]
               for a in args)


def violation(toks):
    """Return the deny reason for the first offending git invocation, else None."""
    for sub, args in git_invocations(toks):
        if sub == "commit":
            if "--no-verify" in args or has_short(args, "n"):
                return ("`git commit --no-verify` skips the repo's hooks, which are "
                        "the enforcement the repo was given on purpose. Fix what the "
                        "hook reports, or stash the unrelated work, then commit again.")
        elif sub == "push":
            if "--no-verify" in args:
                return ("`git push --no-verify` skips the pre-push hooks. Let them run; "
                        "stash untracked WIP if they trip on it.")
            if any(a in FORCE_LONG or a.startswith("--force-with-lease=") for a in args) \
                    or has_short(args, "f"):
                return ("Force-push rewrites shared remote history and is never allowed. "
                        "Fetch and rebase instead, and ask the user when the rebase is "
                        "not obviously safe.")
    return None


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}))
    sys.exit(0)


def main():
    data = json.load(sys.stdin)
    cmd = data.get("tool_input", {}).get("command", "")
    if "git" not in cmd:
        sys.exit(0)

    try:
        toks = shlex.split(cmd)
    except ValueError:
        # Unbalanced quotes: cannot tokenize, so match the long flags literally
        # rather than letting a malformed command through.
        for flag in ("--no-verify",) + tuple(FORCE_LONG):
            if flag in cmd:
                deny(f"`{flag}` is not allowed, and this command could not be "
                     "parsed safely. Rewrite it without the flag.")
        sys.exit(0)

    reason = violation(toks)
    if reason:
        deny(reason)
    sys.exit(0)


def selftest():
    def v(cmd):
        return violation(shlex.split(cmd))

    assert v("git commit -m 'x'") is None
    assert v("git commit --no-verify -m x") is not None
    assert v("git commit -n -m x") is not None
    assert v("git commit -nm x") is not None
    assert v("git -C /p commit --no-verify") is not None
    assert v("git commit -m 'skip -n please'") is None  # flag-looking text in a value
    assert v("git commit -s -m x") is None              # --signoff is not --no-verify

    assert v("git push origin main") is None
    assert v("git push -n origin main") is None         # -n on push is --dry-run
    assert v("git push --no-verify origin main") is not None
    assert v("git push --force origin main") is not None
    assert v("git push -f origin main") is not None
    assert v("git push --force-with-lease") is not None
    assert v("git push --force-with-lease=main:abc123") is not None
    assert v("git push --force-if-includes origin main") is not None

    assert v("ls && git push --force") is not None      # found after an operator
    assert v("git status && git commit -m x") is None
    assert v("git stash push --no-verify") is None      # different subcommand
    assert v("echo 'git push --force'") is None         # quoted text is not a command
    print("git-integrity-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
