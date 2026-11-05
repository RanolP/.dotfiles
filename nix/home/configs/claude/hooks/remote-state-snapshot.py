#!/usr/bin/env python3
"""UserPromptSubmit: inject fresh origin and all-author PR state when relevant.

The deployment-splitting incident used an author-filtered PR list, missed a
bot-owned release PR, and trusted an UNKNOWN merge state. This hook refreshes
every repository observed in the session and re-queries ambiguous open PRs so
answers about PRs, releases, deployment, and branches start from broad live
state rather than a stale or narrowly filtered view.

The snapshot is bounded by per-process timeouts and one eight-second wall
deadline. Every failure is rendered as context or fails open on stderr.

Self-check: `python3 remote-state-snapshot.py --selftest`.
"""
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

KST = timezone(timedelta(hours=9), "KST")
WALL_TIMEOUT_S = 8.0
PROCESS_TIMEOUT_S = 3.0
MAX_REPOS = 4
MAX_UNKNOWN_PRS = 5
TRIGGER_RE = re.compile(
    # ASCII-only boundaries: Korean particles are \w, so `\bpr\b` misses "PR을".
    r"(?<![A-Za-z])(?:prs?(?![a-z])|pull\s+request|merge|deploy|release|branch|"
    r"rebase|push|remote|origin|stack)|머지|배포|릴리스|브랜치|리베이스|푸시|"
    r"리모트|스택|#\d+",
    re.IGNORECASE,
)


def state_dir():
    return Path(
        os.environ.get("CLAUDE_REMOTE_REPOS_DIR", "~/.claude/state/remote-repos")
    ).expanduser()


def state_path(session_id):
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", str(session_id))[:180]
    return state_dir() / f"{safe}.json" if safe else None


def github_slug(remote):
    if not remote:
        return None
    for pattern in (
        r"^(?:https?://|ssh://git@)github\.com[/:]([^/]+)/([^/]+?)(?:\.git)?$",
        r"^git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$",
    ):
        match = re.match(pattern, remote.strip())
        if match:
            return f"{match.group(1)}/{match.group(2)}"
    return None


def run(command, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return None, "overall deadline exceeded"
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=min(PROCESS_TIMEOUT_S, remaining),
        )
    except subprocess.TimeoutExpired:
        return None, f"timed out after {min(PROCESS_TIMEOUT_S, remaining):.1f}s"
    except OSError as error:
        return None, str(error)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().replace("\n", " ")
        return None, detail[:240] or f"exit {result.returncode}"
    return result.stdout, None


def local_repo(path, deadline):
    if not path:
        return None
    top, error = run(["git", "-C", str(path), "rev-parse", "--show-toplevel"], deadline)
    if error:
        return None
    remote, error = run(["git", "-C", top.strip(), "remote", "get-url", "origin"], deadline)
    slug = github_slug(remote.strip()) if not error else None
    return {"slug": slug, "path": top.strip()} if slug else None


def read_tracked(session_id):
    path = state_path(session_id)
    if path is None:
        return []
    try:
        entries = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(entries, list):
        return []
    return [item for item in entries if isinstance(item, dict) and item.get("slug")][:MAX_REPOS]


def repositories(payload, deadline):
    entries = read_tracked(payload.get("session_id"))
    cwd = payload.get("cwd")
    current = local_repo(cwd, deadline) if isinstance(cwd, str) else None
    if current:
        entries.append(current)
    deduped = {}
    for entry in entries:
        slug = entry.get("slug")
        if not isinstance(slug, str) or "/" not in slug:
            continue
        if slug in deduped:
            deduped[slug]["path"] = deduped[slug].get("path") or entry.get("path")
        else:
            deduped[slug] = {"slug": slug, "path": entry.get("path")}
    # The cwd repository is additive: four tracked remotes plus a distinct cwd
    # can legitimately produce five snapshots.
    return list(deduped.values())


def refresh_unknown(repo, prs, deadline, failures):
    unknown = [
        pr for pr in prs
        if pr.get("state") == "OPEN" and pr.get("mergeStateStatus") == "UNKNOWN"
    ][:MAX_UNKNOWN_PRS]
    for pr in unknown:
        number = pr.get("number")
        output, error = run(
            ["gh", "pr", "view", str(number), "-R", repo["slug"], "--json",
             "number,mergeable,mergeStateStatus"],
            deadline,
        )
        if error:
            failures.append(f"[{repo['slug']}] pr view #{number} failed: {error}")
            continue
        try:
            fresh = json.loads(output)
            state = fresh.get("mergeStateStatus")
            if not state or state == "UNKNOWN":
                state = fresh.get("mergeable")
            if state:
                pr["mergeStateStatus"] = state
        except (TypeError, ValueError) as error:
            failures.append(f"[{repo['slug']}] pr view #{number} failed: invalid JSON ({error})")


