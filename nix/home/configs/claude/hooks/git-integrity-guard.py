#!/usr/bin/env python3
"""PreToolUse guard: deny the git flags that skip hooks or rewrite reviewed history.

Two rules were prose in AGENTS.md and got violated anyway -- force-push commands
were once handed over for four branches that already matched origin. A prose
NEVER aimed at a model is a request, not a guard, so both live here instead:

- `git commit --no-verify` / `-n`  -> denied. The hooks ARE the enforcement the
  repo was given; skipping them discards it silently.
- `git push --no-verify`          -> denied, same reason. (`git push -n` is
  --dry-run, not --no-verify, so a bare `-n` on push passes untouched.)
- `git push --force` / `-f` / `+refspec`, and `--force-if-includes` on its own
                                  -> denied always. They overwrite without
  checking what the remote holds.
- `git push --force-with-lease[=...]` (optionally with `--force-if-includes`)
                                  -> denied if and only if the pushed branch has
  an open GitHub PR whose `reviews` list is non-empty. Every inline review
  comment arrives as a COMMENTED review, so that list covers the threads too;
  rewriting the history under them detaches them. Anything the hook cannot
  settle -- the branch, or gh failing -- is denied, fail closed.

Deliberately separate from git-push-guard.py: that hook answers "which refspec
may be pushed" and carries a per-worktree `.nanno-workers.json` bypass. These
rules have no bypass, so they must not sit behind one.

Tokenizing uses stdlib shlex (linear, no ReDoS). An unparseable command falls
back to a literal scan for the long flags, so an unbalanced quote cannot smuggle
one through.

Self-check: `python3 git-integrity-guard.py --selftest`.
"""
import json
import os
import shlex
import subprocess
import sys

GIT_GLOBAL_OPT_WITH_ARG = {"-C", "-c", "--namespace", "--git-dir", "--work-tree",
                           "--exec-path", "--config-env"}
PUSH_OPT_WITH_ARG = {"-o", "--push-option", "--repo", "--receive-pack", "--exec"}
OPS = {"&&", "||", ";", "&", "|", "|&"}
FORCE_LONG = {"--force", "--force-with-lease", "--force-if-includes"}
GH_TIMEOUT_S = 10


def git_invocations(toks, cwd):
    """Yield (subcommand, args, dir) for every `git <sub>` in the token stream,
    where args runs to the next shell operator and dir folds in every `-C`.
    Leading global options are skipped so `git -C path push` reports `push`."""
    i, n = 0, len(toks)
    while i < n:
        if toks[i].rsplit("/", 1)[-1] == "git":
            d = cwd
            j = i + 1
            while j < n:
                t = toks[j]
                if t in GIT_GLOBAL_OPT_WITH_ARG:
                    if t == "-C" and j + 1 < n:
                        d = os.path.join(d, toks[j + 1])
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
                yield toks[j], args, d
                i = k
                continue
        i += 1


def has_short(args, letter):
    """True if a single-dash cluster carries `letter` (`-n`, `-nm`, `-fv`)."""
    return any(a.startswith("-") and not a.startswith("--") and letter in a[1:]
               for a in args)


def push_positionals(args):
    out, skip = [], False
    for a in args:
        if skip:
            skip = False
        elif a in PUSH_OPT_WITH_ARG:
            skip = True
        elif not a.startswith("-"):
            out.append(a)
    return out


def current_branch(d):
    """Branch checked out in `d`, or None when detached or not a repo."""
    try:
        p = subprocess.run(["git", "-C", d, "rev-parse", "--abbrev-ref", "HEAD"],
                           capture_output=True, text=True, timeout=GH_TIMEOUT_S)
    except (OSError, subprocess.TimeoutExpired):
        return None
    b = p.stdout.strip()
    return b if p.returncode == 0 and b and b != "HEAD" else None


