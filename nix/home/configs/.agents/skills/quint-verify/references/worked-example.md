# Worked example: a lost update

Two threads each run `tmp = counter; counter = tmp + 1` with no lock. The fix wraps the increment in a lock. Every command and output below is from quint 0.33.1 (`mise x npm:@informalsystems/quint@0.33.1 -- quint ...`); the source paths are illustrative.

## The spec (`<scratchpad>/quint/lostUpdate.qnt`)

The racy read and write are separate actions because the interleaving between them is the question. `ATOMIC` is the bug toggle; `buggy` and `fixed` are the instance modules that bind it.

```quint
// Lost update: two threads run `tmp = counter; counter = tmp + 1` without a lock.
// src (hypothetical): counter.ts:12 read, counter.ts:13 write, counter.ts:20 locked fix
module lostUpdate {
  type Thread = int
  type Phase = Idle | HasRead | Done

  // Bug toggle: false = the racy read/write split, true = the fix (one atomic increment).
  const ATOMIC: bool
  const THREADS: Set[Thread]

  var pc: Thread -> Phase
  var tmp: Thread -> int
  var counter: int

  // --- functional layer ---
  pure def canRead(phase: Phase, atomic: bool): bool = not(atomic) and phase == Idle
  pure def canWrite(phase: Phase): bool = phase == HasRead
  pure def canIncrement(phase: Phase, atomic: bool): bool = atomic and phase == Idle

  // --- state machine ---
  action init = all {
    pc' = THREADS.mapBy(_ => Idle),
    tmp' = THREADS.mapBy(_ => 0),
    counter' = 0,
  }

  // src: counter.ts:12  const tmp = counter
  action read(t: Thread): bool = all {
    canRead(pc.get(t), ATOMIC),
    tmp' = tmp.set(t, counter),
    pc' = pc.set(t, HasRead),
    counter' = counter,
  }

  // src: counter.ts:13  counter = tmp + 1
  action write(t: Thread): bool = all {
    canWrite(pc.get(t)),
    counter' = tmp.get(t) + 1,
    pc' = pc.set(t, Done),
    tmp' = tmp,
  }

  // src: counter.ts:20  lock.run(() => counter += 1)
  action increment(t: Thread): bool = all {
    canIncrement(pc.get(t), ATOMIC),
    counter' = counter + 1,
    pc' = pc.set(t, Done),
    tmp' = tmp,
  }

  action step = {
    nondet t = THREADS.oneOf()
    any { read(t), write(t), increment(t) }
  }

  // --- properties ---
  val doneCount: int = THREADS.filter(t => pc.get(t) == Done).size()

  // Frozen target property: every finished increment is counted.
  val noLostUpdate: bool = counter == doneCount

  // Witnesses (positive target states).
  val someoneHasRead: bool = THREADS.exists(t => pc.get(t) == HasRead)
  val allDone: bool = THREADS.forall(t => pc.get(t) == Done)

  // Reachability sanity: must be VIOLATED, proving the end state is reachable.
  val sanityNeverAllDone: bool = not(allDone)
}

module buggy {
  import lostUpdate(ATOMIC = false, THREADS = Set(1, 2)).*
}

module fixed {
  import lostUpdate(ATOMIC = true, THREADS = Set(1, 2)).*
}
```

## The runs

