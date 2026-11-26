---
name: typescript-types
description: TypeScript type discipline -- discriminated unions, branded and constructive types, `unknown` at boundaries, schemas before hand-written guards, no `as` casts, type guards that verify their claim, `never` exhaustiveness, `satisfies`. Use when writing, reviewing or refactoring TypeScript that models state or variants, parses external data (`JSON.parse`, fetch/RPC payloads, IPC, env, files), or contains `as`, `!`, `any`, an `isX` type guard, or a `switch` over a union.
---

# TypeScript types

| Rule | Summary |
|------|---------|
| Discriminated unions | Model variants with a `kind` literal discriminant so impossible states cannot be represented, in place of a bag of optional fields. |
| Branded types | Brand primitives with `& { readonly __brand: "X" }` so they cannot be mixed up. Validate once at the boundary. A brand comes from a verifying type guard (`input is AgentId`), never from `as`. |
| Constructive modeling | Build the shape so the illegal value cannot be constructed: `[T, ...T[]]` for non-empty, `[T, T][]` for even length, `start` plus `duration` for a range. |
| Simplest total type | Keep `T[]` while every operation on it stays total. Strengthen to `NonEmpty<T>` only where the loose type forces `!`, a cast, or a "should never happen" throw. |
| `unknown` over `any` | External data is `unknown` until narrowed. |
| Schemas before guards | Before hand-writing a property-by-property type guard, use the repository's runtime schema library and infer the type from the schema (`z.infer`). |
| Casts only after validation | Every `as` is a claim the compiler did not check. Cast only after the value was verified. |
| Narrowing hierarchy | Discriminant switch > `in` operator > `typeof`/`instanceof` > user-defined type guard > `as`. |
| Type guards | A guard verifies its whole claim. A lying guard is worse than `as`, because the bug hides behind a name that says it is safe. Name them `isX` or `hasX`. |
| Exhaustiveness | Put `const _exhaustive: never = x;` in default arms so the compiler errors when a new variant is added. |
| `satisfies` over `as` | Validates the value without widening literal types. |
| Boundary validation | Parse where data crosses in, into a named domain type. `Record<string, unknown>` (however spelled) stops at that parse; code inside trusts the type. State each invariant once, in that parse: consumers take the narrowed or branded type and carry no second null or shape check, so a repeated check downstream is a review finding. Exported functions take and return domain types; a framework request, ORM row or SDK response type stays inside the adapter that parsed it. |
| Schema-derived types | Reach for `Pick`/`Omit`/`Parameters`/`ReturnType`/`Awaited`/`typeof` before declaring a new interface. |
| Object args | Pass one object rather than positional arguments, so argument order is self-documenting. Keep positional on hot paths (per-frame render, tokenizers, parsers). |
| Real tests | Run what can run: use the framework's real test primitives with leak and disposal checks, verify UI in a running build, and mock only what cannot run locally. |
| Structured telemetry | Log through the project's structured logger with enough context to debug from one id. Shipped code carries no `console.log`; the `no-console` lint rule is the guard where the repo has one. |

Examples for each row: `references/patterns.md`.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/typescript-best-practices` and its `references/patterns.md`.*
