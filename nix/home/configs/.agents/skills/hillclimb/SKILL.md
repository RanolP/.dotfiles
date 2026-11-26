---
name: hillclimb
description: Run a sustained improvement loop on one measurable number -- a frozen measurement harness, one change per measurement, keep or revert in full, and a decision.tsv row per attempt. Use when the user wants a metric pushed toward a target over many attempts ("hillclimb", "keep tuning until", "push the score/latency/agreement up", "iterate on the judge/skill until it beats the baseline"), including tuning a skill, a judge prompt or a gate threshold in `eval/skilleval` of personal-work-memory. A one-off bug or perf fix is not this loop.
---

# Hillclimb

You own the metric and the integrity of the experiment; delegate the attempts and review them. Core discipline: one change, one measurement, keep or revert. Every kept change rests on a measured delta from the frozen harness, never on reading the diff.

## 1. Ground the workload, then fix the metric

Trace the target and name the workload dimensions that can move the result (data size, history, state, concurrency, case mix). Pick a case that reproduces the user's complaint; when none does, fix the repro before climbing. Then fix one metric, the direction that counts as better, and a checkable stop predicate that pairs a target with a floor on attempts, so a lucky early win cannot end the run ("at least 50% better than baseline and at least 10 iterations"). Use the user's numbers when given; otherwise propose them and get agreement. Write the predicate as a command into the log's header before the first iteration -- the same opening any unattended `/loop` or overnight run needs, metric or not.

## 2. Build the harness, prove it is sensitive, then freeze it

Run contrasting realistic workloads and confirm the target case shows the symptom while easier cases separate as expected; revise the workload or metric until they do. Make the harness print its error count and a count of the work it did, so a run that silently did nothing is visible. For a performance metric, vet the harness with skill `benchmark-checklist` before freezing it. Once frozen, one repeatable command emits the metric, sampled enough to clear the noise (median of N runs, N >= 5 with sides alternating, per `benchmark-checklist` question 5). Record the baseline metric and a green run of the regression gate (the tests that must keep passing) before any change.

## 3. Open the decision log

Keep `decision.tsv` outside the tracked tree (in personal-work-memory, `eval/runs/hillclimb-<slug>/`, which is gitignored), one row per attempt:

```
id	hypothesis	change	before	after	delta	tests	verdict	note
```

`verdict` is `kept` or `reverted`. Read the log before each attempt.

## 4. Ground each hypothesis in a mechanism

Each hypothesis names a specific mechanism from step 1 ("the judge prompt lists the 0.3 anchor after 0.0, so borderline cases drift low"), not "try tweaking the prompt". For a performance metric, order hypotheses by Brendan Gregg's performance mantras, listed in skill `benchmark-checklist` (don't do it, first; do it cheaper, last).

## 5. Loop, one hypothesis per iteration

- Hand the change to a background worker with a tight scope: an `Agent` worker, or `hetero-subagents:codex:gpt-6.1-sol` for code (a workspace-write implementer; codex stages, you commit). Review its diff rather than typing it. Fan independent hypotheses out in parallel, each in its own worktree (`isolation: "worktree"`), and measure them one at a time against the same baseline.
- A worker that measures gets the base and candidate SHAs and the method (sample count, what one sample is, the run order) in its brief, and echoes all of them in its result; discard a result that lacks them and re-send the brief.
- Measure before and after with the frozen harness, and run the regression gate.
- Keep a change only when the metric moves past the noise band and the gate stays green; otherwise revert it in full.
- Land each kept change as its own commit, staging only its files, where the repo's commit rules allow; otherwise save it as `<id>.patch` beside the log. Log the row either way.

## 6. Push past the first plateau

After several rejects in a row, pivot category, combine near-misses, re-read the source, or try something more radical before concluding the hill is climbed. Correctness and simplicity outrank the number: revert a win that breaks behavior, and keep a simplification that holds the number.

## 7. Stop on the predicate

Stop when the predicate is met, or when the remaining ideas are marginal next to their cost. Hold the predicate as agreed, and keep going while cheap untried hypotheses remain. A claim that the number has hit its ceiling cites a measured run of that ceiling (the work removed entirely, or the hardware limit's arithmetic), not a reading of the code. When stuck, surface it to the user with the log.

## In personal-work-memory `eval/skilleval`

Run from `~/syncthing/Projects/personal-work-memory`; the regression gate is `for f in eval/tests/test_*.py; do uv run --project eval python "$f" || break; done` (dependency-free self-check scripts, no LLM calls).

- **A judge (Jev vs haiku agreement)** -- harness: `uv run --project eval python eval/skilleval/jev_judge_ab.py eval/frev/<session>` over a fixed set of sealed sessions; metrics: `exact_agreement`, `adjacent_agreement`, `top_candidate_agreement`, `strict_top_agreement` from its `jev_ab.json`. It exits non-zero when any case failed, so an errored run never counts as a measurement. `JEV_MODEL` is `jev-latest`, a moving alias: re-measure the baseline at the start of each sitting and whenever deltas look implausible.
- **A gate threshold** (`JEV_MIN_CONFIDENCE`, `JEV_WORKERS` in `jev_gate.py`) -- replay the same sealed sessions per value; one value per attempt.
- **A skill's instruction text** -- FrEv is already the per-edit harness (`uv run --project eval frev edit <skill> --adopt`, `uv run --project eval frev propose`, `uv run --project eval frev ingest --bank`, `uv run --project eval frev seal`, `uv run --project eval frev apply`); hillclimb wraps it: one proposal per attempt, the case bank ingested with `--bank` frozen for the run, and the judged score as the metric.

Before keeping a judged-score win, confirm every case completed (none errored or skipped), re-run it as a second trial, and on a second judge model where the harness allows one; keep it only when the gap holds on both. Say in the log why the case bank stands for the real usage, so a win on an unrepresentative bank reads as one.

## Reply

The metric and target; baseline to final with the percent delta, each number with its run count, its range and the limiter; iterations run (kept vs reverted); each kept change on one line; the `decision.tsv` path; and the best idea to try next if pushed further.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/poteto-mode/playbooks/hillclimb.md`.*
