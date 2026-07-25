---
name: docs-write-reference
description: Write a reference document — the reader wants to look up an exact fact (API surface, config options, CLI flags). Invoked from the docs-write pipeline; also usable directly when the task is unambiguously reference material.
---

# docs-write-reference

Load `docs-write` first if its core rules are not already in context. Draft by the rules below, then finish with the pipeline's review step: spawn `prose-editor` on the draft and apply its findings before publishing.

## Shape

- Structure for scanning: tables, signatures, uniform entry layout. Don't narrate.
- Complete coverage of the surface — a reference with holes is worse than none.
- Accurate types, signatures, and defaults, verified against source, not memory.
- Examples for non-obvious entries only.

## Watch for

- Opinion or tutorial drift — no "you probably want…", no step sequences.
- Entry structure that varies between items.
- Unverified defaults and version claims.
