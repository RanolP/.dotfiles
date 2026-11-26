---
name: parallel-worktree-workflow
description: Run a multi-unit implementation as plan -> parallel workers in git worktrees -> live progress reports -> small-commit merges onto `claude/local-dev`. Use when the user wants several units built in parallel and wants to watch progress (unit, k/N, ETA) without asking for it, or asks to "split it and run workers".
---

# Parallel worktree workflow

Main plans, spawns, relays and merges; workers build. The loop ends in a stack of small commits on `claude/local-dev`, each merged as it landed, with the gate run once on the merged result.

It extends three standing rules rather than restating them: `AGENTS.md` "Parallel execution, synchronous thought" (grouping, condition waits, streaming), `AGENTS.md` "Mutations the outside world can see need an explicit go" (its `claude/local-dev` line: where commits land, how the stack is published), and `CLAUDE.md` "Delegation is pre-approved; size the unit, then commit to one strategy" (background spawn, typed results, receipt check).

## 1. Plan: cut units by domain, small

- First check whether one deterministic tool does the whole job: a GritQL rewrite, a `sed` pass, an AST script or a generator run once replaces N workers making the same edit by hand. Keep the script (commit it when the work outlives the session) and cite its path in the commit body, so a reviewer reruns it instead of reading N hunks.
- Cut along the problem area (skill `modularize-by-domain`) so each unit owns distinct files and no two concurrent workers edit the same file. Work on one call graph (one feature, one migration) goes to one worker, which fans out internally after its blocking step; split across workers only what produces independent artifacts.
- Size each unit to about 10 minutes of work ending in a commit or a saved result file, so a pause anywhere loses at most one unit.
- Split any unit larger than that before spawning. When a unit grows mid-run, its worker splits it: it spawns sub-workers in their own worktrees and cherry-picks their commits into its own branch.
- For a new area with no runnable check yet, make the first unit the upstream test fixtures plus the wiring and a ratchet test, so every later unit lands against something that can fail.
- In a sweep of similar edits a tool makes (codemod, grit rewrite, a codex bulk edit), the worker runs its cheap check (a type-check or the targeted test on its files) after each unit and before the next, so a bad transform stops at unit 1 instead of surfacing at the final gate.
- Present the unit list with estimates once, headed by four lines, each filled or `n/a: <reason>`: blocking (what lands before fan-out), parallel (units with disjoint files), shared (every file, key or result two units write, and how they are separated), and shape. The shape is slices (each worker its own unit) or a race (N workers on one identical brief, for a hard bug or a design spike); a race names its selection rule here -- first pass, rank all by a named metric, or best-of -- so the pick is fixed before any result arrives. Then spawn.

WHY: one worker per large unit serializes the whole run and leaves hours with nothing runnable -- two formatter workers once ran 90+ minutes each as single units, and one wrote layers for 2 hours before a single test ran.

## 2. Spawn: one worktree per worker, from the current tip

- Base every worktree on the current `claude/local-dev` tip, so a worker's commits apply to main without a rebase.
- Share heavy inputs (corpora, build output, installed dependencies) from main's checkout through a setup script when the project has one, rather than each worker re-fetching and rebuilding.
- Send every unit with no unmet dependency in one message; spawn dependents in waves as their inputs land.

WHY: long-diverged branches merged late needed a dedicated rebase worker, and ten workers each reinstalling and rebuilding on one machine ate the time that coding did not.

## 3. Brief: what every worker carries

- First line: `Goal: <goal>; smallest change that meets it: <change>`. The worker's report opens with the same line.
- The goal, the files it owns, and every binding user decision quoted verbatim.
- When several workers share one recipe (steps, Done-when command, fences), write it once to `<scratchpad>/recipe-<run>.md` and give each brief its path to read and leave unedited, so the briefs cannot drift apart.
- `Done when:` a command and its expected result. It is the whole bar: the worker reports once it holds, adding no gate, review round or sign-off of its own. With no Done-when given, the bar is the base's tests still passing plus the tests the unit adds.
- The result goes to the worker's own file, `<scratchpad>/<unit>.json`, and main merges on read; two workers writing their own field of one shared JSON still share that file. Its shape is `{unit, verdict: "PASS" | "ISSUES" | "BLOCKED", evidence: [{cmd, output}], issues: [string]}`: ISSUES lists every issue the worker can show, BLOCKED names what it waits on.
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

Pair it with a long heartbeat (about 30 minutes) that reads live state -- `git -C <worktree> log -1`, file mtimes, the task list -- since a watcher whose stream died stays silent. At spawn, record each worker's stuck-after time (its estimate, which already runs high). A worker past it with no new commit, log line or file change is stuck: `TaskStop` it and respawn it at once with the original brief plus its partial diff. A worker waiting on a question is not stuck; answer it.

On each event, main replies to the user in one or two lines, in the user's language: the unit, k/N, and the ETA when it moves. Leave out what is a given (a parity that is always 100%); mention it only when it breaks.

- ETA = the longest running unit's remaining estimate, plus queued units run one after another.
- Worker estimates run 2-4x high; scale them by the pace observed so far.
- Watch the critical path and push that worker to split. A 180-minute serial unit (ETA 06:00) finished near 03:40 once its worker split it.

WHY: the user wants live visibility without asking "how is it going?", and one short line per event with k/N and an ETA gives it.

## 5. Merge: small commits, one gate at the end

- Read each result against its Done-when. A worker that passed by weakening or bypassing the check (skill `constraint-evasion`) is reset with a hardened Done-when; a check that is itself wrong gets fixed in its own commit before the work resumes.
- A worker commits each step as it lands and reports it; main fast-forwards or cherry-picks it onto `claude/local-dev` right away, with no check run per step.
- Before the gate, list the results that came back against the units sent. A missing or malformed result gets one respawn, then a `GAP <unit>` line in the report; the run reads PASS only with zero gaps.
- Once every unit has merged, main runs the gate once on the merged result: the project's checks -- for example a type-check plus the test package whose ratchet catches broken output (`npx tsc -b && npx vitest run packages/<core>`) -- then the full suite, the conformance matrix and the benchmarks. When the work is a performance change, bench each commit in order on the largest inputs and revert commits that show no macro gain.

WHY: every merge serialized through a slow gate made integration, not coding, the bottleneck.

## 6. Main stays on assessment

- Relay reports, ask design questions (one question per decision, with a recommendation on each option), and record each decision to memory as it is made.
- Leave plan mode alone while workers run: entering it once blocked the running workers.
- On the user's stop, `SendMessage` every live worker "stop writing and report your state", then `TaskStop` it, and list each worker's id and last commit in the reply.
- Tear down finished worktrees with skill `worktree-cleanup`.

## 7. Unattended run: settle the stops before the user leaves

When the user says they are stepping away, collect before they go:

- A done predicate every iteration can run.
- Answers to the questions likely to stop a worker, written into the briefs.
- A decision log at `<scratchpad>/decisions.md`, one row as each unit lands: unit, change, evidence, verdict.
- The stuck exit: after 3 failed hypotheses on one unit (`AGENTS.md` "A failure earns a hypothesis, never a retry"), the worker writes up why in the log and stops that unit while the others run on.

WHY: an unattended run idles on the first question nobody is there to answer, and a stuck unit without an exit burns the hours the user was away.
