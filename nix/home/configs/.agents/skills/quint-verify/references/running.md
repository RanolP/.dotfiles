# Running and reading `quint run`

Every flag below was checked against `quint run --help` of quint 0.33.1.

## Flags this skill uses

| Flag | Default | Use |
|---|---|---|
| `--main <module>` | file stem | the instance module to run (the one binding every `const`) |
| `--init <action>` / `--step <action>` | `init` / `step` | rename only when the spec uses other names |
| `--invariant <name-or-expr>` | `true` | one invariant, to isolate a counterexample |
| `--invariants a b c` | none | several invariants checked together (AND); a violation names which one broke |
| `--witnesses a b c` | none | count how many traces reach each target state |
| `--max-steps N` | `20` | depth of every trace |
| `--max-samples N` | `10000`, **but `1` when `--seed` is given** | number of traces |
| `--seed S` | random | reproduce one trace |
| `--mbt` | off | adds `mbt::actionTaken` and `mbt::nondetPicks` to every state |
| `--verbosity 0..5` | `2` | `3` adds nondet picks and state changes when diagnosing |
| `--out-itf file_{seq}.itf.json` | none | write the trace as JSON (ITF) for scripting |
| `--backend rust\|typescript` | `rust` | keep `rust`; the reproduce line quint prints names it |

`quint test <file> --main <module>` runs `run` definitions; `--match` selects them by name or regex (by default, names ending in `Test`). `quint typecheck <file>` and `quint parse <file>` are the fast inner loop.

**`--seed` drops the sample count to 1.** A confirmation run with a seed and no `--max-samples` checks a single trace. In the worked example, `--seed 1` on the racy instance printed `[ok] No violation found` over 1 trace, while the same command without the seed found the lost update within 13. So: use `--seed` alone only to replay a counterexample; for a reproducible confirmation run pass both `--seed S --max-samples 10000`.

## Reading the output

Read the status line and the exit code, not the presence of a trace. At the default verbosity quint prints `An example execution:` with a full trace on **both** outcomes.

| Output | Exit | Meaning |
|---|---|---|
| `[ok] No violation found (...)` | 0 | no counterexample in the traces sampled |
| `[violation] Found an issue (...)` + `error: Invariant violated` | 1 | the printed trace ends in a state that breaks the invariant |
| `X was witnessed in K trace(s) out of N explored (P%)` | -- | reachability count for witness X |
| `Trace length statistics: max=.., min=.., average=..` | -- | counts states including the initial one, so a full-depth trace has length `--max-steps + 1`; a max below that means traces stopped at a state with no enabled action |
| `Use --seed=0x... --backend=rust to reproduce.` | -- | the seed to put in the report and to replay with |

A violating run stops at the first violation, so its witness counts cover only the traces explored before it ("13 out of 13"). Take witness percentages from a run with no violation (the fixed instance, or a run without the target invariant).

`quint run` reports a stuck state as success: it stops early and prints `[ok]` with traces shorter than `--max-steps + 1`. Compare the trace-length line against the bound whenever the system should keep running; for a system that terminates by design (all threads done), a short trace is the expected end state.

## Choosing steps and samples

- **First run / debugging** -- a small sample (`--max-samples 50`) is enough to see the spec execute and eyeball a trace.
- **Confirming an invariant** -- keep `--max-samples` at 10000 or higher. "No counterexample" is only as strong as the traces behind it.
- **`--max-steps`** -- estimate the branching factor (actions x the `nondet` fan-out inside them) and set the bound several times above "fire each action once", enough for a walk to reach the full cycle the properties are about. 2 threads x 3 actions needs about 4-6 steps to finish; a protocol with retries and 3 nodes needs 30-100.
- **A 0% witness** -- raise the bound before concluding the state is unreachable: `--max-steps 100`, then `200`, then `500`. Still 0% at 500: run `--verbosity 3` and look for actions that never fire (a guard that never holds) or a witness phrased too strongly.

## Replaying a counterexample

```bash
quint run <file>.qnt --main <instance> --invariants <inv> --max-steps <M> --seed <seed from the run> --mbt
```

With `--mbt` each state names the action that produced it and its nondet picks (`mbt::actionTaken: "read"`, `mbt::nondetPicks: { t: Some(2) }`). Walk the states in order, map each action through its `// src: path:line` comment, and write the step list for the report: `1. read(t=2) -> pc[2]=HasRead  (counter.ts:12)`.

Root cause by where it breaks:

| Where | Cause | Fix |
|---|---|---|
| state 0 | `init` builds an invalid state | fix `init` |
| after action X | X's guard or update is wrong -- in the model, or in the code it mirrors | decide real bug vs model artifact against the source |
| the invariant reads as too strict | the property is wrong | report it as a frozen-property change with the reason |

## Escalation: `quint verify` (only when the user asks)

`quint verify` explores every state up to `--max-steps` (default `10` there) instead of sampling. It needs a JDK 21+ and fetches Apalache on first use, and a run takes minutes to hours. Its flags differ from `run`: `--invariant` takes a comma-separated list, `--temporal a,b` checks temporal properties, `--backend apalache|tlc` (default `apalache`).

`--temporal` on Apalache prints "WARNING: Apalache has experimental support for temporal properties" and waits on `Do you want to proceed with Apalache anyway? (y/N)` (`quint/src/cliCommands.ts` at 0.33.1). The answer is read from stdin with `readline`; only `y` proceeds, anything else aborts with "re-run with --backend tlc", and an agent's non-interactive shell has no one to answer. Pass `--backend tlc` for any temporal check so the prompt never appears. Scope every `verify` result to its bound: "no counterexample up to N steps".

<!--
Adapted (modified) from github.com/quint-co/quint at fa42a10, skills/quint-lang/guidelines/simulations.md
and skills/quint-lang/guidelines/cli.md -- Apache-2.0, Copyright Informal Systems and the Quint contributors.
The --seed sample-count note, the output table, and the verify prompt note are original, checked against
quint 0.33.1. Changes: Copyright 2026 RanolP, MIT.
-->
