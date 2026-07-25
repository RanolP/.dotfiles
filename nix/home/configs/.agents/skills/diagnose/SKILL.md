---
description: Disciplined diagnosis loop for hard bugs and performance regressions.
when_to_use: When the user says "diagnose"/"debug this", reports a bug, says something is broken/throwing/failing, or describes a performance regression. Invoke before guessing at a fix.
---

A discipline for hard bugs. Skip a phase only with explicit justification.

## Phase 1: Build a feedback loop
This is the skill -- a fast, deterministic, agent-runnable pass/fail signal for the bug. Everything else just consumes it. Spend disproportionate effort here; be aggressive, refuse to give up.

Construct one, in roughly this order:
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

## Phase 3: Hypothesise
Generate 3-5 ranked, falsifiable hypotheses before testing any. Each states its prediction: "If X is the cause, then changing Y makes the bug disappear." Show the ranked list to the user -- they often re-rank instantly. Proceed with your ranking if the user is AFK.

## Phase 4: Instrument
Each probe maps to one Phase 3 prediction. Change one variable at a time. Prefer debugger/REPL inspection > targeted boundary logs > never "log everything and grep". Tag every debug log with a unique prefix like `[DEBUG-a4f2]` so cleanup is one grep. For perf regressions, logs are usually wrong: establish a baseline measurement (timing harness, profiler, query plan), then bisect. Measure first, fix second.

## Phase 5: Fix + regression test
Write the regression test before the fix -- but only if a correct seam exists (one that exercises the real bug pattern at the call site). A too-shallow seam gives false confidence; if no correct seam exists, that itself is the finding -- note it. With a correct seam: turn the repro into a failing test, watch it fail, apply the fix, watch it pass, re-run the Phase 1 loop against the original scenario.

## Phase 6: Cleanup + post-mortem
- Original repro no longer reproduces (re-run the loop)
- Regression test passes (or absence of seam is documented)
- All `[DEBUG-...]` instrumentation removed (grep the prefix)
- Throwaway prototypes deleted
- The correct hypothesis is stated in the commit/PR message
- State what would have prevented the bug -- after the fix is in, not before

## Constraints
- NEVER proceed past Phase 1 without a loop you believe in; if you genuinely cannot build one, stop and say so, list what you tried, and ask for environment access, a captured artifact, or permission to add temporary instrumentation
- NEVER skip Phase 2 -- fixing an unreproduced bug is guessing
- NEVER test more than one variable per probe
