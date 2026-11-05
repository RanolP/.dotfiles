#!/usr/bin/env python3
"""PostToolUse: remember every GitHub repository a session actually touches.

The deployment-splitting incident crossed two repositories while the session
cwd was not a work tree. A later answer queried only the remembered human
author and missed a bot-owned release PR in the other repository. Keeping a
small, local session inventory lets the prompt-time snapshot query the full
remote state instead of guessing scope from cwd or authorship.

This hook performs no network requests and emits no stdout. Every failure is
fail-open so repository tracking can never turn a successful Bash call into a
hook error.

Self-check: `python3 remote-repo-tracker.py --selftest`.
"""
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

MAX_REPOS = 8
GIT_TIMEOUT_S = 0.75
SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
GH_API_RE = re.compile(r"(?:^|\s)gh\s+api\s+(?:--[^\s]+\s+)*['\"]?repos/([^/\s'\"]+)/([^/\s?'\"]+)")


def state_dir():
    return Path(
        os.environ.get("CLAUDE_REMOTE_REPOS_DIR", "~/.claude/state/remote-repos")
    ).expanduser()


def state_path(session_id):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(session_id))[:180]
    return state_dir() / f"{safe}.json" if safe else None


def shell_words(command):
    try:
        return shlex.split(command, comments=False, posix=True)
    except ValueError:
        return command.split()


def command_refs(command):
    """Return explicit GitHub slugs and local paths in command order."""
    if not isinstance(command, str):
        return [], []
    slugs = []
    paths = []
    needs_words = any(marker in command for marker in (" -R ", " --repo", "git -C"))
    words = shell_words(command) if needs_words else []
    for index, word in enumerate(words):
        candidate = None
        if word in ("-R", "--repo") and index + 1 < len(words):
            candidate = words[index + 1]
        elif word.startswith("--repo="):
            candidate = word.split("=", 1)[1]
        if candidate:
            candidate = candidate.rstrip(";&|")
        if candidate and SLUG_RE.fullmatch(candidate):
            slugs.append(candidate.removesuffix(".git"))

        if word == "git" and index + 2 < len(words) and words[index + 1] == "-C":
            paths.append(words[index + 2])

    for match in GH_API_RE.finditer(command):
        slug = f"{match.group(1)}/{match.group(2).removesuffix('.git')}"
        if SLUG_RE.fullmatch(slug):
            slugs.append(slug)

    cd_match = re.match(r"^\s*cd(?:\s+--)?\s+([^;&|\n]+)", command)
    if cd_match:
        value = cd_match.group(1).strip()
        try:
            parsed = shlex.split(value)
            if parsed:
                paths.append(parsed[0])
        except ValueError:
            pass
    return list(dict.fromkeys(slugs)), list(dict.fromkeys(paths))


def run_git(path, *args):
    try:
        result = subprocess.run(
            ["git", "-C", str(path), *args],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_S,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout.strip() if result.returncode == 0 else None


def github_slug(remote):
    if not remote:
        return None
    patterns = (
        r"^(?:https?://|ssh://git@)github\.com[/:]([^/]+)/([^/]+?)(?:\.git)?$",
        r"^git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$",
    )
    for pattern in patterns:
        match = re.match(pattern, remote.strip())
        if match:
            slug = f"{match.group(1)}/{match.group(2)}"
            return slug if SLUG_RE.fullmatch(slug) else None
    return None


def local_repo(path, cwd):
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = Path(cwd or os.getcwd()) / candidate
    top = run_git(candidate, "rev-parse", "--show-toplevel")
    if not top:
        return None
    slug = github_slug(run_git(top, "remote", "get-url", "origin"))
    return {"slug": slug, "path": top} if slug else None


def read_entries(path):
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    return value if isinstance(value, list) else []


def write_entries(path, observations):
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    current = read_entries(path)
    merged = {}
    for observation in observations:
        slug = observation.get("slug")
        if not isinstance(slug, str) or not SLUG_RE.fullmatch(slug):
            continue
        prior = next(
            (item for item in current if isinstance(item, dict) and item.get("slug") == slug),
            {},
        )
        merged[slug] = {
            "slug": slug,
            "path": observation.get("path") or prior.get("path"),
            "last_seen": now,
        }
    for item in current:
        slug = item.get("slug") if isinstance(item, dict) else None
        if slug not in merged and isinstance(slug, str) and SLUG_RE.fullmatch(slug):
            merged[slug] = {
                "slug": slug,
                "path": item.get("path"),
                "last_seen": item.get("last_seen"),
            }
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".tmp.{os.getpid()}")
    temporary.write_text(json.dumps(list(merged.values())[:MAX_REPOS], separators=(",", ":")) + "\n")
    os.replace(temporary, path)


def main():
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return 0
        path = state_path(payload.get("session_id"))
        if path is None:
            return 0
        tool_input = payload.get("tool_input")
        command = tool_input.get("command") if isinstance(tool_input, dict) else None
        cwd = payload.get("cwd") if isinstance(payload.get("cwd"), str) else os.getcwd()
        slugs, paths = command_refs(command)
        observations = [{"slug": slug, "path": None} for slug in slugs]
        for candidate in [*paths, cwd]:
            repo = local_repo(candidate, cwd)
            if repo:
                observations.append(repo)
        if observations:
            write_entries(path, observations)
    except Exception as error:
        print(f"remote-repo-tracker: {error}", file=sys.stderr)
    return 0


def selftest():
    slugs, paths = command_refs(
        "gh pr list -R acme/web-app; git -C '../infra repo' log"
    )
    assert slugs == ["acme/web-app"], slugs
    assert paths == ["../infra repo"], paths
    slugs, paths = command_refs("cd /work/repo && gh api repos/acme/infra/pulls")
    assert slugs == ["acme/infra"], slugs
    assert paths == ["/work/repo"], paths
    assert github_slug("git@github.com:acme/web-app.git") == "acme/web-app"
    print("remote-repo-tracker selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        sys.exit(main())
