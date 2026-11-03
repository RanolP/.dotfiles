# From code to a Quint model

The model checks what the code is supposed to do for one concern; the code stays primary. Read only what the target properties depend on.

## Intake

1. **Catalog first.** Entry points, the state-carrying structures (structs, maps, enums, DB rows), the concurrency primitives (mutexes, channels, `await` points, goroutines, transactions), message types, and existing tests that reveal expected behaviour. For a codebase larger than a few files, delegate this catalog and keep it under 400 lines.
2. **Operations table** -- one row per state-changing operation:

   | Operation | `path:line` | Reads | Writes | Atomic region |
   |---|---|---|---|---|

   Include entry points, state mutations, message send/receive, timers and timeouts. Leave out side-effect-free getters, logging, metrics, serialization.
3. **State variables** -- each with its type, purpose, and scope (global or per actor).
4. **System-model assumptions**, read off the code: communication (messages or shared state; lossy, ordered, broadcast?), failures (crash-stop, crash-recovery, retries), time (timeouts become an action or a round counter), actors (fixed set; how many). Encode each as a `const` or a modelling choice and list it under "covers".

## Construct mapping

| Source | Quint |
|---|---|
| state enum | enum type `type Phase = Idle \| HasRead \| Done` |
| struct / record | `type T = { field1: T1, field2: T2 }` |
| `Vec<T>` / array | `List[T]` |
| `HashSet<T>` | `Set[T]` |
| `HashMap<K, V>` | `K -> V`, pre-populated over a small key set |
| thread / process / worker | element of `THREADS`; per-actor state `Thread -> LocalState` |
| atomic CAS / locked section / one SQL statement | one guarded action (an action fires whole) |
| message queue / channel | `Set[Message]` soup, delivery is an action firing |
| tagged message | sum type with named constructors: `\| VoteRequest({ term: int, candidate: int })` |

## The atomic grain

One action is one atomic region of the real code:

- the code between two `await`s,
- a locked section,
- a single shared read or write,
- a single SQL statement or transaction,
- one message handler.

Fuse sub-steps into one action when other actors cannot observe or interleave with the intermediate states. Keep them as separate actions when the interleaving between them is the question -- check-then-act (TOCTOU), read-modify-write, a partial-write window, a torn read. This choice decides whether the model can find the race at all, so state it in the result. For distributed code, split at message boundaries: a local update and another process observing it are separate events.

## Hide or model

| Detail in the code | Default | Model it when |
|---|---|---|
| locks, mutexes, atomics | hide: the locked region is one action | lock order or lock scope is the property |
| serialization, wire format | hide: pass structured values | a (de)serialization bug is the target |
| retry, backoff, timeout plumbing | hide: model the outcome as actions (success, failure, timeout) | retry semantics or duplicate delivery is the property |
| bounded channels | hide: unbounded `Set[Msg]` | back-pressure or blocking-on-full is the property |
| network transport | hide: message soup, no order | loss, duplication, or ordering is the property |
| error propagation | hide: a failed op is a disabled action; when the error is observable state, return it from a pure def | error handling is the property |
| concrete data structures | hide: `List` / `Set` / map | the structure's own invariant is the target |
| IDs | abstract: a small opaque set (`Set(1, 2)`) | ID arithmetic or ordering is the property |
| unbounded counters | abstract: small capped ints or a round counter | the bound is the property |
| environment faults (crash, pause, drop, expiry) | model as explicit actions so their interleavings are explored | always, when the property depends on them |

Start with 2 actors and 2-3 values; grow one bound at a time.

## Correspondence map

Every action gets a `// src: path:line` comment, and the result carries the map built from them:

```
read(t)       <-> src/counter.ts:12   const tmp = counter          (one shared read)
write(t)      <-> src/counter.ts:13   counter = tmp + 1            (one shared write)
increment(t)  <-> src/counter.ts:20   lock.run(() => counter += 1) (locked section fused)
abstracted: the lock itself, the HTTP handler around it, persistence
```

This is what turns a counterexample trace into a code-level explanation: each trace step names an action, each action names a line. When the code changes, update the model first and re-run before trusting an old result.

<!--
Adapted (modified, condensed) from github.com/quint-co/quint at fa42a10, skills/quint-modeling/guidelines/from-code.md
-- Apache-2.0, Copyright Informal Systems and the Quint contributors; and from github.com/opum-ai/proof-skills at
578749f, skills/tlaplus-model/SKILL.md (atomic-region list, environment faults as actions) and
skills/formal-verify/SKILL.md (correspondence map) -- MIT, Copyright (c) 2026 Opum AI.
Changes: Copyright 2026 RanolP, MIT.
-->
