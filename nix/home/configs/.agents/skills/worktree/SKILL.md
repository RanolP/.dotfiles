---
name: worktree
description: Everything about git worktrees in one place: what a linked worktree shares with its main checkout and what it keeps to itself, where worktrees live on this machine, where builds and caches go so syncthing does not sync them, how workers share dependencies, the parallel-worker workflow (plan -> parallel workers in git worktrees -> live progress reports -> small-commit merges onto `claude/local-dev`), and the audit-first cleanup (prune stale registrations, classify each worktree with a read-only audit script, remove only the safe ones, delete their branches, report the disk reclaimed). Use before running `git worktree add`, before building, installing or running a dev server inside a worktree (Xcode, Gradle, Metro, node), when the user wants several units built in parallel and wants to watch progress (unit, k/N, ETA) without asking for it, or asks to "split it and run workers", when worktrees pile up, a worktree add fails on a name already in use, `git worktree list` shows paths that no longer exist, or the user asks to clean up worktrees.
---

# Worktree

Sections run from what git guarantees (1) through where a worktree sits (2), what its builds write (3) and what syncthing carries (4), to how workers share inputs (5), run in parallel (6) and get torn down (7). Defers to `git-master` for branch and push mechanics.

## 1. What a worktree is

Checked against git-worktree(1) of the installed git 2.55.0 (`git help worktree`) and `git rev-parse --git-path` in a live linked worktree.

- A repository has one main worktree and zero or more linked worktrees. A linked worktree's `.git` is a file, not a directory, holding one line: `gitdir: <main>/.git/worktrees/<name>`.
- That private directory holds the per-worktree state: `HEAD`, `index`, and the pseudo refs plus `refs/bisect`, `refs/worktree`, `refs/rewritten`. Everything else resolves to the main `.git` (`$GIT_COMMON_DIR`): every ref under `refs/` (branches, tags, `refs/stash`), the object store, `config`, `hooks` and `info/exclude`. So a stash made in one worktree is visible and poppable in every other, a hook or config edit applies to all of them, and a commit in any worktree is in every worktree's `git log --all` at once.
- `git rev-parse --git-path <file>` prints where a given file really lives; use it rather than reading `.git` by hand.
- One branch is checked out in at most one worktree: `git worktree add <path> <branch>` refuses a branch another worktree holds. Use `--detach` (or `-d`) for a throwaway tree with no branch, which is also the form for a repo whose rules forbid new branches.
- Deleting a worktree directory without `git worktree remove` leaves its registration in `.git/worktrees/<name>`; `git worktree prune` (or `gc.worktreePruneExpire`) drops registrations whose directory is gone, and `git worktree list` marks them `prunable`.
- `git worktree lock [--reason <s>]` keeps a worktree's registration from being pruned, moved or removed, for a tree on media that is not always mounted or a long-running job; `git worktree list --porcelain` prints the reason.
- After moving a main or linked worktree by hand, `git worktree repair` reconnects them.

## 2. Where worktrees live

