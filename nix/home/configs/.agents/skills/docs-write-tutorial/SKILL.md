---
name: docs-write-tutorial
description: Write a learning document (tutorial) — the reader wants "teach me to do this, step by step". Invoked from the docs-write pipeline; also usable directly when the task is unambiguously a tutorial.
---

# docs-write-tutorial

Load `docs-write` first if its core rules are not already in context. Draft by the rules below, then finish with the pipeline's review step: spawn `prose-editor` on the draft and apply its findings before publishing.

## Shape

- Lead with a concrete, runnable end-to-end path. One happy path only — no branching into options.
- Start from a clean state the reader can actually reach, and say what that state is.
- Every step is verifiable: "you should now see X" after each action.
- No step depends on knowledge not yet given.
- End with a working result the reader can confirm.

## Watch for

- Option branches ("or, if you prefer Y…") — cut them or move to a linked how-to.
- Steps that silently assume installed tools or prior configuration.
- Teaching theory mid-step — link a concept doc instead.
