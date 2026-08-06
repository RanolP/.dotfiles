---
name: worktree-cleanup
description: Audit and remove finished git worktrees — prune stale registrations, classify each worktree as finished/unfinished from its dirty state, unpushed commits, and merged-or-gone upstream, then remove only the safe ones and delete their branches. Use when worktrees pile up, a worktree add fails on a name already in use, `git worktree list` shows paths that no longer exist, or the user asks to clean up worktrees.
---

# Worktree cleanup

Removing a worktree can destroy work that exists nowhere else — an uncommitted edit or a commit never pushed. So this runs as audit first, removal second, and every removal is a judgment you can defend from the audit output.

Defers to `git-master` for branch/push mechanics and its destructive-op guardrails.

## 1. Refresh, then inventory

```sh
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

For each path from step 1, collect all four facts before deciding anything:

```sh
git -C <path> status --porcelain           # empty = clean tree
git -C <path> status -sb                   # ahead/behind; `[gone]` = upstream deleted
git -C <path> log @{u}..HEAD --oneline     # commits not on the remote (fails if no upstream — that itself is a finding)
git -C <path> log --oneline -1             # what the work was, for the report
```

A worktree is **finished** only when all of these hold:

- Tree is clean — `status --porcelain` prints nothing.
- Nothing unpushed — `log @{u}..HEAD` prints nothing.
- Branch is done — upstream is `[gone]`, or the branch is merged into the remote default branch (`git branch -r --merged origin/main` lists it), or its PR merged (`gh pr list --head <branch> --state all --json number,state,mergedAt`).

Anything else is **unfinished**: no upstream at all, unpushed commits, uncommitted changes, or an open PR.

## 4. Report before you remove

Show the user one line per worktree — path, branch, verdict, and the reason. Then remove only the finished ones:

```sh
git worktree remove <path>         # refuses when the tree is dirty; that refusal is the safety net
git branch -d <branch>             # refuses when unmerged; same safety net
```

Leave every unfinished worktree in place and name what it is holding, so the user can decide.

## Guardrails — fail closed

- **Never `git worktree remove --force`** without explicit user confirmation. The flag exists to override the dirty-tree refusal, which means it deletes uncommitted work.
- **Never `git branch -D`** to clear a leftover branch. If `-d` refuses, the branch has unmerged commits — report that instead.
- **A locked worktree is locked on purpose** (removable media, a long-running run). Report it with its reason (`git worktree list --porcelain` prints the lock reason) and leave it. Only unlock (`git worktree unlock <path>`) when the user says so.
- **Never `rm -rf` a worktree directory.** That leaves the registration behind and loses `git worktree remove`'s dirty-tree check.
- **The main worktree is not removable.** Skip the first entry of `git worktree list`.
- When a worktree looks finished but you cannot reach the remote to confirm the merge, treat it as unfinished. Uncertainty means keep.

---

*Distilled from [git-worktree(1)](https://git-scm.com/docs/git-worktree). Defers to `git-master` for git mechanics.*
