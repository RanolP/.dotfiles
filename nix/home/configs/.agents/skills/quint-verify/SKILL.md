---
name: quint-verify
description: Check the state transitions of a design or a piece of code by writing one Quint spec in the session scratchpad and sampling it with `quint run` (simulator, no JVM) -- witnesses for reachability, invariants for safety, a sanity property and a bug toggle that prove the model can fail, and a fixed result report with bounds and a counterexample mapped to file:line.
when_to_use: The user wants to verify, model-check, or "prove" the state transitions, invariants, or race behaviour of a design or code -- "can this race", "is this thread-safe", "lost update", "check-then-act", "can this state machine reach X", "model this in Quint", "formally check this", a lock/lease/retry/idempotency/cache-invalidation/order-lifecycle question -- even when they never name Quint.
---

Quint is an executable specification language: state variables, guarded actions, and properties, all runnable at once. `quint run` samples random executions of the model and checks each state, so a counterexample is a concrete trace, and a clean run is evidence bounded by the samples behind it. This skill produces one spec file, runs it, and reports in a fixed shape.

`<skill-dir>` is the folder holding this SKILL.md.

- `references/from-code.md` -- turning source into a model: the construct mapping, the atomic grain, what to hide, the correspondence map.
- `references/syntax.md` -- the language rules that cause most typecheck and runtime errors, and the undefined-behaviour table.
- `references/running.md` -- every `quint run` flag this skill uses, how to read the output, step and sample staging, and the `quint verify` escalation.
- `references/worked-example.md` -- a complete lost-update spec with the commands and their real output under quint 0.33.1.

## Setup

Run quint through mise so the pinned version is used: `mise x npm:@informalsystems/quint@0.33.1 -- quint <cmd>`; after the user's rebuild it is also plain `quint` on PATH. The simulator is the Rust backend, fetched on first `run`; nothing needs a JVM.

Write the spec to `<scratchpad>/quint/<concern>.qnt`, one file per concern: a parameterized module holding the model, followed by small instance modules that bind every `const` (one per configuration you run, e.g. `buggy` and `fixed`). `quint run --main <instance>` selects which one runs.

## The loop

Typecheck after every addition (`quint typecheck <file>`), and `quint run` after every new action: a spec can typecheck and still fail to execute (an unbound `const` fails with `QNT500: Uninitialized const`).

1. **Scope one concern.** Pick one shared resource or protocol ("job claim vs. lease expiry", "cache fill vs. invalidation"). State in one line what is in, what is abstracted, and what is out. A 50-200 line model of one concern finds the bug; a whole-system model never converges.
2. **Freeze the target properties first.** Harvest them from the source before modelling -- docs, comments, API contracts, tests, past fix commits -- and cite each one (`README.md:40`, `orders.ts:88`). Write them down as the frozen set. Keep their wording fixed from here on; when one must change, report the change and why in the result.
3. **Shape the state.** Answer who the actors are and how they communicate. One actor: `var state: State` (a record). N actors of one kind: `var nodes: NodeId -> LocalState`. Messages: their own `var network: Set[Message]` (unordered soup unless ordering is the property). Shared memory: no medium var. Group fields that describe one entity into a record; keep independent concerns as separate vars. From code, choose the atomic grain now (`references/from-code.md`): one action per atomic region of the real code, and keep the steps split wherever the interleaving between them is the question.
4. **Write the functional layer as pure defs.** For each operation, a `pure def canX(...): bool` guard (when it may happen) and a `pure def applyX(...): State` update (what it does, assuming the guard holds).
5. **Wire guarded actions.** Each action is `all { canX(...), state' = applyX(...), <every other var>' = <same> }`. When the guard is false the action is disabled, which is the faithful model of "this cannot happen here", so each action carries exactly its guard and its assignments. `init` assigns every var and pre-populates every map with `mapBy`. Put a `// src: path:line` comment above each action; these build the correspondence map.
6. **Properties: witnesses first, then invariants.** A witness is a `val` naming a target state positively; `--witnesses` reports how many traces reached it. Write one per major action, phrased so only that action can make it true (a predicate already true at `init` witnesses nothing). Then the invariants: the frozen set from step 2, each referencing a var, at least one protocol-level (conservation, mutual exclusion, no lost update), beyond type or bounds checks.
7. **Compose `step` and simulate.** `action step = { nondet t = THREADS.oneOf()  any { a(t), b(t), ... } }`. Run witnesses and invariants in one pass (`references/running.md` for staging). A 0% witness means a dead action: fix it before trusting any invariant result.
8. **Prove the model can fail.** A spec that has never failed is no evidence. Run both:
   - **Reachability sanity** -- a property that must be violated, usually the negation of the interesting end state (`val sanityNeverDone = not(allDone)`). Its violation shows the states your invariants talk about are reachable.
   - **Bug toggle** -- a `const` (e.g. `ATOMIC: bool`) that switches the fix off. The instance with the fix off must violate the target invariant; the instance with it on must not. A target invariant that never fails with the fix off guards nothing; tighten the property or the model and say so.
