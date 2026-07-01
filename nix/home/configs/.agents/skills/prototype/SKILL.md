---
description: Build throwaway code that answers a design question before committing to it.
when_to_use: When the user wants to prototype, sanity-check a data model or state machine, mock up a UI, explore design options, or says "prototype this", "let me play with it", "try a few designs". Invoke before writing production code for the design.
---

A prototype is throwaway code that answers a question. The question decides the shape. Identify which branch you are in -- from the prompt, the surrounding code, or by asking. If genuinely ambiguous and the user is AFK, default by context (backend module -> logic; page/component -> UI) and state the assumption at the top of the prototype.

## Branch A: logic ("does this logic / state model feel right?")
A tiny interactive terminal app the user drives by hand to push a state machine through cases that are hard to reason about on paper.
- Write down the state model and the question first (one paragraph, top of file).
- Isolate the logic behind a small pure interface that could be lifted into the real codebase later -- a reducer `(state, action) => state`, a state machine, a set of pure functions, or a module with a clear method surface. No I/O, no terminal code inside it.
- Build the smallest TUI over it: on each tick clear the screen and re-render the whole frame -- current state pretty-printed (one field per line), then keyboard shortcuts at the bottom (`[a] add  [t] tick  [q] quit`). Read one keystroke, dispatch to a handler, re-render.
- The TUI shell is throwaway; the logic module is the bit worth keeping.

## Branch B: UI ("what should this look like?")
Several radically different UI variations on a single route, switchable from a floating bottom bar. Default to 3 variants; cap at 5.
- Strongly prefer hosting variants on an existing page (real header, sidebar, data, density) gated by a `?variant=` URL search param -- only the rendered subtree swaps. Only create a throwaway route (named so it is obviously a prototype) when the thing genuinely has no existing page to live in.
- Variants must be structurally different (layout, information hierarchy, primary affordance), not just colour/copy. Use the project's component library.
- Floating switcher: fixed bottom-centre bar with prev arrow, current variant label, next arrow; arrows update the URL search param (reload-stable, shareable); `<-`/`->` keys also cycle (not while an input/textarea/contenteditable is focused); visually distinct; hidden in production builds.

## Shared rules (both branches)
1. Throwaway from day one and clearly marked -- located near where it will be used, named so a reader sees it is a prototype.
2. One command to run, via the project's existing task runner.
3. No persistence by default -- state lives in memory unless the question is specifically about persistence (then a scratch DB/file named "PROTOTYPE -- wipe me").
4. Skip the polish -- no tests, no abstractions, no error handling beyond making it runnable.
5. Surface the state -- print/render the full relevant state after every action or variant switch.
6. Delete or absorb when done -- fold the validated decision into real code (rewritten properly), don't leave it rotting.

## When done
The answer is the only thing worth keeping. Capture it somewhere durable (commit message, ADR, issue, or a `NOTES.md` next to the prototype) along with the question it answered, then delete the prototype.

## Constraints
- NEVER pick the wrong branch -- a logic prototype answering a UI question (or vice versa) wastes the whole effort
- NEVER add tests, generalise, or wire to real mutations/database -- it stops being a prototype
- NEVER ship the prototype shell to production -- rewrite the winner properly when folding it in