def gh_open_prs(branch, d):
    """Return (prs, None) with the open PRs whose head is `branch`, or
    (None, error) naming why gh could not answer."""
    cmd = ["gh", "pr", "list", "--head", branch, "--state", "open",
           "--json", "number,url,reviews,reviewDecision"]
    try:
        p = subprocess.run(cmd, cwd=d, capture_output=True, text=True,
                           timeout=GH_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return None, f"`gh pr list --head {branch}` timed out after {GH_TIMEOUT_S}s"
    except OSError as e:
        return None, f"`gh pr list --head {branch}` could not run in {d}: {e}"
    if p.returncode != 0:
        return None, (f"`gh pr list --head {branch}` exited {p.returncode}: "
                      f"{p.stderr.strip()[:500]}")
    try:
        prs = json.loads(p.stdout)
    except ValueError:
        return None, f"`gh pr list --head {branch}` printed non-JSON: {p.stdout[:200]!r}"
    if not isinstance(prs, list):
        return None, f"`gh pr list --head {branch}` printed a non-list: {p.stdout[:200]!r}"
    return prs, None


def target_branches(positionals, d, head):
    """Destination branches of the push, or (None, what was missing)."""
    refspecs = positionals[1:]
    if not refspecs:
        b = head(d)
        return ([b], None) if b else (None, f"no refspec given and no branch checked out in {d}")
    out = []
    for r in refspecs:
        dst = r.split(":", 1)[1] if ":" in r else r
        if dst == "HEAD":
            dst = head(d)
            if not dst:
                return None, f"refspec `{r}` names HEAD but no branch is checked out in {d}"
        if dst.startswith("refs/heads/"):
            dst = dst[len("refs/heads/"):]
        if not dst:
            return None, f"refspec `{r}` has no destination branch"
        out.append(dst)
    return out, None


def lease_violation(args, d, lookup, head):
    pos = push_positionals(args)
    remote = pos[0] if pos else "origin"
    if any(a in ("--all", "--mirror", "--branches") for a in args):
        return ("`--force-with-lease` with --all/--mirror/--branches: the pushed branches "
                "cannot be enumerated to check their PRs for review comments. Name the "
                "branch explicitly.")
    branches, missing = target_branches(pos, d, head)
    if branches is None:
        return (f"`--force-with-lease` to {remote} denied: could not determine the pushed "
                f"branch ({missing}), so its PR could not be checked for review comments. "
                "Name the branch as a refspec.")
    for b in branches:
        prs, err = lookup(b, d)
        if err:
            return (f"`--force-with-lease` of `{b}` to {remote} denied: the PR review check "
                    f"failed, and this guard fails closed. {err}")
        for pr in prs:
            reviews = pr.get("reviews") or [] if isinstance(pr, dict) else []
            if reviews:
                return (f"`--force-with-lease` of `{b}` denied: PR #{pr.get('number')} "
                        f"({pr.get('url')}) has {len(reviews)} review(s). The PR already "
                        "carries review comments; rewriting its history detaches them. "
                        "Push new commits on top instead (fixup commits, no rebase), or "
                        "ask the user.")
    return None


def violation(toks, cwd=".", lookup=gh_open_prs, head=current_branch):
    """Return the deny reason for the first offending git invocation, else None."""
    for sub, args, d in git_invocations(toks, cwd):
        if sub == "commit":
            if "--no-verify" in args or has_short(args, "n"):
                return ("`git commit --no-verify` skips the repo's hooks, which are "
                        "the enforcement the repo was given on purpose. Fix what the "
                        "hook reports, or stash the unrelated work, then commit again.")
        elif sub == "push":
            if "--no-verify" in args:
                return ("`git push --no-verify` skips the pre-push hooks. Let them run; "
                        "stash untracked WIP if they trip on it.")
            lease = any(a == "--force-with-lease" or a.startswith("--force-with-lease=")
                        for a in args)
            plus = any(p.startswith("+") for p in push_positionals(args)[1:])
            if "--force" in args or has_short(args, "f") or plus \
                    or ("--force-if-includes" in args and not lease):
                return ("`--force`, `-f`, a `+refspec`, or `--force-if-includes` without "
                        "`--force-with-lease` overwrites remote history unchecked and is "
                        "never allowed. Fetch and rebase instead, or use "
                        "`--force-with-lease` on a branch whose PR has no review comments; "
                        "ask the user when the rebase is not obviously safe.")
            if lease:
                reason = lease_violation(args, d, lookup, head)
                if reason:
                    return reason
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

    reason = violation(toks, cwd=data.get("cwd") or os.getcwd())
    if reason:
        deny(reason)
    sys.exit(0)


def selftest():
    no_pr = lambda b, d: ([], None)
    unreviewed = lambda b, d: ([{"number": 1, "url": "u", "reviews": []}], None)
    reviewed = lambda b, d: ([{"number": 7, "url": "u", "reviews": [{"state": "COMMENTED"}]}], None)
    gh_down = lambda b, d: (None, "`gh pr list` exited 1: auth required")
    on_feat = lambda d: "feat"
    detached = lambda d: None

    def v(cmd, lookup=no_pr, head=on_feat):
        return violation(shlex.split(cmd), "/repo", lookup, head)

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

    # bare --force slipping through the lease carve-out
    assert v("git push --force origin main") is not None
    # a short -f cluster read as a lease
    assert v("git push -f origin main") is not None
    assert v("git push -fu origin main") is not None
    # a +refspec force treated as a plain push
    assert v("git push origin +main") is not None
    assert v("git push origin +HEAD:main") is not None
    # --force with a lease beside it must still be denied
    assert v("git push --force --force-with-lease origin main") is not None
    # lease denied even when the branch has no review comments
    assert v("git push --force-with-lease origin main", lookup=no_pr) is None
    assert v("git push --force-with-lease=main:abc123 origin main", lookup=unreviewed) is None
    # lease allowed onto a PR that carries review comments
    assert v("git push --force-with-lease origin main", lookup=reviewed) is not None
    assert v("git push --force-with-lease", lookup=reviewed) is not None
    # gh failure read as "no PR" (fail open)
    assert v("git push --force-with-lease origin main", lookup=gh_down) is not None
    # --force-if-includes alone accepted as if it were a lease
    assert v("git push --force-if-includes origin main") is not None
    # lease + if-includes denied although the PR has no reviews
    assert v("git push --force-with-lease --force-if-includes origin main") is None
    # detached HEAD with no refspec allowed without knowing the branch
    assert v("git push --force-with-lease", head=detached) is not None
    # --all lease allowed without checking each branch
    assert v("git push --force-with-lease --all origin") is not None

    seen = []
    violation(shlex.split("git push --force-with-lease origin HEAD:refs/heads/x"), "/r",
              lambda b, d: seen.append((b, d)) or ([], None), on_feat)
    # refs/heads/ prefix passed to gh, which then finds no PR and allows
    assert seen == [("x", "/r")], seen
    seen.clear()
    violation(shlex.split("git -C sub push --force-with-lease -o ci.skip origin"), "/r",
              lambda b, d: seen.append((b, d)) or ([], None), lambda d: d + ":cur")
    # -C dir ignored, or an option value (-o ci.skip) mistaken for a refspec
    assert seen == [("/r/sub:cur", "/r/sub")], seen

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
