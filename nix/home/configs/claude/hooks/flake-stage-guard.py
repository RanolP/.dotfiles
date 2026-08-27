#!/usr/bin/env python3
"""PreToolUse guard: stage untracked files under a flake dir before a rebuild runs.

A nix flake inside a git repo reads the GIT TREE, not the working directory, so a
file that was written but never `git add`ed is invisible to the evaluator. The
failure that produces is unhelpful -- a missing-path error naming a file that is
plainly there -- and the fix is always the same `git add`. The recurring incident:
a new skill lands in `nix/home/configs/.agents/skills/<name>/SKILL.md`, the user
is handed `darwin-rebuild switch --flake ~/.dotfiles/nix#...`, and it fails
because the agent finished editing without staging.

So this hook stages them itself. On any rebuild command carrying a `--flake` (or
`nix build .#...`) it resolves the flake directory, lists the untracked files
under it, `git add`s them, and reports what it staged. Content is untouched and
nothing is committed -- staging is what makes the file visible, and it is undone
with one `git restore --staged`.

Above UNTRACKED_CAP files it stages nothing and says so instead: that many new
paths at once is a generated tree, not a batch of edits, and quietly dragging it
into the index is worse than a failed build.

Fail-open on every parse or git problem -- a broken guard must not block a build.

Self-check: `python3 flake-stage-guard.py --selftest`.
"""
import json
import os
import shlex
import subprocess
import sys

REBUILD_CMDS = {"darwin-rebuild", "nixos-rebuild", "home-manager"}
UNTRACKED_CAP = 50


def flake_refs(toks):
    """Yield every flake reference the token stream carries."""
    seen_rebuild = any(t.rsplit("/", 1)[-1] in REBUILD_CMDS for t in toks)
    seen_nix = any(t.rsplit("/", 1)[-1] == "nix" for t in toks)
    if not (seen_rebuild or seen_nix):
        return
    for i, t in enumerate(toks):
        if t == "--flake" and i + 1 < len(toks):
            yield toks[i + 1]
        elif t.startswith("--flake="):
            yield t[len("--flake="):]
        elif seen_nix and "#" in t and not t.startswith("-"):
            yield t


def flake_dir(ref, cwd):
    """Filesystem directory a flake reference points at, or None."""
    path = ref.split("#", 1)[0]
    for prefix in ("git+file://", "path:"):
        if path.startswith(prefix):
            path = path[len(prefix):]
    if not path or path.startswith(("github:", "http")):
        return None
    path = os.path.expanduser(path)
    if not os.path.isabs(path):
        path = os.path.join(cwd or ".", path)
    path = os.path.normpath(path)
    return path if os.path.isdir(path) else None


def untracked_under(directory):
    """Untracked, non-ignored paths under `directory`, relative to it."""
    out = subprocess.run(
        ["git", "-C", directory, "ls-files", "--others", "--exclude-standard", "--", "."],
        capture_output=True, text=True, timeout=10,
    )
    if out.returncode != 0:
        return []
    return [line for line in out.stdout.splitlines() if line]


def stage(directory, paths):
    return subprocess.run(
        ["git", "-C", directory, "add", "--"] + paths,
        capture_output=True, text=True, timeout=20,
    ).returncode == 0


def report(directory, paths):
    """Stage `paths` and return the sentence describing what happened."""
    if len(paths) > UNTRACKED_CAP:
        return (
            f"{len(paths)} untracked files sit under {directory}. A nix flake reads the "
            f"git tree, so none of them are visible to this build -- but that many at once "
            f"looks generated, so nothing was staged. Stage the ones this build needs by "
            f"name, or say so if the build is expected to ignore them."
        )
    if not stage(directory, paths):
        return (
            f"Untracked files under {directory} are invisible to the flake and `git add` "
            f"failed on them: {', '.join(paths)}. Stage them before re-running."
        )
    listing = "\n".join(f"  - {p}" for p in paths)
    return (
        f"Staged {len(paths)} untracked file(s) under {directory} so the flake can see "
        f"them -- a flake evaluates the git tree, so an unstaged new file fails the "
        f"build:\n{listing}\nContent is unchanged and nothing was committed. Tell the "
        f"user which files this staged when you report the build result."
    )


def main():
    try:
        data = json.load(sys.stdin)
    except (OSError, ValueError):
        sys.exit(0)  # fail-open
    if data.get("tool_name") != "Bash":
        sys.exit(0)
    command = data.get("tool_input", {}).get("command", "")
    if not command:
        sys.exit(0)
    try:
        toks = shlex.split(command)
    except ValueError:
        sys.exit(0)

    cwd = data.get("cwd") or os.getcwd()
    messages, seen = [], set()
    try:
        for ref in flake_refs(toks):
            directory = flake_dir(ref, cwd)
            if not directory or directory in seen:
                continue
            seen.add(directory)
            paths = untracked_under(directory)
            if paths:
                messages.append(report(directory, paths))
    except (OSError, subprocess.SubprocessError):
        sys.exit(0)  # fail-open

    if messages:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "additionalContext": "\n\n".join(messages),
        }}))
    sys.exit(0)


def selftest():
    def refs(cmd):
        return list(flake_refs(shlex.split(cmd)))

    assert refs("sudo darwin-rebuild switch --flake ~/.dotfiles/nix#host") == ["~/.dotfiles/nix#host"]
    assert refs("home-manager switch --flake=/a/b#h -b before-hm") == ["/a/b#h"]
    assert refs("nix build .#darwinConfigurations.host.system --dry-run") == [".#darwinConfigurations.host.system"]
    assert refs("git commit -m 'switch --flake x'") == []
    assert refs("echo hello") == []

    assert flake_dir("github:foo/bar#x", "/tmp") is None
    assert flake_dir("/definitely/not/here#x", "/tmp") is None
    assert flake_dir(".#x", os.getcwd()) == os.path.normpath(os.getcwd())

    # End to end against a throwaway repo: one untracked file gets staged.
    import tempfile
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["git", "-C", tmp, "init", "-q"], check=True)
        open(os.path.join(tmp, "flake.nix"), "w").close()
        os.makedirs(os.path.join(tmp, "sub"))
        open(os.path.join(tmp, "sub", "new.md"), "w").close()
        assert sorted(untracked_under(tmp)) == ["flake.nix", "sub/new.md"]
        msg = report(tmp, sorted(untracked_under(tmp)))
        assert "Staged 2" in msg, msg
        assert untracked_under(tmp) == [], "still untracked after staging"
    print("ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
