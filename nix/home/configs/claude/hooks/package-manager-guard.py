#!/usr/bin/env python3
"""PreToolUse guard: when a Node package-manager command (npm/pnpm/yarn/bun) is
run inside a project that declares a DIFFERENT manager, deny and name the right
one. The deny reason is fed back to Claude, which re-runs with the correct tool.

Respects the repo's own signal and stays silent when nothing is declared -- no
blanket "npm -> pnpm" rule. Signal precedence, walking up from cwd:

  package.json "packageManager" field  >  lockfile  >  .yarnrc(.yml)

Skipped (fall through, no opinion): global installs (-g/--global), version/help
probes, executors (npx/bunx/dlx have their own program name), and any project
that declares nothing. Runs on every Bash call but touches the filesystem only
when the command actually starts with a package manager.

Self-check: `python3 package-manager-guard.py --selftest`.
"""
import json
import os
import shlex
import signal
import sys

PMS = {"npm", "pnpm", "yarn", "bun"}
OPS = {"&&", "||", ";", "&", "|", "|&", "(", ")", "{", "}"}
# lockfile -> the manager it belongs to.
LOCKFILES = {
    "pnpm-lock.yaml": "pnpm",
    "yarn.lock": "yarn",
    "package-lock.json": "npm",
    "npm-shrinkwrap.json": "npm",
    "bun.lockb": "bun",
    "bun.lock": "bun",
}
SKIP_ARGS = {"-g", "--global", "-v", "--version", "-h", "--help"}


def is_env_assign(tok):
    """True for a leading `NAME=value` shell env assignment (ASCII NAME)."""
    eq = tok.find("=")
    if eq <= 0:
        return False
    name = tok[:eq]
    if not (name[0].isalpha() or name[0] == "_"):
        return False
    return all(c.isalnum() or c == "_" for c in name)


def find_pm_invocation(toks):
    """Return (manager, arg_tokens) for the first package-manager command that
    appears in *command position* (start of the line or right after a shell
    operator, skipping env assignments); otherwise (None, None)."""
    at_cmd = True
    i = 0
    n = len(toks)
    while i < n:
        t = toks[i]
        if t in OPS:
            at_cmd = True
            i += 1
            continue
        if at_cmd and is_env_assign(t):
            i += 1
            continue
        if at_cmd:
            base = t.rsplit("/", 1)[-1]
            if base in PMS:
                args = []
                j = i + 1
                while j < n and toks[j] not in OPS:
                    args.append(toks[j])
                    j += 1
                return base, args
            at_cmd = False
        i += 1
    return None, None


def detect_declared_pm(start):
    """Nearest declared manager walking up from `start`, or None. package.json's
    packageManager field wins, then a lockfile, then a yarn config -- checked per
    directory before ascending (so a monorepo root lockfile above a workspace
    package.json still resolves)."""
    d = os.path.abspath(start)
    while True:
        try:
            with open(os.path.join(d, "package.json")) as fh:
                pkg = json.load(fh)
            pm = pkg.get("packageManager")
            if isinstance(pm, str):
                name = pm.split("@", 1)[0].strip().lower()
                if name in PMS:
                    return name
        except (OSError, ValueError):
            pass
        for fn, name in LOCKFILES.items():
            if os.path.exists(os.path.join(d, fn)):
                return name
        if os.path.exists(os.path.join(d, ".yarnrc.yml")) or \
                os.path.exists(os.path.join(d, ".yarnrc")):
            return "yarn"
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


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
        sys.exit(0)

    invoked, args = find_pm_invocation(toks)
    if invoked is None:
        sys.exit(0)
    if any(a in SKIP_ARGS for a in args):
        sys.exit(0)  # global install / version / help are not repo-bound

    declared = detect_declared_pm(cwd)
    if declared is None or declared == invoked:
        sys.exit(0)

    deny(f"This project uses {declared} (detected from its "
         f"lockfile/packageManager field), not {invoked}. Re-run the command "
         f"with {declared}.")


def selftest():
    assert find_pm_invocation(shlex.split("npm install")) == ("npm", ["install"])
    assert find_pm_invocation(shlex.split("cd x && pnpm run build")) == ("pnpm", ["run", "build"])
    assert find_pm_invocation(shlex.split("FOO=1 yarn add react")) == ("yarn", ["add", "react"])
    assert find_pm_invocation(shlex.split("/opt/homebrew/bin/bun test")) == ("bun", ["test"])
    assert find_pm_invocation(shlex.split("git commit -m npm")) == (None, None)  # npm as arg, not cmd
    assert find_pm_invocation(shlex.split("npx create-vite")) == (None, None)  # executor, not a PM
    assert find_pm_invocation(shlex.split("echo npm")) == (None, None)
    assert is_env_assign("FOO=1") and not is_env_assign("--foo=1")
    print("package-manager-guard selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
