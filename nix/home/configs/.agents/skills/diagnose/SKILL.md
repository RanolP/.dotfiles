---
name: diagnose
description: Disciplined diagnosis loop for hard bugs and performance regressions.
when_to_use: When the user says "diagnose"/"debug this", reports a bug, says something is broken/throwing/failing, or describes a performance regression or says something is slow. Invoke before guessing at a fix.
---

A discipline for hard bugs. Skip a phase only with explicit justification.

## Phase 1: Build a feedback loop
Start from fresh `origin/<default branch>`: fetch, check it out (or a worktree of it), and run the report's steps there first. When the bug is already gone, report "does not reproduce at `<sha>`" with the command you ran and stop.

Reproduce on the surface the report names, yourself: `agent-device` for an app, `agent-browser` for a web page, the CLI for a CLI, per the `ui-automation` skill. Drive it as far as the tools reach, synthesize the trigger or tighten conditions when it will not fire, and ask the user to reproduce only with the specific thing the tools cannot reach (hardware, an account, a physical gesture) named in the request.

This is the skill -- a fast, deterministic, agent-runnable pass/fail signal for the bug. Everything else just consumes it. Spend disproportionate effort here; be aggressive, refuse to give up.

Construct one, in roughly this order. Whichever you pick, it lives in a FILE you re-run, never a command you retype -- see the `record-replay` skill:
1. Failing test at whatever seam reaches the bug (unit/integration/e2e)
2. curl/HTTP script against a running dev server
3. CLI invocation on a fixture, diffing stdout vs known-good snapshot
4. Headless browser script (Playwright/Puppeteer) asserting on DOM/console/network
5. Replay a captured trace (saved request/payload/event log) through the path in isolation
6. Throwaway harness exercising the bug path with one function call
7. Property/fuzz loop for "sometimes wrong output"
8. Bisection harness (`git bisect run`) when the bug appeared between two known states
9. Differential loop: same input through old vs new (or two configs), diff outputs
10. HITL bash script driving a human as last resort, so the loop stays structured

Then iterate on the loop itself: make it faster, sharper (assert the specific symptom), and more deterministic (pin time, seed RNG, isolate fs/network). For non-deterministic bugs the goal is a higher reproduction rate, not a clean repro -- loop the trigger 100x, parallelise, add stress, narrow timing windows until it is debuggable.

## Phase 2: Reproduce
Run the loop. Confirm it produces the failure the *user* described (not a nearby one), that it reproduces across runs (or at a high enough rate), and capture the exact symptom for later verification.

Before calling it reproduced:
1. Write the correct final state and the broken final state as two sentences. An expected dialog, loading state or setup step is a waypoint; the broken state is the one that differs from the correct one.
2. Reach the divergence and observe the broken state.
3. Reset enough state that the second attempt is independent, walk the same path, and observe the same broken state again.
4. Cross-check one real state value (DOM, accessibility tree, network response, database row) beside the screenshot.
5. Confirm the probe reads the live thing with one independent read: the deployed file rather than the source, a fresh build, an uncached response, the right host. A failing observation indicts the probe first and the system second.

End the phase on one outcome: `reproduced`, `could-not-reproduce` (with what you tried), or `blocked` (naming the missing capability).

## Phase 3: Hypothesise
Generate 3-5 ranked, falsifiable hypotheses before testing any. Each states its prediction: "If X is the cause, then changing Y makes the bug disappear." Show the ranked list to the user -- they often re-rank instantly. Proceed with your ranking if the user is AFK.

Seed the list from evidence: run the `why` skill on the failing symbol for the commits that last touched it, and tabulate the failing cases by input, case and side -- which ones fail, not only by how much. A skewed distribution points at the producer. Choose each probe so it rules out about half the remaining hypotheses.

When a probe refutes the whole list, write down the attributes every failing case shares and every passing case lacks, and draw the next hypotheses from that list.

When delegating the diagnosis, the worker's brief carries the symptom, the repro command and the files, and asks for the worker's own ranked hypotheses; compare them with yours on receipt, because a hunch in the brief narrows the worker's search to where it points.

## Phase 4: Instrument
Each probe maps to one Phase 3 prediction. Change one variable at a time. Prefer debugger/REPL inspection > targeted boundary logs > never "log everything and grep". Tag every debug log with a unique prefix like `[DEBUG-a4f2]` so cleanup is one grep. For perf regressions, logs are usually wrong: establish a baseline measurement (timing harness, profiler, query plan), then bisect. Measure first, fix second. Before explaining a speed number, name the resource bounding it from counters taken during the run -- `nvidia-smi` for GPU utilization and device placement, per-process CPU in `top`, I/O wait, a profiler -- then ask why it is not twice as fast. Rule out each thing the number could be measuring instead, with an observation per item: errors, skipped or cached work, a code path that never ran, an untuned comparison side (a baseline that does not batch, warm up or configure the way production does), run-to-run noise, and a component too small to matter.

Before a measurement run, write the decision it informs and the result that would flip that decision, then measure the run-to-run spread on the baseline. When the spread exceeds the effect, stop and report the number as noise. Keep the run count, the spread and the limiter beside every number you report.

A captured artifact (CPU profile, heap snapshot, trace) beats a log for perf, leaks and hangs: `references/runtime-forensics.md` covers capturing one from a live process and proving the mechanism in place, and `references/trace-forensics.md` covers querying an existing capture with `duckdb`.

## Phase 5: Fix + regression test
Write a fix once these hold: the repro is confirmed twice (Phase 2), runtime evidence -- not a source read -- confirms the mechanism, no open PR or person already claims the fix (`gh pr list --search <symptom>`), and both the baseline and the patched build run on the repro surface. When one fails, report the repro and what is missing.

First ask whether the state that produced the symptom is legitimate. Yes: handle it where it broke. No: fix the code that produced it -- a guard, retry, clamp, NaN mask or swallowed error at the symptom site hides the bug, and a cheap workaround that lowers result quality is a different deliverable to raise with the user.

Write the regression test before the fix -- but only if a correct seam exists (one that exercises the real bug pattern at the call site). A too-shallow seam gives false confidence; if no correct seam exists, that itself is the finding -- note it. With a correct seam: turn the repro into a failing test, watch it fail, apply the fix, watch it pass, re-run the Phase 1 loop against the original scenario.

Every shipped line traces to an observation. When a probe refutes a hypothesis, revert the edits that hypothesis motivated (`git restore -p`) before the next probe, so a "might help" change never rides along into the fix.

Fix the pattern, then the instance: write the root cause as a search (an `rg` regex or a `grit` query), list every hit, and fix or clear each one by name before Phase 6.

## Phase 6: Cleanup + post-mortem
- Original repro no longer reproduces: the same command or recording, re-run on the surface the bug was reported on. A unit test shows branch behavior, not bug absence, and a pass on another surface is reported as inconclusive
- Regression test passes (or absence of seam is documented)
- All `[DEBUG-...]` instrumentation removed (grep the prefix)
- Throwaway prototypes deleted
- The correct hypothesis is stated in the commit/PR message
- State what would have prevented the bug -- after the fix is in, not before
- When the deciding fact took more than one probe round, propose to the user the cheap always-on signal (a log line, an assert, a counter, a status field) that would have shown it at first look

## Constraints
- NEVER proceed past Phase 1 without a loop you believe in; if you genuinely cannot build one, stop and say so, list what you tried, and ask for environment access, a captured artifact, or permission to add temporary instrumentation
- NEVER skip Phase 2 -- fixing an unreproduced bug is guessing
- NEVER test more than one variable per probe