def snapshot_repo(repo, deadline):
    failures = []
    log_lines = []
    path = repo.get("path")
    if path:
        _, error = run(["git", "-C", path, "fetch", "--quiet", "--prune", "origin"], deadline)
        if error:
            failures.append(f"[{repo['slug']}] git fetch failed: {error}")
        output, error = run(
            ["git", "-C", path, "log", "--oneline", "-5", "origin/HEAD"], deadline
        )
        if error:
            failures.append(f"[{repo['slug']}] origin/HEAD log failed: {error}")
        else:
            log_lines = output.splitlines()

    output, error = run(
        ["gh", "pr", "list", "-R", repo["slug"], "--state", "all", "--limit", "20",
         "--search", "sort:updated-desc", "--json",
         "number,state,isDraft,author,headRefName,baseRefName,mergeStateStatus,updatedAt,title"],
        deadline,
    )
    prs = []
    if error:
        failures.append(f"[{repo['slug']}] gh pr list failed: {error}")
    else:
        try:
            value = json.loads(output)
            prs = value if isinstance(value, list) else []
            if not isinstance(value, list):
                failures.append(f"[{repo['slug']}] gh pr list failed: JSON was not a list")
        except (TypeError, ValueError) as parse_error:
            failures.append(f"[{repo['slug']}] gh pr list failed: invalid JSON ({parse_error})")
    refresh_unknown(repo, prs, deadline, failures)
    return {"repo": repo, "logs": log_lines, "prs": prs, "failures": failures}


def kst_time(raw):
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return parsed.astimezone(KST).strftime("%Y-%m-%d %H:%M KST")
    except (AttributeError, ValueError):
        return str(raw or "unknown-time")


def format_context(results, stamp):
    lines = [f"Remote snapshot {stamp} (hook remote-state-snapshot)"]
    for result in results:
        slug = result["repo"]["slug"]
        for line in result["logs"]:
            lines.append(f"[{slug} origin/HEAD] {line}")
        for pr in result["prs"]:
            author = pr.get("author") or {}
            author_name = author.get("login") if isinstance(author, dict) else str(author)
            draft = " draft" if pr.get("isDraft") else ""
            title = " ".join(str(pr.get("title") or "").split())
            lines.append(
                f"[{slug}] #{pr.get('number')} {pr.get('state')}{draft} "
                f"{pr.get('headRefName')}->{pr.get('baseRefName')} "
                f"{pr.get('mergeStateStatus')} {kst_time(pr.get('updatedAt'))} "
                f"{author_name or 'unknown-author'} {title}"
            )
        lines.extend(result["failures"])
    lines.append(
        f"This is the live remote state as of {stamp}; re-query the affected repository before mutating anything."
    )
    return "\n".join(lines)


def main():
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            return 0
        prompt = payload.get("prompt")
        if not isinstance(prompt, str) or not TRIGGER_RE.search(prompt):
            return 0
        deadline = time.monotonic() + WALL_TIMEOUT_S
        repos = repositories(payload, deadline)
        if not repos:
            return 0

        by_slug = {}
        executor = concurrent.futures.ThreadPoolExecutor(max_workers=len(repos))
        futures = {executor.submit(snapshot_repo, repo, deadline): repo for repo in repos}
        try:
            for future in concurrent.futures.as_completed(
                futures, timeout=max(0.01, deadline - time.monotonic())
            ):
                repo = futures[future]
                try:
                    by_slug[repo["slug"]] = future.result()
                except Exception as error:
                    by_slug[repo["slug"]] = {
                        "repo": repo, "logs": [], "prs": [],
                        "failures": [f"[{repo['slug']}] snapshot failed: {error}"],
                    }
        except concurrent.futures.TimeoutError:
            pass
        finally:
            executor.shutdown(wait=False, cancel_futures=True)

        for repo in repos:
            by_slug.setdefault(repo["slug"], {
                "repo": repo, "logs": [], "prs": [],
                "failures": [f"[{repo['slug']}] snapshot timed out: overall {WALL_TIMEOUT_S:.0f}s cap"],
            })
        stamp = datetime.now(KST).strftime("%Y-%m-%d %H:%M:%S KST")
        context = format_context([by_slug[repo["slug"]] for repo in repos], stamp)
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": context,
        }}, ensure_ascii=False))
    except Exception as error:
        print(f"remote-state-snapshot: {error}", file=sys.stderr)
    return 0


def selftest():
    assert not TRIGGER_RE.search("고마워")
    assert not TRIGGER_RE.search("approve the prompt")
    for prompt in ("PRs #42", "PR을 나눠서", "merged it","배포 스택", "release branch", "리베이스 후 푸시"):
        assert TRIGGER_RE.search(prompt), prompt
    context = format_context([{
        "repo": {"slug": "o/r"}, "logs": ["abc subject"],
        "prs": [{"number": 1, "state": "OPEN", "isDraft": False, "headRefName": "h",
                 "baseRefName": "main", "mergeStateStatus": "CONFLICTING",
                 "updatedAt": "2026-11-05T00:00:00Z", "author": {"login": "bot"},
                 "title": "Release"}], "failures": [],
    }], "2026-11-05 09:00:00 KST")
    assert "#1 OPEN h->main CONFLICTING" in context
    assert "bot Release" in context
    print("remote-state-snapshot selftest ok")


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        sys.exit(main())