```console
$ quint typecheck lostUpdate.qnt
[exit 0]

# 1. witnesses on the racy instance (no invariant, so the counts cover all 10000 traces)
$ quint run lostUpdate.qnt --main buggy --witnesses someoneHasRead allDone --max-steps 10 --seed 0x1 --max-samples 10000
An example execution:
...                                   (one example trace, omitted)
[ok] No violation found (222ms at 45045 traces/second).
Trace length statistics: max=5, min=5, average=5.00
You may increase --max-samples and --max-steps.
Use --verbosity to produce more (or less) output.
Witnesses:
someoneHasRead was witnessed in 10000 trace(s) out of 10000 explored (100.00%)
allDone was witnessed in 10000 trace(s) out of 10000 explored (100.00%)
Use --seed=0x3d9e1 --backend=rust to reproduce.
[exit 0]

# 2. target invariant with the fix on: must be clean
$ quint run lostUpdate.qnt --main fixed --invariants noLostUpdate --witnesses allDone --max-steps 10 --seed 0x1 --max-samples 10000
An example execution:
...                                   (one example trace, omitted)
[ok] No violation found (195ms at 51282 traces/second).
Trace length statistics: max=3, min=3, average=3.00
You may increase --max-samples and --max-steps.
Use --verbosity to produce more (or less) output.
Witnesses:
allDone was witnessed in 10000 trace(s) out of 10000 explored (100.00%)
Use --seed=0x284c5 --backend=rust to reproduce.
[exit 0]

# 3. reachability sanity: must be violated
$ quint run lostUpdate.qnt --main fixed --invariant sanityNeverAllDone --max-steps 10 --verbosity 1
[violation] Found an issue (8ms at 1250 traces/second).
Use --seed=0x7d7f6efbbcca6c64 --backend=rust to reproduce.
error: Invariant violated
[exit 1]

# 4. bug toggle: target invariant with the fix off must be violated
$ quint run lostUpdate.qnt --main buggy --invariants noLostUpdate --max-steps 10 --verbosity 1
[violation] Found an issue (9ms at 2222 traces/second).
Use --seed=0xe6c1b4275fc31772 --backend=rust to reproduce.
error: Invariant violated
[exit 1]

# 5. replay the counterexample with action names (trimmed to the changed vars)
$ quint run lostUpdate.qnt --main buggy --invariants noLostUpdate --max-steps 10 --seed 0xe6c1b4275fc31772 --mbt
[State 0] counter: 0, pc: Map(1 -> Idle,    2 -> Idle),    actionTaken: "init"
[State 1] counter: 0, pc: Map(1 -> HasRead, 2 -> Idle),    actionTaken: "read",  t: Some(1)
[State 2] counter: 0, pc: Map(1 -> HasRead, 2 -> HasRead), actionTaken: "read",  t: Some(2)
[State 3] counter: 1, pc: Map(1 -> HasRead, 2 -> Done),    actionTaken: "write", t: Some(2)
[State 4] counter: 1, pc: Map(1 -> Done,    2 -> Done),    actionTaken: "write", t: Some(1)
[violation] Found an issue (8ms at 125 traces/second).
error: Invariant violated
```

Runs 1-2 are the confirmation runs: they pass their own `--seed 0x1` together with `--max-samples 10000`, so re-running either command reproduces the same 10000 traces (run 2 re-run gave the same counts and printed seed). The `Use --seed=...` line they print (`0x3d9e1`, `0x284c5`) names only the last trace sampled, not the run, so the report records `0x1`. They run at the default verbosity because only verbosity >= 2 prints `Trace length statistics`: max 5 on `buggy` (2 reads + 2 writes + the initial state) and max 3 on `fixed`, both below `--max-steps + 1 = 11` because both instances terminate by design once every thread is done. Default verbosity also prints `An example execution:` on a clean run, so read the `[ok]` / `[violation]` line and the exit code.

Runs 3-4 are violation searches without `--seed`, each sampling up to the 10000 default and stopping at the first violation; there the printed seed does replay the violating trace (run 5). `--verbosity 1` drops their example trace.

`someoneHasRead` is 0% on `fixed` by design: `read` is disabled when `ATOMIC` is true, which is why run 2 lists only `allDone`.

## The report

- **spec**: `<scratchpad>/quint/lostUpdate.qnt`, module `lostUpdate`; instances `buggy` (`ATOMIC = false, THREADS = Set(1, 2)`) and `fixed` (`ATOMIC = true, THREADS = Set(1, 2)`).
- **bounds**: `--max-steps 10`, `--max-samples 10000`; clean runs 1-2 with the passed seed `--seed 0x1`; violations replay with the printed seeds `0x7d7f6efbbcca6c64` (run 3) and `0xe6c1b4275fc31772` (run 4).
- **witnesses**: `buggy`: `someoneHasRead` 10000 of 10000 (100%), `allDone` 10000 of 10000 (100%). `fixed`: `allDone` 10000 of 10000 (100%).
- **invariants**: `noLostUpdate` on `fixed`: no counterexample in 10000 sampled traces of <= 10 steps. On `buggy`: VIOLATED at state 4.
- **sanity / bug toggle**: `sanityNeverAllDone` violated as required. `noLostUpdate` violated with the fix off, clean with it on, so the property guards the bug.
- **counterexample** (`buggy`, seed `0xe6c1b4275fc31772`) -- real bug:
  1. `read(t=1)` -> `tmp[1] = 0` (`src/counter.ts:12`)
  2. `read(t=2)` -> `tmp[2] = 0` (`src/counter.ts:12`)
  3. `write(t=2)` -> `counter = 1`, thread 2 done (`src/counter.ts:13`)
  4. `write(t=1)` -> `counter = 1`, thread 1 done (`src/counter.ts:13`); two increments finished, one counted.
- **frozen-property changes**: none.
- **covers**: two threads, one increment each, the read and the write as separate atomic steps, the locked increment as one step. **does not cover**: more than two threads or repeated increments per thread, the lock's own implementation (assumed correct), memory-model reordering below a single shared read or write.

<!-- Original example and runs: Copyright 2026 RanolP, MIT. -->
