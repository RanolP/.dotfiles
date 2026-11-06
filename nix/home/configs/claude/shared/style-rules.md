# Owner's standing style rules

These are the owner's own rules, and every code change is graded against them: the implementer writes to them and the reviewer reports each break. They are stated rules, not taste, so none needs a neighboring precedent to apply.

**Absolute — report every hit**

- **Type it safely.** An escape hatch is a defect: `as never`, `as any`, a non-null `!`, a suppressed type error. Type the value properly instead, and push the type work to the definition site rather than the caller. A binding declared as a function or a `let` where a `const` value works is the same finding — make it a `const`.
- **Rename the namespace import.** `import * as X` and `import type * as X` carry a PascalCase alias naming the module (`import type * as ProfileStackRoute from 'profile-stack.route'`).
- **No container-presenter split.** A wrapper that only reads data and feeds it as props to a dumb twin (`XxxSlot` + `Xxx`) is a finding: the component calls its own hooks, and props that a parent only fills with literals go away in the merge. A parent passes only a value several children must share; a layout primitive that takes slots (`PinnedMessage` + `PinnedMessage.Content`) is not a presenter.
- **Queries are built from constants and bind params.** A table or identifier name built by concatenation or interpolation is a finding: map a validated key through an allowlist of constant literal names and reject an unknown key. Every value goes through a bind parameter (`@param`), even one that looks constant.

**Strong rules — report every hit**

- **Declaration order in a component file** runs `interface Props` → the component function → utilities → styles. Report any file that orders them differently.
- **Declaration order inside a body** runs from the widest scope inward: jotai scope or bunja values → page-local context → component-local context → local state → derived values → handlers and effects. Variables that form one concept sit together with no unrelated line between them. A large or meaningful expression gets a name; a one-use fragment of one to four lines whose name reveals no concept is inlined where it is used.
- **Comments earn their place.** Delete a comment that restates the name, signature, or control flow next to it, and delete documentation the code already explains. Keep a comment that carries the intention, the invariant, or the upstream bug. Keep a `TODO` that marks a decision genuinely still pending.

**Strong preferences — report them**

- **Evaluate in one place.** A `let` declared empty and then filled by an `if` / `else if` ladder is a finding. Move the evaluation inside the construct that owns it — the effect, the function, the expression — and return the value.
- **Correct by construction.** A fix that adds a cleanup loop, sweep, timeout or retry to guard a state the design could make impossible is a finding: name the invariant that removes the bad state, and settle legacy deployments or data with a one-off cleanup rather than a compatibility path in the code.
- **Plain TypeScript first.** Resource management (a connection, a timer) lives in a plain TS factory that imports no jotai, with state in closure variables and a `subscribe` when needed; an event-like value is a listener set (`onX(listener) => unsubscribe`), not an atom. An atom or bunja is for state several components read reactively. Scattered `let` flags (`disposed`) collapse into one `AbortController` or one source state.
- **`export const`** for every named export, never `export default` or `export { foo }`.
- **Config is not env.** `.env` and the `env.ts` that parses it hold secrets and genuinely per-deploy values only; a non-secret constant (a path, a timeout, a row cap) is an `export const` in the module's `config.ts`.
- **Serve static assets, never inline them.** CSS compiled at build time is served from its own route with `Cache-Control: public, max-age=31536000, immutable` and a content-hash query, since CSS inlined into every response can never be cached.
- **Tokens stay byte-identical.** A token, signature or cookie value is compared and re-sent byte for byte, so a parser that decodes it (`set-cookie-parser`'s default `decodeValues: true`) is a finding, and its fixtures carry encoded characters such as `%2B` and `%3D`; a parser swapped in for a working regex once turned `%2B` into `+` and caused an endless production login redirect.
- **Hidden text serves the screen reader, not the old glyph.** When a glyph (`·`, `-`) becomes a CSS shape, hidden text goes only where a word boundary would vanish, in a form a screen reader pauses on (`, `), never a visually hidden copy of the original symbol.
- **Modularize by domain**, meaning the problem area, never by slice (components, atoms, stores, hooks). Load the `modularize-by-domain` skill when the diff moves files or draws a module boundary. A single file holding several domains is the same finding.

**Baseline-dependent — check the baseline first**

- **A commit is not a release.** Before you protect a line, find out whether it exists on `main`. Code already on `main` has shipped, so caution about changing it is correct. Code that exists only on this branch has never reached production, so it carries no compatibility debt — a shim, a deprecation path, a preserved old name, or a backward-compatible overload added for a branch-local caller is scope creep, and the fix is to change the thing directly and rename it when its concern widened.

**Baseline guidance — informs your judgment, not a finding on its own**

- Lint and typecheck run on every change. Report a diff that skipped them.
- Device testing runs only when the change actually needs a device. Do not report a missing device test otherwise.
- A deletion needs a passing test proving it is safe. That one is a real finding.
- A command handed to a human runs idempotently from any working directory.
