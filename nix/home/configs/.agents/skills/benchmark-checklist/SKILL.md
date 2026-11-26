---
name: benchmark-checklist
description: Vet a performance number before reporting or acting on it -- the claim written first, then seven questions each answered from a run (limiter, tuning parity, physical limits, errors and wrong output, alternating repeat runs, end-to-end share, whether the work happened), and a four-way verdict. Also orders fix hypotheses by the performance mantras.
when_to_use: When you run a benchmark, report a speedup or regression you measured, compare libraries, configs, models or backends by speed, freeze a hillclimb harness, or put a perf number in a PR body. Invoke before the first measured run.
---

# Benchmark checklist

Use this whenever you produce a performance number: a PR's before and after, a regression claim, a hillclimb harness, a library, config, model or backend choice, or an eval throughput. Answer every question from a run you made, never from reading the code. It extends the (baseline) rule in `AGENTS.md`: start from the production shape and name the bounding resource from counters taken during the run (`docs/src/agent-incidents.md`, 2026-10-06 and 2026-11-23, both misread speed numbers).

A quick ballpark the user asked for takes one run: still answer questions 4 and 7, say it is one run, and run the rest only when that run looks wrong. A choice between options always gets the full checklist, because the user adopts the winner.

## Before the first run

- Write the claim you expect to ship, in the words you would ship ("export is 30% faster at p50 on the 60k-row dataset"). Every question below tests that sentence.
- Read the measurement script and write down what it times, what it counts, and what it ignores.
- Record `uptime` and the core count (`sysctl -n hw.ncpu` on macOS, `nproc` on Linux). With load above the core count, find what is running; when you cannot stop it, interleave the sides (question 5) so both see the same noise, and say so in the report.

## The seven questions

1. **Why not double?** Name the limiter. Profile in a separate run you leave out of the reported numbers, since profilers and tracers slow the work: CPU per process (`top -o cpu`, `/usr/bin/time -l`), a runtime profiler (`sample <pid>` or `xctrace record --template 'Time Profiler'` on macOS, `node --cpu-prof`, `uv run --with py-spy py-spy record`, `perf` on Linux), I/O wait, and syscall counts (`strace -c` on Linux), then map the hot spot to source. Watch the load generator too: when it saturates first, you measured the load generator. When a change leaves the number where it was, the limiter explains why, so find it before calling the change useless.
2. **Was it tuned?** Run every side the way production runs it: release builds, production flags and env, batching and transaction settings, connection pools, caches as warm or cold as production sees them, the same versions and the same data. A side on defaults means you compared configurations, not implementations. A limiter that is a setting (a commit per row, a debug build, a missing index) marks that side untuned: tune it and measure again before picking a winner, and pick no winner from a run with an untuned side. When the user is choosing what to adopt, narrowing the claim to "the code as it ships today" leaves this unfixed, because they adopt the option, not today's settings.
3. **Did it break limits?** Do the arithmetic: bytes per second against disk and network bandwidth, operations per second times cost per operation against your cores, time saved against the time the changed piece took (Amdahl: removing a piece that is 10% of the run makes the run at most about 11% faster). A result past a limit measured something other than the work -- a cache, a no-op, or a bug.
4. **Did it error?** Count failures and non-success responses, and check that outputs are correct, not merely present: rejections are often fast, and timeouts and retries are slow. When the script prints no error count, add one.
5. **Does it reproduce?** Run each side at least 5 times, alternating A, B, A, B, so warmup, lazy initialization, caches and drift favor neither. Report the median and the range. A gap smaller than the run-to-run spread is no measurable difference; when the call is close, use a rank-sum test (`uv run --with scipy python`, `scipy.stats.mannwhitneyu`) or the harness's own statistics.
6. **Does it matter?** Next to any micro result, measure the end-to-end path a user waits on, with realistic data sizes and concurrency, and report the micro result as a share of the whole. A helper that takes 1% of a request makes the request at most 1% faster, however fast the helper gets.
7. **Did it even happen?** Confirm the work ran inside the timed region: the request reached the server, the rows were written, the bytes were read, and the code used the result. Lazy code (a generator nobody iterates, a promise nobody awaits, a result the JIT can discard) and timeouts produce numbers for work that never ran.

## Ordering fix hypotheses: the performance mantras

When the number is what you want to improve (a perf fix, a hillclimb attempt, the performance path of skill `diagnose`), take hypotheses in Brendan Gregg's order, cheapest structural win first:

1. Don't do it -- remove work whose result nothing uses rather than making it cheaper.
2. Do it, but don't do it again.
3. Do it less.
4. Do it later.
5. Do it when they're not looking.
6. Do it concurrently.
7. Do it cheaper.

For a one-off fix, stop at the earliest mantra that meets the target. A hillclimb borrows only the order, since its own stop predicate governs when it ends.

## Report

- Lead with the verdict: faster, slower, no measurable difference, or inconclusive.
- Give the number with its unit, the run count, the range and the limiter -- "p50 41 ms -> 33 ms, median of 7 runs per side, range 32 to 35 ms after, bound by JSON parsing on one core".
- Call the verdict inconclusive when you claim a difference but cannot name the limiter, when a side ran untuned, or when questions 4 and 7 went unchecked, and name which gap it was.
- Keep a PR body to one primary number; put the runs, range and limiter evidence in a linked artifact or notes file the reader can reach.

## With skill `hillclimb`

Vet the hillclimb harness with this checklist before freezing it. The frozen harness then prints its error and work counts, so each keep-or-revert answers questions 4 and 7 for free, and its "median of N" follows question 5 (N >= 5, sides alternating).

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/benchmark-checklist`, the Explain the Number principle in `skills/poteto-mode/SKILL.md`, and the performance mantras of `skills/poteto-mode/playbooks/perf-issue.md`.*
