#!/usr/bin/env python3
"""Semantics test for declarative-package-guard.py.

The guard denies an imperative package install/upgrade/remove and names the
declaration file to edit instead (`nix/home/mise-global.toml`,
`nix/darwin/default.nix`, or the flake). It stays silent on every read-only
query, on a project-local install, and on anything it cannot parse -- a false
deny sits in front of every Bash call on the machine, so fail-open is the whole
design.

Usage: declarative-package-guard-test.py   (exit 0 when every case passes)
"""

import json
import os
import subprocess
import sys

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "nix", "home", "configs", "claude", "hooks",
                    "declarative-package-guard.py")


def decision(cmd):
    p = subprocess.run([sys.executable, HOOK], text=True, capture_output=True, timeout=30,
                       input=json.dumps({"tool_name": "Bash", "cwd": "/repo",
                                         "tool_input": {"command": cmd}}))
    if p.returncode != 0:
        return "error(%d): %s" % (p.returncode, p.stderr.strip()[-200:])
    if not p.stdout.strip():
        return "passthrough"
    return json.loads(p.stdout)["hookSpecificOutput"]["permissionDecision"]


def reason(cmd):
    p = subprocess.run([sys.executable, HOOK], text=True, capture_output=True, timeout=30,
                       input=json.dumps({"tool_name": "Bash", "cwd": "/repo",
                                         "tool_input": {"command": cmd}}))
    if not p.stdout.strip():
        return ""
    return json.loads(p.stdout)["hookSpecificOutput"]["permissionDecisionReason"]


CASES = [
    # the incident itself
    ("npm global install", "npm i -g corepack npm pi-subagents", "deny"),
    ("brew blanket upgrade", "brew upgrade", "deny"),

    ("npm install --global", "npm install --global typescript", "deny"),
    ("npm uninstall -g", "npm uninstall -g typescript", "deny"),
    ("npm local install", "npm install", "passthrough"),
    ("npm ci", "npm ci", "passthrough"),
    ("npm outdated", "npm outdated", "passthrough"),
    ("npm ls -g", "npm ls -g --depth=0", "passthrough"),
    ("pnpm add -g", "pnpm add -g tsx", "deny"),
    ("pnpm install", "pnpm install", "passthrough"),
    ("yarn global add", "yarn global add tsx", "deny"),
    ("bun install -g", "bun install -g tsx", "deny"),

    ("pipx install", "pipx install reuse", "deny"),
    ("pipx list", "pipx list", "passthrough"),
    ("uv tool install", "uv tool install ruff", "deny"),
    ("uv run", "uv run pytest", "passthrough"),
    ("pip install --user", "pip install --user requests", "deny"),
    ("pip install in a venv", "pip install requests", "passthrough"),
    ("pip install -r", "pip install -r requirements.txt", "passthrough"),
    ("python -m pip --user", "python3 -m pip install --user requests", "deny"),

    ("cargo install", "cargo install ripgrep", "deny"),
    ("go install", "go install golang.org/x/tools/gopls@latest", "deny"),
    ("gem install", "gem install bundler", "deny"),

    ("brew install", "brew install jq", "deny"),
    ("brew tap", "brew tap homebrew/cask-fonts", "deny"),
    ("brew outdated", "brew outdated", "passthrough"),
    ("brew list", "brew list --versions", "passthrough"),
    ("brew info", "brew info jq", "passthrough"),

    ("mise use -g", "mise use -g node@24", "deny"),
    ("mise use --global", "mise use --global node@24", "deny"),
    ("mise global", "mise global node@24", "deny"),
    ("mise install", "mise install", "passthrough"),
    ("mise install a tool", "mise install node@24", "passthrough"),
    ("mise ls", "mise ls", "passthrough"),
    ("mise outdated", "mise outdated", "passthrough"),

    ("nix profile install", "nix profile install nixpkgs#jq", "deny"),
    ("nix-env -i", "nix-env -iA nixpkgs.jq", "deny"),
    ("nix flake update", "nix flake update", "passthrough"),
    ("nix flake metadata", "nix flake metadata", "passthrough"),
    ("nix build", "nix build .#darwinConfigurations.host.system --dry-run", "passthrough"),
    ("darwin-rebuild", "sudo darwin-rebuild switch --flake ~/.dotfiles/nix#host", "passthrough"),
    ("home-manager switch", "home-manager switch --flake ~/.dotfiles/nix#host -b before-hm",
     "passthrough"),

    # compound and prefixed forms
    ("compound global install", "cd /tmp && npm i -g pi-subagents", "deny"),
    ("second segment brew", "git status; brew install jq", "deny"),
    ("sudo wrapper", "sudo -E gem install bundler", "deny"),
    ("env assignment prefix", "FOO=1 npm i -g tsx", "deny"),
    ("compound of allowed things", "cd /repo && npm ci && npm outdated", "passthrough"),

    # fail open
    ("unterminated quote", "npm i -g 'unclosed", "passthrough"),
    ("global flag inside quotes", "echo 'npm i -g x'", "passthrough"),
    ("empty command", "", "passthrough"),
    ("unrelated command", "rg -n install .", "passthrough"),
]


def main():
    failures = 0
    for name, cmd, want in CASES:
        got = decision(cmd)
        ok = got == want
        failures += not ok
        print("%s  %-30s want=%-11s got=%s" % ("ok  " if ok else "FAIL", name, want, got))

    # A deny is only useful if it names the file to edit.
    checks = [
        ("npm i -g tsx", "nix/home/mise-global.toml"),
        ("brew install jq", "nix/darwin/default.nix"),
        ("nix profile install nixpkgs#jq", "nix/flake.nix"),
    ]
    for cmd, needle in checks:
        text = reason(cmd)
        ok = needle in text
        failures += not ok
        print("%s  reason for %-32s names %s" % ("ok  " if ok else "FAIL", cmd, needle))

    print("%d/%d passed" % (len(CASES) + len(checks) - failures, len(CASES) + len(checks)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
