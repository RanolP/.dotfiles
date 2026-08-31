#!/usr/bin/env python3
"""Semantics test for git-push-guard.py: the bypass is read at the PUSH TARGET.

`git -C <path> push` publishes the repo at <path>, so the shell's cwd says
nothing about which repo is being pushed. When the guard read
`.nanno-workers.json` from cwd, a bypass file in one checkout authorised a
`main` push into an unrelated repo, and a legitimate `-C ~/.dotfiles push
origin main` issued from elsewhere was denied. These cases pin the target-folder
rule down.

The fixture repos are temp directories -- the guard only reads
`.nanno-workers.json` off the resolved path, so no real git repo is needed.

Usage: git-push-guard-test.py   (exit 0 when every case passes)
"""

import json
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "nix", "home", "configs", "claude", "hooks", "git-push-guard.py")


def decision(cmd, cwd):
    p = subprocess.run([sys.executable, HOOK], text=True, capture_output=True, timeout=30,
                       input=json.dumps({"tool_name": "Bash", "cwd": cwd,
                                         "tool_input": {"command": cmd}}))
    if p.returncode != 0:
        return "error(%d): %s" % (p.returncode, p.stderr.strip()[-200:])
    if not p.stdout.strip():
        return "passthrough"
    return json.loads(p.stdout)["hookSpecificOutput"]["permissionDecision"]


def main():
    with tempfile.TemporaryDirectory() as root:
        allowed = os.path.join(root, "bypassed")
        plain = os.path.join(root, "plain")
        os.makedirs(os.path.join(allowed, "sub"))
        os.makedirs(os.path.join(plain, ".git"))
        with open(os.path.join(allowed, ".nanno-workers.json"), "w") as fh:
            json.dump({"git_push_guard_bypass": True}, fh)
        with open(os.path.join(plain, ".nanno-workers.json"), "w") as fh:
            json.dump({"git_push_guard_bypass": False}, fh)

        cases = [
            ("bypassed cwd pushes main", "git push origin main", allowed, "allow"),
            ("bypass inherited by subdir", "git push origin main",
             os.path.join(allowed, "sub"), "allow"),
            ("plain cwd cannot push main", "git push origin main", plain, "deny"),
            ("-C into a plain repo is denied from a bypassed cwd",
             "git -C %s push origin main" % plain, allowed, "deny"),
            ("-C into the bypassed repo is allowed from a plain cwd",
             "git -C %s push origin main" % allowed, plain, "allow"),
            ("relative -C resolves against cwd", "git -C sub push origin main", allowed, "allow"),
            ("--git-dir= names the target too",
             "git --git-dir=%s/.git push origin main" % plain, allowed, "deny"),
            ("-c does not swallow the -C path",
             "git -c a=b -C %s push origin main" % plain, allowed, "deny"),
            ("claude/* stays allowed without any bypass",
             "git push origin claude/topic", plain, "allow"),
            ("git stash push is not a push", "git stash push", plain, "passthrough"),
        ]

        failures = 0
        for name, cmd, cwd, want in cases:
            got = decision(cmd, cwd)
            ok = got == want
            failures += not ok
            print("%s  %-46s want=%s got=%s" % ("ok  " if ok else "FAIL", name, want, got))
        return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
