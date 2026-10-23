---
name: parallel-worktree-workflow
description: Run a multi-unit implementation as plan -> parallel workers in git worktrees -> live progress reports -> small-commit merges onto `claude/local-dev`. Use when the user wants several units built in parallel and wants to watch progress (unit, k/N, ETA) without asking for it, or asks to "split it and run workers".
---

# Parallel worktree workflow

Main plans, spawns, relays and merges; workers build. The loop ends in a stack of small commits on `claude/local-dev`, each merged as it landed, with the gate run once on the merged result.

It extends three standing rules rather than restating them: `AGENTS.md` "Parallel execution, synchronous thought" (grouping, condition waits, streaming), `AGENTS.md` "Mutations the outside world can see need an explicit go" (its `claude/local-dev` line: where commits land, how the stack is published), and `CLAUDE.md` "Delegation is pre-approved; size the unit, then commit to one strategy" (background spawn, typed results, receipt check).

## 1. Plan: cut units by domain, small

- Cut along the problem area (skill `modularize-by-domain`) so each unit owns distinct files and no two concurrent workers edit the same file.
- Size each unit to about 10 minutes of work ending in a commit or a saved result file, so a pause anywhere loses at most one unit.
- Split any unit larger than that before spawning. When a unit grows mid-run, its worker splits it: it spawns sub-workers in their own worktrees and cherry-picks their commits into its own branch.
- For a new area with no runnable check yet, make the first unit the upstream test fixtures plus the wiring and a ratchet test, so every later unit lands against something that can fail.
- Present the unit list with estimates once, then spawn.

WHY: one worker per large unit serializes the whole run and leaves hours with nothing runnable -- two formatter workers once ran 90+ minutes each as single units, and one wrote layers for 2 hours before a single test ran.

## 2. Spawn: one worktree per worker, from the current tip

- Base every worktree on the current `claude/local-dev` tip, so a worker's commits apply to main without a rebase.
- Share heavy inputs (corpora, build output, installed dependencies) from main's checkout through a setup script when the project has one, rather than each worker re-fetching and rebuilding.
- Send every unit with no unmet dependency in one message; spawn dependents in waves as their inputs land.

WHY: long-diverged branches merged late needed a dedicated rebase worker, and ten workers each reinstalling and rebuilding on one machine ate the time that coding did not.

## 3. Brief: what every worker carries

- The goal, the files it owns, and every binding user decision quoted verbatim.
- "Commit and report each step the moment it lands"; the gate runs once, in main, on the merged result (section 5).
- Scope is exactly the goal: leave adjacent code as found. A worker once spent 13 minutes deleting a function other workers still called.
- Keep each file's existing line endings and encoding. A worker once rewrote a file as CRLF.
- Put a timeout on any search or command that can run long, and scope searches to the repo. An unbounded `find /` hung a worker for 1.5 hours unnoticed.
- Stay out of shared generated files (snapshots, ratchet baselines); main regenerates them at merge.
- Benchmarks, conformance matrices and full suites stay out of worker briefs. Seven workers benchmarking at once made every number meaningless and slowed each other's tests.
- The progress-log contract from section 4.

## 4. Progress log: workers write, main relays

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

On each event, main replies to the user in one or two lines, in the user's language: the unit, k/N, and the ETA when it moves. Leave out what is a given (a parity that is always 100%); mention it only when it breaks.

- ETA = the longest running unit's remaining estimate, plus queued units run one after another.
- Worker estimates run 2-4x high; scale them by the pace observed so far.
- Watch the critical path and push that worker to split. A 180-minute serial unit (ETA 06:00) finished near 03:40 once its worker split it.

WHY: the user wants live visibility without asking "how is it going?", and one short line per event with k/N and an ETA gives it.

## 5. Merge: small commits, one gate at the end

- A worker commits each step as it lands and reports it; main fast-forwards or cherry-picks it onto `claude/local-dev` right away, with no check run per step.
- Once every unit has merged, main runs the gate once on the merged result: the project's checks -- for example a type-check plus the test package whose ratchet catches broken output (`npx tsc -b && npx vitest run packages/<core>`) -- then the full suite, the conformance matrix and the benchmarks. When the work is a performance change, bench each commit in order on the largest inputs and revert commits that show no macro gain.

WHY: every merge serialized through a slow gate made integration, not coding, the bottleneck.

## 6. Main stays on assessment

- Relay reports, ask design questions (one question per decision, with a recommendation on each option), and record each decision to memory as it is made.
- Leave plan mode alone while workers run: entering it once blocked the running workers.
- Tear down finished worktrees with skill `worktree-cleanup`.
