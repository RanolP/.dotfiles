---
name: git-master
description: Disciplined git workflow — inspect before acting, Conventional-Commits messages, atomic commits, deliberate staging, commit and push as separate steps, fetch-first preflights that branch off the remote base and catch a stale base, a merged/deleted upstream, or an accidental push from main, and fail-closed guardrails on destructive ops. Use when staging, committing, branching, pushing, pulling, rebasing, or rewriting history.
---

# Git master

Apply these whenever you touch git. Project CLAUDE.md always wins where it differs (this repo: commits go to `main`; pushes only to `claude/*`). A `git-push-guard` hook independently blocks non-`claude/*` pushes and compound pushes — these rules teach the workflow that satisfies it, they don't replace it.

## Inspect before acting

Never compose a commit blind. Run, and actually read:

- `git status` — what's staged, unstaged, untracked.
- `git diff` and `git diff --staged` — the actual change, unstaged and staged separately.
- `git log --oneline -15` — match the repo's existing message style (type set, scope convention, casing) before writing your own.

## Commit messages — Conventional Commits

Format: `type(scope): subject`. Scope is optional but preferred when it sharpens the change.

- **Types**: `feat` (new feature), `fix` (bug fix), `docs`, `refactor`, `perf`, `test`, `chore`, `build`, `ci`.
- **Subject**: imperative mood ("add", not "added"/"adds"), capitalized, no trailing period, ≤50 chars (hard ceiling 72). It must complete "If applied, this commit will ___".
- **Body** (when the change isn't self-evident): blank line after subject, wrap at 72, explain *why* and *what changed at a high level* — not how (the diff shows how).
- **Breaking change**: append `!` after type/scope (`feat(api)!: ...`) and/or add a `BREAKING CHANGE: <description>` footer.
- **Trailer**: keep `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (mandated by CLAUDE.md).
- **Banned subjects**: `fix`, `wip`, `update`, `changes`, `stuff`, and other contentless words. Say what changed.

## Atomic commits

One logical change per commit. The working tree should build/pass after each commit. If a change mixes concerns (a refactor plus a feature), split it into separate commits with explicit path staging.

## Staging discipline

- Stage explicit paths (`git add path/to/file`). Never blind `git add -A` or `git add .` — you'll sweep in unintended files.
- Never stage secrets, `.env`, credentials, build artifacts, dependency dirs, or large binaries.
- `.gitignore` only affects *untracked* files. If a file is already tracked, ignoring it does nothing — use `git rm --cached <file>` to stop tracking it (keeps it on disk).

## Commit and push are separate steps

Never chain `git commit … && git push` (also blocked by the hook). A local commit is private and reversible; a push is shared and effectively permanent. Commit, verify the result, then push as its own deliberate command — and only when asked.

## Branch preflight — fetch, then branch off the remote base

Your local `main` is stale the moment someone else merges. Branching off it buys a rebase later. Run this before you create any branch:

```sh
git fetch --prune                                          # 1. refresh remotes + drop deleted ones
git symbolic-ref --short refs/remotes/origin/HEAD          # 2. the real default branch (origin/main, origin/master, …)
git switch -c feat/topic origin/main                       # 3. branch off the REMOTE base, never local main
```

If step 2 fails, run `git remote set-head origin -a` once, then retry.

- Name branches kebab-case `type/desc` (`feat/skill-loader`, `fix/push-guard`).
- Working tree must be clean first — `git status` then stash or commit; never branch out of a dirty tree.
- Already committed onto a stale base? `git rebase --onto origin/main <old-base> HEAD` rather than merging the base in.

## Push preflight — fetch, then answer three questions

Every push starts with `git fetch --prune`. Ahead/behind and `[gone]` markers are lies until you fetch. Then check, in order:

1. **Am I on a branch I may push?** `git branch --show-current`. If it prints `main`/`master`, stop — you never made a branch. Create one off the remote base (`git switch -c <name> origin/main` keeps the commits you already made on main), then push that.
2. **Is my upstream still alive?** `git status -sb`. A `[gone]` upstream means the remote branch was deleted — usually because its PR merged. Confirm with `gh pr list --head <branch> --state all --json number,state,mergedAt`. If it merged, that branch is finished: start a fresh branch off `origin/main` for the new work instead of resurrecting the dead one.
3. **What exactly goes up?** `git log @{u}..HEAD` and `git diff @{u}..HEAD`. If `git status -sb` says behind, run `git pull --rebase` first (linear history, no merge bubbles for routine syncs).

Push only to `claude/*` branches (`git push -u origin claude/<topic>`), unless project CLAUDE.md says otherwise (this repo: dotfiles commits land on `main`, push is the user's call). Never bare `git push` / `git push origin` — the target must be explicit.

## Destructive-op guardrails — fail closed: confirm + back up first

Default to the non-destructive option. For each below, confirm with the user and create a backup (branch/stash/tag) before running:

- **Force-push**: only `git push --force-with-lease --force-if-includes`, never plain `--force`. Never force-push a shared or default branch.
- **`reset --hard`**: `git stash` (or branch) first — it discards uncommitted work irrecoverably.
- **`clean -fd`**: run `git clean -nd` (dry-run) first and read the list before deleting.
- **Amend / rebase of *pushed* commits**: prefer `git revert` over amend, and `git merge` over rebasing a shared branch. Rewriting published history breaks everyone downstream.
- **Branch delete**: prefer `git branch -d` (refuses if unmerged) over `git branch -D` (force).

Never use `--no-verify` or otherwise skip hooks by default. Never use interactive flags (`-i` — unsupported here). Never commit unless asked. Never modify `git config`.

---

*Distilled from [Conventional Commits](https://www.conventionalcommits.org/), [Pro Git](https://git-scm.com/book), [cbea.ms 50/72](https://cbea.ms/git-commit/), and anthropics/claude-code conventions. Complements the `git-push-guard` hook; defers to project CLAUDE.md.*
