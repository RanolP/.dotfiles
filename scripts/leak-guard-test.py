#!/usr/bin/env python3
"""Semantics test for leak-guard.py.

The guard denies a `git commit` in one of the user's public `github.com/RanolP/`
repos when an added line of the staged diff carries a secret or a private
identifier. It stays silent on every other repo, on every non-commit command,
and on anything it cannot read: it fronts every Bash call in every session, so
fail-open is the whole design.

This runs the hook's own --selftest, then drives the deployed entry point
end-to-end: hook-input JSON on stdin, decision JSON on stdout.

Usage: leak-guard-test.py   (exit 0 when every case passes)
"""

import json
import os
import subprocess
import sys
import tempfile

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
HOOK = os.path.join(REPO, "nix", "home", "configs", "claude", "hooks", "leak-guard.py")

GIT_ENV = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
               GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t", GIT_COMMITTER_NAME="t",
               GIT_COMMITTER_EMAIL="t@t", LEAK_GUARD_DENYLIST="/nonexistent/leak-guard/denylist")
GIT_ENV.pop("LEAK_GUARD_ALLOW", None)

# Assembled from pieces so this file's own diff never trips the guard.
SLACK_URL = "https://acme.slack" ".com/archives/" + "C0" "123ABCDEF" + "/p1700000000"


def git(repo, *args):
    subprocess.run(["git", "-C", repo] + list(args), check=True, capture_output=True,
                   timeout=30, env=GIT_ENV)


def make_repo(root, origin, staged_text):
    repo = os.path.join(root, "repo")
    os.makedirs(repo)
    git(repo, "init", "-q")
    git(repo, "remote", "add", "origin", origin)
    with open(os.path.join(repo, "doc.md"), "w") as fh:
        fh.write("clean\n")
    git(repo, "add", "doc.md")
    git(repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init")
    with open(os.path.join(repo, "doc.md"), "a") as fh:
        fh.write(staged_text + "\n")
    git(repo, "add", "doc.md")
    return repo


def run(stdin, cwd=None, env=None):
    """Returns (decision, reason): 'deny' / 'passthrough' / 'error(...)'."""
    payload = stdin if isinstance(stdin, (str, bytes)) else json.dumps(stdin)
    p = subprocess.run([sys.executable, HOOK], input=payload, text=True, capture_output=True,
                       timeout=30, env=env or GIT_ENV, cwd=cwd)
    if p.returncode != 0:
        return "error(%d): %s" % (p.returncode, p.stderr.strip()[-200:]), ""
    if not p.stdout.strip():
        return "passthrough", ""
    out = json.loads(p.stdout)["hookSpecificOutput"]
    return out["permissionDecision"], out["permissionDecisionReason"]


def main():
    failures = 0

    def report(name, want, got):
        nonlocal failures
        ok = got == want
        failures += not ok
        print("%s  %-40s want=%-11s got=%s" % ("ok  " if ok else "FAIL", name, want, got))

    p = subprocess.run([sys.executable, HOOK, "--selftest"], capture_output=True, text=True,
                       timeout=120, env=GIT_ENV)
    report("--selftest", 0, p.returncode)
    if p.returncode != 0:
        print(p.stdout, p.stderr)

    with tempfile.TemporaryDirectory() as root:
        repo = make_repo(root, "https://github.com/RanolP/.dotfiles.git",
                         SLACK_URL)
        payload = lambda cmd: {"tool_name": "Bash", "cwd": repo, "tool_input": {"command": cmd}}

        got, reason = run(payload("git commit -m x"))
        report("staged slack url, RanolP origin", "deny", got)
        for needle in ("doc.md:2:", "slack archive url", "<workspace>.slack.com", "LEAK_GUARD_ALLOW=1"):
            report("deny reason carries %s" % needle, True, needle in reason)

        report("git -C path commit", "deny",
               run({"tool_name": "Bash", "cwd": root,
                    "tool_input": {"command": "git -C repo commit -m x"}})[0])
        report("commit in a second segment", "deny", run(payload("git add -A && git commit -m x"))[0])
        report("LEAK_GUARD_ALLOW=1 prefix", "passthrough",
               run(payload("LEAK_GUARD_ALLOW=1 git commit -m x"))[0])
        report("LEAK_GUARD_ALLOW=1 in environment", "passthrough",
               run(payload("git commit -m x"), env=dict(GIT_ENV, LEAK_GUARD_ALLOW="1"))[0])
        report("non-commit command", "passthrough", run(payload("git status"))[0])
        report("commit word inside quotes", "passthrough", run(payload("echo 'git commit'"))[0])
        report("unterminated quote", "passthrough", run(payload("git commit -m 'x"))[0])

        with open(os.path.join(root, "denylist"), "w") as fh:
            fh.write("# private names\nacme[- ]?corp\n")
        git(repo, "reset", "-q", "--hard")
        with open(os.path.join(repo, "doc.md"), "a") as fh:
            fh.write("shipped at Acme Corp\n")
        git(repo, "add", "doc.md")
        report("denylist match", "deny",
               run(payload("git commit -m x"),
                   env=dict(GIT_ENV, LEAK_GUARD_DENYLIST=os.path.join(root, "denylist")))[0])
        report("same text without denylist", "passthrough", run(payload("git commit -m x"))[0])

    with tempfile.TemporaryDirectory() as root:
        repo = make_repo(root, "git@github.com:some-employer/app.git",
                         SLACK_URL)
        report("non-RanolP origin", "passthrough",
               run({"tool_name": "Bash", "cwd": repo, "tool_input": {"command": "git commit -m x"}})[0])

    # fail open on shapes the harness can produce
    report("not a git directory", "passthrough",
           run({"tool_name": "Bash", "cwd": tempfile.gettempdir(),
                "tool_input": {"command": "git commit -m x"}})[0])
    report("missing cwd", "passthrough",
           run({"tool_name": "Bash", "tool_input": {"command": "git commit -m x"}},
               cwd=tempfile.gettempdir())[0])
    report("not json", "passthrough", run("this is not json")[0])
    report("empty stdin", "passthrough", run("")[0])

    print("%d failure(s)" % failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
