---
name: worktree-cleanup
description: Audit and remove finished git worktrees — prune stale registrations, classify each worktree with a read-only audit script (size, dirty state, unpushed commits, merged by ancestry or by squash-merged PR, recent Claude session use), then remove only the safe ones, delete their branches, and report the disk reclaimed. Use when worktrees pile up, a worktree add fails on a name already in use, `git worktree list` shows paths that no longer exist, or the user asks to clean up worktrees.
---

# Worktree cleanup

Removing a worktree can destroy work that exists nowhere else — an uncommitted edit or a commit never pushed. So this runs as audit first, removal second, and every removal is a judgment you can defend from the audit output.

Defers to `git-master` for branch/push mechanics and its destructive-op guardrails.

## 1. Refresh, then inventory

```sh
df -h /                            # the "before" number for the final report
git fetch --prune                  # merged/gone status is a lie until you fetch
git worktree list --porcelain      # path, HEAD, branch, and any bare/detached/locked/prunable markers
```

`git worktree list` runs the same from any worktree of the repo — you do not need to be in the main one.

## 2. Drop registrations whose directory is gone

```sh
git worktree prune -n              # dry run: read what it would drop
git worktree prune
```

This only deletes bookkeeping under `.git/worktrees` for directories that no longer exist. It never touches a live worktree.

## 3. Classify every remaining worktree

Run the audit next to this file. It reads paths from `git worktree list`, so a worktree outside the usual directory is still listed, and it deletes nothing:

```sh
bash <this skill's dir>/scripts/worktree-audit.sh -b origin/<pr-base> <repo-path>
```

Pass `-b` with the branch PRs merge into; without it the script checks against `origin/HEAD` and warns on stderr. It fetches every PR of the repo once with `gh pr list --state all` and prints one tab-separated row per linked worktree, largest first:

- `MERGED` — `ancestor` when HEAD is reachable from the base (fast-forward or rebase merge); `squash` when the branch's PR is MERGED and the PR's head commit equals this HEAD. A squash merge writes a new commit on the base, so the branch's own commits are never ancestors of it and `git branch -r --merged` or `merge-base` alone report it unmerged; the PR state is the signal. `no` otherwise, including a merged PR whose head differs from the local HEAD (work added after the merge).
- `DIRTY` — `clean`, `wip:N` (N tracked edits, unrecoverable once removed), or `scratch:N` (N untracked files only).
- `REMOTE` — `pushed`, `aheadN`, `gone` (upstream configured, remote branch deleted), `no-remote`, or `detached`.
- `PR` — `#N/state` of the newest PR for the branch (`open`, `draft`, `merged`, `closed`).
- `LAST_CHAT` — the newest Claude Code transcript under `$CLAUDE_CONFIG_DIR/projects` (modified within 14 days) that mentions the path followed by `/` or a quote, so `wt-482` does not match `wt-482-r37`.
- `BUCKET` — first match wins: `hold-wip`, `hold-open-pr`, `verify-recent-chat` (a transcript touched it within 4 days), `safe` (merged and clean), `safe-after-scratch` (merged, untracked files only), `review`.

A worktree is **finished** only when its bucket is `safe` or `safe-after-scratch` and the checks in step 4 confirm it. Anything else is **unfinished**: unmerged, uncommitted changes, an open PR, or a session that may still be using it.

## 4. Report before you remove

The bucket is advice; the user's pinned and in-progress sessions decide. Before removing anything:

- Ask the user which sessions are pinned or still running, and keep every worktree they touch, even one the script marks `safe`.
- For each `verify-recent-chat` row, read the newest matching transcript (a subagent keeps the bulk out of context) and report whether that session is still going and which worktrees it uses. A live session also uses sibling worktrees its background subagents created, whose paths may never appear in its own transcript.
- For each `wip:N` row, show `git -C <path> diff HEAD` and get a keep-or-drop decision.
- For each `scratch:N` row, list the files (`git -C <path> status --porcelain`).

Show the user one line per worktree — path, branch, bucket, and the reason. Then remove only the finished ones:

```sh
git worktree remove <path>         # refuses when the tree is dirty; that refusal is the safety net
git branch -d <branch>             # MERGED=ancestor: refuses when unmerged; same safety net
git branch -D <branch>             # MERGED=squash only: -d always refuses a squash-merged branch
```

`-D` is safe for a `squash` row because the audit matched the branch tip to the merged PR's head commit, so every commit on it is in the base as the squash commit. Re-run the audit right before deleting if anything was committed in between.

Finish with `df -h /` again and report before, after and the space reclaimed.

Leave every unfinished worktree in place and name what it is holding, so the user can decide.

## Guardrails — fail closed

- **Never `git worktree remove --force`** without explicit user confirmation. The flag exists to override the dirty-tree refusal, which means it deletes uncommitted work.
- **Never `git branch -D`** to clear a leftover branch, except a `MERGED=squash` row from a fresh audit. If `-d` refuses on any other branch, the branch has unmerged commits — report that instead.
- **A locked worktree is locked on purpose** (removable media, a long-running run). Report it with its reason (`git worktree list --porcelain` prints the lock reason) and leave it. Only unlock (`git worktree unlock <path>`) when the user says so.
- **Never `rm -rf` a worktree directory.** That leaves the registration behind and loses `git worktree remove`'s dirty-tree check.
- **The main worktree is not removable.** Skip the first entry of `git worktree list`.
- When a worktree looks finished but you cannot reach the remote to confirm the merge, treat it as unfinished. Uncertainty means keep. The audit warns on stderr when `gh pr list` fails; squash-merged rows then show `MERGED=no`.

## Beyond worktrees

When the goal is disk space, offer these after the worktrees, each with its size probe first. Run a reclaimer only after the user picks it, keep any cache the user has said to keep, and include it in the final `df -h /` report.

| Reclaimer | Probe | Reclaim |
| --- | --- | --- |
| Simulator clones from test runs | `du -sh ~/Library/Developer/XCTestDevices` | `xcrun simctl --set testing delete all` |
| Simulators for removed runtimes | `xcrun simctl list devices unavailable` | `xcrun simctl delete unavailable` |
| Old simulator runtimes | `xcrun simctl runtime list` | `xcrun simctl runtime delete <id>` |
| Xcode build products | `du -sh ~/Library/Developer/Xcode/DerivedData` | delete the per-project folders the user names |
| Device symbol caches | `du -sh ~/Library/Developer/Xcode/iOS\ DeviceSupport` | delete the OS versions the user no longer debugs |
| Package caches | `pnpm store path`, `uv cache dir`, `brew --cache`, `yarn cache dir` | `pnpm store prune`, `uv cache prune`, `brew cleanup`, `yarn cache clean` |

---

*Distilled from [git-worktree(1)](https://git-scm.com/docs/git-worktree). Defers to `git-master` for git mechanics.*
