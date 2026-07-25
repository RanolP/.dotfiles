---
name: docs-write-concept
description: Write a deep-explanation document (concept) — the reader wants "help me understand why/how it works". Invoked from the docs-write pipeline; also usable directly when the task is unambiguously conceptual explanation.
---

# docs-write-concept

Load `docs-write` first if its core rules are not already in context. Draft by the rules below, then finish with the pipeline's review step: spawn `prose-editor` on the draft and apply its findings before publishing.

## Shape

- Open with why the topic matters to this reader, then give the mental model before the mechanics.
- Build one concept on the previous one — no forward references to ideas not yet introduced.
- Use analogies and diagrams for structure the prose can't carry.
- Separate "what it does" from "why it's designed this way".

## Watch for

- How-to drift: explaining turns into instructing. Explain; link a how-to for the task.
- Mechanics before model — the reader needs the map before the terrain.
- Unearned abstraction: every abstract claim gets a concrete example.