9. **Read the counterexample.** Reproduce it with `--seed <seed> --mbt` to see `mbt::actionTaken` per state, map each step through the `// src:` comments to file:line, then tell the story in domain terms and decide: real bug, model artifact (wrong guard, steps merged or split wrongly), or a property that is too strong. The spec is the ground truth for the design; when the model is wrong, fix the model and report the fix alongside the verdict.
10. **Self-review.** Every action assigns every var; no business logic outside pure defs; every map pre-populated; IDs opaque; messages a `Set` unless ordering is the property; trace lengths compared against `--max-steps + 1` (the count includes the initial state; a trace that stops short reached a state with no enabled action, and `quint run` still prints `[ok]`).

## Wording the result

State a clean run as "no counterexample in N sampled traces of <= M steps (seed S)", in those words. Sampling is not exhaustive, so "verified", "proven", "safe", and "correct" overstate it; the user decides whether the sample size is enough. A violation is conclusive -- one trace disproves an invariant. Name the abstractions that could hide a bug in "does not cover".

## Escalating to `quint verify`

`quint verify` is exhaustive bounded model checking. Run it only when the user explicitly asks for it: it needs a JDK 21+ and downloads Apalache, and takes minutes to hours. `--temporal` on the default Apalache backend stops at a `(y/N)` prompt (`quint/src/cliCommands.ts`, "Apalache has experimental support for temporal properties"), so a non-interactive run passes `--backend tlc`. Details in `references/running.md`.

## Result shape

Report exactly these fields, in this order:

- **spec**: file path, module, and every `--main` instance run with its `const` bindings.
- **bounds**: `--max-steps`, `--max-samples`, `--seed` (the reproduce seed quint printed) for each run.
- **witnesses**: per witness, `reached in K of N traces (P%)`, taken from a run with no violation.
- **invariants**: per invariant and instance, `no counterexample in N traces of <= M steps` or `VIOLATED at state K`.
- **sanity / bug toggle**: the sanity property's outcome (must be violated) and the target invariant with the fix off (must be violated) and on (must be clean).
- **counterexample**: for each violation, the trace as numbered steps `action(args) -> changed vars`, each mapped to `path:line`, plus the verdict (real bug / model artifact / property too strong).
- **frozen-property changes**: each change with its reason, or `none`.
- **covers / does not cover**: what is modelled and which assumptions are encoded; what is abstracted away or left out, and which of those could hide a bug.

<!--
Adapted (modified, condensed into one scratchpad flow) from:
- github.com/quint-co/quint at fa42a10, skills/quint-modeling/SKILL.md and
  skills/quint-lang/guidelines/simulations.md -- Apache-2.0, Copyright Informal Systems and the Quint contributors.
- github.com/opum-ai/proof-skills at 578749f, skills/formal-verify/SKILL.md and skills/tlaplus-model/SKILL.md
  (prove-the-model-can-fail, frozen properties, honesty wording, correspondence map) -- MIT, Copyright (c) 2026 Opum AI.
Changes and original text: Copyright 2026 RanolP, MIT.
-->
