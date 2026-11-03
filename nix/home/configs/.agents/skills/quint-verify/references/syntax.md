# Quint syntax that breaks first

Read this when `quint typecheck` fails or a run throws. Most errors come from these rules.

## Language rules

- **Strings are opaque**: equality only, usable as set members and map keys. Build composite IDs from records or tuples: `type MsgId = { sender: int, round: int }`.
- **`match` is one level deep.** Match the outer variant, bind its payload, then `match` the payload in the arm.
- **Destructuring works in `val` bindings and lambda parameters**: `val (x, y) = pair`, `s.map(((a, b)) => a + b)` (double parens; `(a, b) =>` is a two-argument lambda). In a `def` parameter list or a `match` arm, take one name and use `._1` / `._2` / `.field`.
- **`val` is immutable and a body is one expression.** Use `if (c) a else b` (with the `else`), `match`, and nested `val` blocks; conditional values replace early returns.
- **Iteration is functional**: `S.map`, `S.filter`, `S.fold(init, (acc, x) => ...)`, `S.forall`, `S.exists`, `L.foldl`, `L.select`.
- **Empty collections need a type**: `val s: Set[int] = Set()`.
- **Map type is `K -> V`** (`var balances: str -> int`); a map value is `Map("a" -> 1)` or `KEYS.mapBy(k => v)`.
- **Boolean negation is `not(p)`**; also `and`, `or`, `implies`, `iff`, and block forms `and { ... }` / `or { ... }` (same as `all { ... }` / `any { ... }` in actions).
- **Parameterless pure def has no parentheses**: `pure def name = ...`.
- **A variant constructor takes one argument**: `Timeout((h, r))` or `Vote({ voter: 1, value: 2 })`.
- **`oneOf` is a method, only inside `nondet`**: `nondet t = THREADS.oneOf()`.
- **Reserved words are not identifiers or field names**: `val`, `def`, `to` (the `i.to(j)` range), `from`, `import`, and so on. Use `dst`, `src`, `sender`.
- **An action and a pure def cannot share a name**: `canRead` / `read`, `applyTransfer` / `transfer`.
- **Every action assigns every var**: `x' = x` for the unchanged ones. A missing one passes `typecheck` and `run` silently under 0.33.1 -- the var just drops out of every later state in the trace -- so scan each action's assignment list against the `var` list.
- **State is read only in `val`, `def`, and actions**; a `pure def` takes everything as arguments.
- **`assume` documents a premise and is not checked** by `typecheck`, `run`, or `verify`. To check a condition on constants, write `run quorumTest = all { 2 * F < N }` and run `quint test`.
- **`Option` is not built in**: it comes from `basicSpells.qnt` (`import basicSpells.* from "./basicSpells"`). A single scratchpad file declares its own `type Opt = Some(int) | None` instead.

## Undefined behaviour -- guard before calling

| Operation | Undefined when | Guard |
|---|---|---|
| `m.get(k)` | `k` not in `m` | pre-populate with `mapBy` in `init`, or check `m.keys().contains(k)` |
| `m.set(k, v)` | `k` not in `m` | use `m.put(k, v)` to add a key |
| `s.getOnlyElement()` | `s.size() != 1` | guard the size, or `nondet x = s.oneOf()` |
| `l.head()` / `l.tail()` | `l` empty | `l.length() > 0` |
| `l.nth(i)` | `i < 0` or `i >= l.length()` | bound `i` |
| `i.to(j)` | `i > j` | ensure `i <= j` |

## Instance modules

A `const` has no value until an import binds it. Put the model in one module and bind it per configuration:

```quint
module lostUpdate {
  const ATOMIC: bool
  const THREADS: Set[int]
  // vars, actions, properties
}

module buggy { import lostUpdate(ATOMIC = false, THREADS = Set(1, 2)).* }
module fixed { import lostUpdate(ATOMIC = true,  THREADS = Set(1, 2)).* }
```

Run an instance with `--main buggy`; the definitions are reachable by their plain names (`--invariants noLostUpdate`).

<!--
Adapted (modified, condensed) from github.com/quint-co/quint at fa42a10, skills/quint-lang/SKILL.md,
skills/quint-lang/guidelines/constraints.md and skills/quint-lang/guidelines/patterns.md (sections 4-6)
-- Apache-2.0, Copyright Informal Systems and the Quint contributors.
The instance-module example was checked under quint 0.33.1. Changes: Copyright 2026 RanolP, MIT.
-->
