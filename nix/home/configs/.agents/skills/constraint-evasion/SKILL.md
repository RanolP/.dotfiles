---
description: Review a TypeScript, Kotlin, Swift, or Rust diff for constraint-evading compromises -- suppressed warnings and escape hatches, values stuffed into existing holes, types weakened away from a recorded plan, sum types extended flat, and call sites that should have changed and did not.
when_to_use: The typed-language pass of a code review -- loaded by the `code-reviewer` agent when a diff includes TS/Kotlin/Swift/Rust, or invoked directly to check whether an implementation followed its plan. Covers only constraint evasion; the surrounding review (correctness, scope, reuse, trust boundaries, tests) belongs to `code-reviewer`.
---

Adapted from Justin Le, "LLMs Will Cheese Your Types" (https://blog.jle.im/entry/llms-and-haskell-1-constraint-evading-behavior.html).

An agent under pressure to make a build pass does not attack the type wall -- it walks around it. Every pattern below compiles. That is the problem: the compiler cannot flag them, so this review does.

## Scope

Get the diff. `git diff HEAD` for uncommitted work; `git diff $(git merge-base HEAD main)...HEAD` for a branch; `gh pr diff <n>` for a PR.

Then find the plan, if one exists: `PLAN.md`, a design doc, the issue/PR body, an `ExitPlanMode` plan file, or a spec the user names. Every "the plan said X" finding needs the plan quoted. With no plan, skip the plan-divergence half of section 3 and keep the rest.

Detect the languages in the diff and run only their rows. `LANG` in the commands below means the changed files' globs: `'*.ts' '*.tsx'`, `'*.kt' '*.kts'`, `'*.swift'`, `'*.rs'`.

## 1. Suppressed warnings and escape hatches

The highest-signal finding in the review: the one case where the agent explicitly wrote down that it was disabling a check.

```bash
git diff HEAD | rg '^\+' | rg -n '@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable|biome-ignore|\bas any\b|as unknown as|\bany\b|\)!|!\.'          # TypeScript
git diff HEAD | rg '^\+' | rg -n '@Suppress|!!|\bas \w+\b|@UnsafeVariance|TODO\(\)|lateinit|\bAny\b'                                                  # Kotlin
git diff HEAD | rg '^\+' | rg -n 'try!|as!|fatalError|unsafeBitCast|@unchecked Sendable|nonisolated\(unsafe\)|swiftlint:disable|\bAny\b|: \w+!'       # Swift
git diff HEAD | rg '^\+' | rg -n '#!?\[allow|\bunsafe\b|\.unwrap\(\)|\.expect\(|panic!|todo!|unimplemented!|unreachable!|transmute'                   # Rust
```

Project-scope suppression is the same finding with a permanent blast radius -- weight it higher and always check these files:

```bash
git diff HEAD -- 'tsconfig*.json' '.eslintrc*' 'eslint.config.*' 'biome.json*'   # strict, strictNullChecks, noUncheckedIndexedAccess,
git diff HEAD -- 'build.gradle*' 'detekt.yml' '*baseline*.xml' 'gradle.properties'  # exactOptionalPropertyTypes, allWarningsAsErrors,
git diff HEAD -- '*.swiftlint.yml' 'Package.swift' '*.xcconfig'                     # SWIFT_STRICT_CONCURRENCY, new detekt baseline entries,
git diff HEAD -- 'Cargo.toml' 'clippy.toml' 'src/lib.rs' 'src/main.rs'              # [lints] levels, removed #![deny(warnings)]
```

For each hit: is this the rare legitimate case, or the low-effort path? Report it either way -- the point is that a human decides, not the agent. "This branch is unreachable in normal operation" is the canonical failure: if it is truly unreachable, the type should say so.

## 2. Stuffing, field abuse, sentinels

The agent needs to express something the domain type has no room for, and forces the value into an existing hole rather than widening the type.

Build the inventory first. For every union/enum/sealed hierarchy/struct touched by the diff -- and every type in a changed signature -- list the variants and fields whose payload is a string, a number, `unknown`/`Any`/`any`, a map/dictionary, a JSON value, a boxed error, a list, or an optional. Those are the abusable holes. Then check every new construction site.

Findings to raise:

- **Payload contradicting its own name.** `{ kind: 'unknownUser', message: "Invalid group: " + group }`, `Error::DatabaseCode(-1)`, `AppError.network(NSError(domain: "parse", ...))`, `Result.failure(IllegalStateException("user not found"))`. The tag says one thing, the payload says another.
- **Sentinels for absence.** `-1`, `0`, `""`, `"N/A"`, `"unknown"`, an empty array, `Date.distantPast`, `Instant.EPOCH`, `.zero`. The honest form is an optional (`T?`, `Option<T>`, `T | undefined`) or a variant for the missing case.
- **Structured data serialized into a scalar field.** `JSON.stringify` into a `message`, `joinToString(":")` into a name field, `format!("{k}={v}")` into an id, delimiters (`":"`, `"|"`, `"::"`) feeding a domain field. Same shape: appending to a list field that means something else (affiliations pushed onto `authors: string[]`).
- **Escape-hatch containers.** `Record<string, unknown>` / `Map<String, Any?>` / `[String: Any]` / `serde_json::Value` / `anyhow!("...")` used where a struct or typed variant belongs. In Rust specifically, a new `anyhow!` string where the crate has a typed error enum is this finding.
- **An existing field reused for a new purpose** rather than a new field added. This leaves almost no trace in the type diff -- it shows up as a call site passing a value whose meaning no longer matches the field name.
- **A catch-all variant** (`Other`, `Unknown`, `Custom(String)`, `case other(String)`) newly used for a case that deserves its own variant.

Name the structural fix in the finding: the variant, field, newtype (`value class` / branded type / `struct Foo(String)` / single-case struct) that removes the hole permanently.

## 3. Types weakened from the plan

```bash
git diff HEAD -U0 -- LANG | rg -n '^[-+].*(function |const \w+ *[:=].*=>|interface |type )'   # TypeScript
git diff HEAD -U0 -- LANG | rg -n '^[-+].*(fun |val |var |class |interface )'                 # Kotlin
git diff HEAD -U0 -- LANG | rg -n '^[-+].*(func |var |let |struct |enum |protocol )'          # Swift
git diff HEAD -U0 -- LANG | rg -n '^[-+].*(fn |struct |enum |trait |impl )'                   # Rust
```

Compare every changed signature against the plan and its own previous version. The weakening directions:

| Planned / previous | Weakened to | What was lost |
|---|---|---|
| literal union / enum / sealed interface | `string`, `String` | exhaustiveness; dodges adding one variant |
| branded type, `value class`, newtype, single-case struct | the raw underlying type | the distinction the wrapper existed for |
| non-empty type, `NonZeroUsize`, `NonEmptyList` | plain array/`Vec`/`List` + a length check | the invariant, moved from compile time to a runtime branch |
| unsigned / `UInt` / `u32` | `Int`, `i64`, `number` | non-negativity; usually adopted to match a callee's return |
| a struct / interface / data class | `Record<string, unknown>`, `Map<String, Any?>`, `[String: Any]`, `serde_json::Value` | the field set entirely |
| non-optional | `T?`, `Option<T>`, `T \| undefined`, `T!` | the guarantee that a value exists |
| a real constraint (`T extends X`, `where T: Binary`, `Sendable`) | `any`, `Any`, star projection `<*>`, `@unchecked Sendable` | the constraint; adopted because an impl was missing |
| borrowed `&T` / a lifetime (Rust) | `Clone`, `'static`, `Arc<Mutex<T>>`, `Rc<RefCell<T>>` | ownership discipline traded for a copy or runtime lock to dodge the borrow checker |
| `readonly` / `val` / `let` / immutable | mutable | the immutability the caller relied on |

A weakening is a finding even when it is right. Changing the plan takes as much thought as making it, so the decision must be surfaced, never taken silently mid-implementation. Quote the plan line and the resulting signature side by side.

Also flag the reverse tell: a function that gained a runtime guard is often the shadow of a type weakened upstream. `if (!xs.length) throw`, `requireNotNull`/`checkNotNull`, `guard let ... else { fatalError }`, `assert!`/`if n < 0 { return Err(...) }`, an `isSome`/`!= null` chain where a match would do. Trace each guard back to the type that should have made it unnecessary.

## 4. Flat sum extension and dead case arms

When the domain grows, the correct move is usually nesting; the low-effort move is flattening.

```bash
git diff HEAD -U0 -- LANG | rg -n '^\+.*(\| *[\x27"]|case |^\s*\+\s*[A-Z]\w*(\(|,|$))'   # new variants
git diff HEAD | rg '^\+' | rg -n 'default:|else ->|_ =>|@unknown default|assertNever'    # new catch-all arms
```

Findings:

- **New variants added at the same level as variants from a different conceptual universe** -- `Region = Canada | Mexico | Alaska | Arkansas` instead of `Canada | Mexico | UsState(State)`. The tell is a downstream function whose *type* did not narrow, so it now needs a dummy arm.
- **Any arm returning a no-op** (`return`, `break`, `Unit`, `undefined`, `None`, `()`) for a variant the function conceptually cannot receive. Each such arm marks a type that should have narrowed. Every match should strictly shrink the space it handles.
- **A catch-all arm added to a previously exhaustive match** -- `default:` in a TS `switch` (which also kills any `assertNever(x: never)` check), `else ->` in a Kotlin `when`, `default:`/`@unknown default` in a Swift `switch`, `_ => {}` in a Rust `match`. This silently absorbs every future variant: the same effect as disabling the exhaustiveness warning, in a narrower blast radius. Removing an `assertNever` call or a `#[deny(non_exhaustive_omitted_patterns)]` is the same finding.

## 5. The code that did not change

The sharpest section, and why this review starts from changed *functions* rather than changed lines: a diff shows what moved. The failure mode here is code that stayed still and should not have.

Work outward from the diff:

1. **Every sum type that gained a variant** -- find every match over it and confirm each was updated deliberately, not absorbed by a catch-all. `rg -n 'switch \(.*kind|when *\(' LANG`, `rg -n 'match .*\{' -A 20`.
2. **Every struct/record that gained a field** -- find every construction site and check the new field got a real value, not a placeholder. Watch specifically for the syntaxes that absorb a new field *silently*: `{ ...prev, }` spread in TS, `.copy(...)` in Kotlin, `..Default::default()` in Rust, a memberwise init with a defaulted parameter in Swift. Each of these compiles unchanged when a field is added, so the compiler never forces a visit.
3. **Every changed function** -- find its callers and confirm they adapted to the new *meaning*, not just the new type: `rg -n '\bchangedFunc\b'`.
4. **Every type the plan said to use somewhere** -- grep for it and confirm it actually appears there.

A change that compiles with zero call-site edits, where the plan implied widespread mechanical updates, is itself the finding. Mechanical downstream churn is the design working -- the compiler forcing every regression point to be visited. Its absence means the change was routed around.

## Reporting

Order findings by how much domain truth was lost, not by line number. For each:

- **file:line** and the offending expression
- which pattern it is (suppression / stuffing / weakening / flattening / unchanged-but-should-have)
- what the type used to guarantee and no longer does
- the structural fix -- the variant, field, newtype, or nesting that removes the hole rather than guarding it

Close with an explicit list of what was checked and found clean, especially section 5 -- an empty section 5 must read as "call sites verified", never as "did not look".

Do not open with a verdict, do not soften a finding because the code compiles, and do not accept "this branch is unreachable" as an argument. If it is unreachable, the type can say so; if the type cannot say so, it is reachable.
