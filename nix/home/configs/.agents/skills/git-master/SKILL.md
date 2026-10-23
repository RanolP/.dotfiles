---
name: git-master
description: Disciplined git workflow — inspect before acting, Conventional-Commits messages, atomic commits, deliberate staging, commit and push as separate steps, fetch-first preflights that branch off the remote base and catch a stale base, a merged/deleted upstream, or an accidental push from main, and fail-closed guardrails on destructive ops. Use when staging, committing, branching, pushing, pulling, rebasing, or rewriting history.
---

# Git master

Apply these whenever you touch git. The nearest `.nanno-workers.json` at or above the working directory decides the workflow: `"git_push_guard_bypass": true` means this checkout may push its own default branch, so commits go straight there. In every other case -- no file, the key absent, or any value but `true` -- work lands on `claude/local-dev` and gets republished as a rebuilt stack. Read that key rather than inferring from the repo name or the file's mere presence, so the commit mode and the push permission cannot drift apart: `git-push-guard.py`'s `bypass_enabled()` resolves the same key by the same nearest-wins, fail-closed rule. Project CLAUDE.md always wins where it differs (this repo: commits go to `main`; pushes only to `claude/*`). A `git-push-guard` hook independently blocks non-`claude/*` pushes and compound pushes — these rules teach the workflow that satisfies it, they don't replace it.

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

One logical change per commit. Each commit building and passing on its own is a property of the stack you publish: check it once, when the stack is rebuilt for review (below), and let local checkpoint commits land unchecked. If a change mixes concerns (a refactor plus a feature), split it into separate commits with explicit path staging.

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

## Publishing a `claude/local-dev` stack

`claude/local-dev` holds checkpoint commits in the order the work happened. A reviewer needs the opposite: one concern per commit, in the order that explains the change. So publishing rebuilds the stack instead of moving it.

`git rebase -i` and `git add -p` are the human tools for this, and neither runs here -- the Bash tool refuses interactive flags. Rebuild by writing the intermediate states yourself:

```sh
git fetch --prune
git switch -c claude/<topic> origin/main   # fresh base, never local main
# then, for each concern in reviewer order:
#   edit the files to that concern's intended state
#   git add <explicit paths>
#   git commit
git diff --exit-code claude/local-dev      # final tree matches, byte for byte
git rebase --exec '<lint and typecheck>' origin/main   # once, at publish: every commit green on its own
```

- Split below the hunk. When one line carries two concerns, write that line's intermediate form in the first commit and its final form in the second.
- The `git diff --exit-code` check is the whole-branch case. Publishing a subset instead? Diff against the tree that subset was meant to reach.
- `--exec` checks out each commit in turn, so a commit that passes only once a later commit lands fails here. That is what the check is for.
- Take the lint and typecheck commands from the repo -- `package.json` scripts, the `Makefile`, or the CI workflow.
- Before review, fold every cleanup or refactor into the commit that introduced the code it touches, splitting a tail commit by file and hunk, and rewrite those commits' messages to match; a reviewer reads commit by commit, so a tail "fix 1, fix 2" commit makes them read code an earlier commit already throws away. One feature is one commit (renderer and wiring together).
- Rejected push: `git fetch` as its own visible step, rebase onto it, and ask the user when the rebase is not obviously safe.
- Count only a human review as a review. The PR author's own explainer comments and a bot review (Codex) leave a rewrite open, but `git-integrity-guard.py` passes the author's comments and blocks on a bot's -- so for a bot-reviewed PR, hand the user `! git -C <repo> push --force-with-lease=<branch>:<fetched-sha> origin <branch>` to run. A branch whose PR carries a human review gets fixup commits on top, never a force-push.
- Continue an epic on the branch that already carries it -- check `git worktree list` and `git branch --list 'claude/*'` first -- and leave the decision to split branches to the user.
- A cleanup or diff-trim pass keeps the last verified commit's runtime behavior: name that baseline commit in the worker brief, have the worker return `behavior_vs_head` listing every runtime difference with the rule that requires it, and revert each difference no rule requires.

## Rebasing a stack -- verify ancestry, not the worker's report

- Before branch surgery, `git worktree list` for stale worktrees that hold the target branch, and remove the clean ones; a stale worktree once replayed a rebase twice and leaked four foreign commits into a PR.
- Done means `git merge-base --is-ancestor <base> <head>` succeeds for each adjacent pair and `git diff <old tip> HEAD` is empty.
- Report a stacked PR as merged only after `git merge-base --is-ancestor <sha> origin/main` succeeds, since a PR merged into its parent branch is not on main.

## Worktrees live in the repo, never in the scratchpad

Start every branch job in `git worktree add <repo>/.claude/worktrees/<name> -b claude/<name> origin/<default>`, install dependencies there, and put that path in the worker brief; the main checkout stays on its default branch, where the user's untracked files would otherwise fail the commit hooks. The session scratchpad is under `/private/tmp`, which macOS empties on reboot, taking an uncommitted worktree with it -- so checkpoint-commit a worker's tree changes as soon as they land.

## Destructive-op guardrails — fail closed: confirm + back up first

Default to the non-destructive option. For each below, confirm with the user and create a backup (branch/stash/tag) before running:

- **Force-push**: only as `--force-with-lease`, and never onto a branch whose open PR carries review comments -- `git-integrity-guard.py` always denies `--force`, `-f`, `+refspec` and a lone `--force-if-includes`, and denies a lease onto a reviewed PR; push fixup commits on top there instead.
- **`reset --hard`**: `git stash` (or branch) first — it discards uncommitted work irrecoverably.
- **`clean -fd`**: run `git clean -nd` (dry-run) first and read the list before deleting.
- **Amend / rebase of *pushed* commits**: prefer `git revert` over amend, and `git merge` over rebasing a shared branch. Rewriting published history breaks everyone downstream.
- **Branch delete**: prefer `git branch -d` (refuses if unmerged) over `git branch -D` (force).

Never use `--no-verify` or otherwise skip hooks by default. Never use interactive flags (`-i` — unsupported here). Commit onto a shared branch only when asked; checkpoint commits onto `claude/local-dev` need no ask. Never modify `git config`.

---

*Distilled from [Conventional Commits](https://www.conventionalcommits.org/), [Pro Git](https://git-scm.com/book), [cbea.ms 50/72](https://cbea.ms/git-commit/), and anthropics/claude-code conventions. Complements the `git-push-guard` hook; defers to project CLAUDE.md.*