A worktree may live inside `~/syncthing` (the user's decision, 2026-11-27); what keeps it cheap there is section 3.

> **Draft: 미정** (undecided). Whether the layouts below get unified into one, and which, is the user's open decision. Layouts observed on 2026-11-27:
>
> - `~/syncthing/Projects/.worktrees/<repo>/<name>` -- 45 entries across five repos (30 of them for one app repo).
> - `~/syncthing/Projects/<repo>-wt-<name>` sibling directories -- 34 across three repos (28 of them for one repo).
> - `<repo>/.claude/worktrees/<name>` -- the layout this section prescribed before the decision opened (below), and the one `overnight` names.
> - `<scratchpad>/<name>` -- `refactor` (`<scratchpad>/refactor-base`) and `arena` (`<scratchpad>/arena-<slug>/candidate-<n>`).
> - `../<repo>-asis` -- `design-review`'s as-is checkout.

Until the Draft above is decided, the standing rule is this: start every branch job in `git worktree add <repo>/.claude/worktrees/<name> -b claude/<name> origin/<default>`, install dependencies there, and put that path in the worker brief; the main checkout stays on its default branch, where the user's untracked files would otherwise fail the commit hooks. The session scratchpad is under `/private/tmp`, which macOS empties on reboot, taking an uncommitted worktree with it -- so checkpoint-commit a worker's tree changes as soon as they land.

## 3. Build outputs and caches

Leave build outputs and caches where the tool puts them by default (the user's decision, 2026-11-27):

- Xcode: build with the default DerivedData, leaving `-derivedDataPath` off. Xcode then writes to `~/Library/Developer/Xcode/DerivedData/<project>-<hash>`, outside syncthing, and the hash comes from the workspace path, so two worktrees never share a folder. Find the built `.app` from `xcodebuild -showBuildSettings`'s `BUILT_PRODUCTS_DIR` for the same scheme, configuration and destination.
- Everything else: the tool's own default output folder (`build`, `dist`, `target`, `node_modules`, `.gradle`, `.next`, `.turbo`, `ios/Pods`, `android/.cxx`, `__pycache__`, `.venv`), each of which `.stignore-shared` already lists.
- When a task needs an output-path option (`-derivedDataPath`, `--outDir`, `--cache-dir` and the like), first check the path against the rules in `~/syncthing/Projects/.stignore-shared` and use only a name a rule matches, such as `ios/build/<x>`.

WHY: a name no rule matches turns every build file into a sync target, and syncthing keeps the CPU busy rescanning them -- a custom `ios/build-dd` once put 60,000 files per worktree into syncthing and lagged the Mac (`~/.dotfiles/docs/src/agent-incidents.md`, "2026-11-27 -- an Xcode build directory outside the sync ignore list").

## 4. Worktrees and syncthing

- `~/syncthing/Projects/.stignore-shared` holds the ignore rules; each device's `.stignore` only `#include`s it, because syncthing does not sync `.stignore` itself.
- It ignores `**/.git`, which matches a linked worktree's `.git` file as well as the main `.git` directory. A worktree copy that reaches another device is a plain directory tree with no git at all: commit and push from the device that holds the repo.
- Each rule is `**/<name>`, matching that name at any depth, so a directory is ignored only when its name equals a listed one: `build` and everything under `ios/build/` are caught, `android/build-dd` is not (only `ios/build-*` carries a wildcard rule).

## 5. Sharing dependencies across worktrees

- Base every worktree on the current `claude/local-dev` tip, so a worker's commits apply to main without a rebase.
- Share heavy inputs (corpora, build output, installed dependencies) from main's checkout through a setup script when the project has one, rather than each worker re-fetching and rebuilding.
- Send every unit with no unmet dependency in one message; spawn dependents in waves as their inputs land.
- A worktree Claude Code creates (`isolation: "worktree"`, `EnterWorktree`) gets `node_modules`, `android` and `ios` as symlinks into the main checkout (`worktree.symlinkDirectories` in `nix/home/configs/claude/settings.json`), so native builds there write into the main checkout's directories.

WHY: long-diverged branches merged late needed a dedicated rebase worker, and ten workers each reinstalling and rebuilding on one machine ate the time that coding did not.

## 6. Parallel worktree workflow

Run a multi-unit implementation as plan -> parallel workers in git worktrees -> live progress reports -> small-commit merges onto `claude/local-dev`.

Main plans, spawns, relays and merges; workers build. The loop ends in a stack of small commits on `claude/local-dev`, each merged as it landed, with the gate run once on the merged result.

It extends three standing rules rather than restating them: `AGENTS.md` "Parallel execution, synchronous thought" (grouping, condition waits, streaming), `AGENTS.md` "Mutations the outside world can see need an explicit go" (its `claude/local-dev` line: where commits land, how the stack is published), and `CLAUDE.md` "Delegation is pre-approved; size the unit, then commit to one strategy" (background spawn, typed results, receipt check).

### 6.1 Plan: cut units by domain, small

- First check whether one deterministic tool does the whole job: a GritQL rewrite, a `sed` pass, an AST script or a generator run once replaces N workers making the same edit by hand. Keep the script (commit it when the work outlives the session) and cite its path in the commit body, so a reviewer reruns it instead of reading N hunks.
- Cut along the problem area (skill `modularize-by-domain`) so each unit owns distinct files and no two concurrent workers edit the same file. Work on one call graph (one feature, one migration) goes to one worker, which fans out internally after its blocking step; split across workers only what produces independent artifacts.
- Size each unit to about 10 minutes of work ending in a commit or a saved result file, so a pause anywhere loses at most one unit.
- Split any unit larger than that before spawning. When a unit grows mid-run, its worker splits it: it spawns sub-workers in their own worktrees and cherry-picks their commits into its own branch.
- For a new area with no runnable check yet, make the first unit the upstream test fixtures plus the wiring and a ratchet test, so every later unit lands against something that can fail.
- In a sweep of similar edits a tool makes (codemod, grit rewrite, a codex bulk edit), the worker runs its cheap check (a type-check or the targeted test on its files) after each unit and before the next, so a bad transform stops at unit 1 instead of surfacing at the final gate.
- Present the unit list with estimates once, headed by four lines, each filled or `n/a: <reason>`: blocking (what lands before fan-out), parallel (units with disjoint files), shared (every file, key or result two units write, and how they are separated), and shape. The shape is slices (each worker its own unit) or a race (N workers on one identical brief, for a hard bug or a design spike); a race names its selection rule here -- first pass, rank all by a named metric, or best-of -- so the pick is fixed before any result arrives. Then spawn (section 5).

WHY: one worker per large unit serializes the whole run and leaves hours with nothing runnable -- two formatter workers once ran 90+ minutes each as single units, and one wrote layers for 2 hours before a single test ran.

### 6.2 Brief: what every worker carries

- First line: `Goal: <goal>; smallest change that meets it: <change>`. The worker's report opens with the same line.
- The goal, the files it owns, and every binding user decision quoted verbatim.
- When several workers share one recipe (steps, Done-when command, fences), write it once to `<scratchpad>/recipe-<run>.md` and give each brief its path to read and leave unedited, so the briefs cannot drift apart.
- `Done when:` a command and its expected result. It is the whole bar: the worker reports once it holds, adding no gate, review round or sign-off of its own. With no Done-when given, the bar is the base's tests still passing plus the tests the unit adds.
- The result goes to the worker's own file, `<scratchpad>/<unit>.json`, and main merges on read; two workers writing their own field of one shared JSON still share that file. Its shape is `{unit, verdict: "PASS" | "ISSUES" | "BLOCKED", evidence: [{cmd, output}], issues: [string]}`: ISSUES lists every issue the worker can show, BLOCKED names what it waits on.
- "Commit and report each step the moment it lands"; the gate runs once, in main, on the merged result (6.4).
- Scope is exactly the goal: leave adjacent code as found. A worker once spent 13 minutes deleting a function other workers still called.
- Keep each file's existing line endings and encoding. A worker once rewrote a file as CRLF.
- Put a timeout on any search or command that can run long, and scope searches to the repo. An unbounded `find /` hung a worker for 1.5 hours unnoticed.
- Stay out of shared generated files (snapshots, ratchet baselines); main regenerates them at merge.
- Benchmarks, conformance matrices and full suites stay out of worker briefs. Seven workers benchmarking at once made every number meaningless and slowed each other's tests.
- The progress-log contract from 6.3.

### 6.3 Progress log: workers write, main relays

Each worker appends to `.claude/resume/progress/<worker>.log` in the main checkout (untracked; add it to `.git/info/exclude` when the project does not ignore it):

```
PLAN <HH:MM:SS> units=<N> | <unit>:<lines>L:<est>m | <unit>:<lines>L:<est>m | ...
<HH:MM:SS> START <unit> <k>/<N> elapsed=<m>m note=<short>
<HH:MM:SS> DONE <unit> <k>/<N> elapsed=<m>m note=<short>
<HH:MM:SS> FAIL <unit> <k>/<N> elapsed=<m>m note=<short>
```

The PLAN line comes first; a new PLAN line replaces it whenever scope changes. Sub-workers write the same lines to their own log.

Main arms one Monitor on the stream instead of polling:

```sh
tail -n0 -F .claude/resume/progress/*.log | grep --line-buffered -E "DONE|FAIL|PLAN"
```

Pair it with a long heartbeat (about 30 minutes) that reads live state -- `git -C <worktree> log -1`, file mtimes, the task list -- since a watcher whose stream died stays silent. At spawn, record each worker's stuck-after time (its estimate, which already runs high). A worker past it with no new commit, log line or file change is stuck: `TaskStop` it and respawn it at once with the original brief plus its partial diff. A worker waiting on a question is not stuck; answer it.

On each event, main replies to the user in one or two lines, in the user's language: the unit, k/N, and the ETA when it moves. Leave out what is a given (a parity that is always 100%); mention it only when it breaks.

- ETA = the longest running unit's remaining estimate, plus queued units run one after another.
- Worker estimates run 2-4x high; scale them by the pace observed so far.
- Watch the critical path and push that worker to split. A 180-minute serial unit (ETA 06:00) finished near 03:40 once its worker split it.

WHY: the user wants live visibility without asking "how is it going?", and one short line per event with k/N and an ETA gives it.

### 6.4 Merge: small commits, one gate at the end

- Read each result against its Done-when. A worker that passed by weakening or bypassing the check (skill `constraint-evasion`) is reset with a hardened Done-when; a check that is itself wrong gets fixed in its own commit before the work resumes.
- A worker commits each step as it lands and reports it; main fast-forwards or cherry-picks it onto `claude/local-dev` right away, with no check run per step.
- Before the gate, list the results that came back against the units sent. A missing or malformed result gets one respawn, then a `GAP <unit>` line in the report; the run reads PASS only with zero gaps.
- Once every unit has merged, main runs the gate once on the merged result: the project's checks -- for example a type-check plus the test package whose ratchet catches broken output (`npx tsc -b && npx vitest run packages/<core>`) -- then the full suite, the conformance matrix and the benchmarks. When the work is a performance change, bench each commit in order on the largest inputs and revert commits that show no macro gain.

WHY: every merge serialized through a slow gate made integration, not coding, the bottleneck.

### 6.5 Main stays on assessment

- Relay reports, ask design questions (one question per decision, with a recommendation on each option), and record each decision to memory as it is made.
- Leave plan mode alone while workers run: entering it once blocked the running workers.
- On the user's stop, `SendMessage` every live worker "stop writing and report your state", then `TaskStop` it, and list each worker's id and last commit in the reply.
- Tear down finished worktrees per section 7.

### 6.6 Unattended run: settle the stops before the user leaves

When the user says they are stepping away, collect before they go:

- A done predicate every iteration can run.
- Answers to the questions likely to stop a worker, written into the briefs.
- A decision log per skill `decision-log`, one row as each unit lands (phase = the unit).
- The stuck exit: after 3 failed hypotheses on one unit (`AGENTS.md` "A failure earns a hypothesis, never a retry"), the worker writes up why in the log and stops that unit while the others run on.

WHY: an unattended run idles on the first question nobody is there to answer, and a stuck unit without an exit burns the hours the user was away.

## 7. Cleanup

Removing a worktree can destroy work that exists nowhere else — an uncommitted edit or a commit never pushed. So this runs as audit first, removal second, and every removal is a judgment you can defend from the audit output.

Defers to `git-master` for branch/push mechanics and its destructive-op guardrails.

### 7.1 Refresh, then inventory

```sh
df -h /                            # the "before" number for the final report
git fetch --prune                  # merged/gone status is a lie until you fetch
git worktree list --porcelain      # path, HEAD, branch, and any bare/detached/locked/prunable markers
```

`git worktree list` runs the same from any worktree of the repo — you do not need to be in the main one.

### 7.2 Drop registrations whose directory is gone

```sh
git worktree prune -n              # dry run: read what it would drop
git worktree prune
```

This only deletes bookkeeping under `.git/worktrees` for directories that no longer exist. It never touches a live worktree.

### 7.3 Classify every remaining worktree

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

A worktree is **finished** only when its bucket is `safe` or `safe-after-scratch` and the checks in 7.4 confirm it. Anything else is **unfinished**: unmerged, uncommitted changes, an open PR, or a session that may still be using it.

### 7.4 Report before you remove

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

### Guardrails — fail closed

- **Never `git worktree remove --force`** without explicit user confirmation. The flag exists to override the dirty-tree refusal, which means it deletes uncommitted work.
- **Never `git branch -D`** to clear a leftover branch, except a `MERGED=squash` row from a fresh audit. If `-d` refuses on any other branch, the branch has unmerged commits — report that instead.
- **A locked worktree is locked on purpose** (removable media, a long-running run). Report it with its reason (`git worktree list --porcelain` prints the lock reason) and leave it. Only unlock (`git worktree unlock <path>`) when the user says so.
- **Never `rm -rf` a worktree directory.** That leaves the registration behind and loses `git worktree remove`'s dirty-tree check.
- **The main worktree is not removable.** Skip the first entry of `git worktree list`.
- When a worktree looks finished but you cannot reach the remote to confirm the merge, treat it as unfinished. Uncertainty means keep. The audit warns on stderr when `gh pr list` fails; squash-merged rows then show `MERGED=no`.

### Beyond worktrees

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
