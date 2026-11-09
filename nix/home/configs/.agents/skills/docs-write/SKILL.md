---
name: docs-write
description: Pre-draft step for any outside-facing document — README, guide, tutorial, reference, design/status doc, PR or issue body, release notes, Artifact page. Use BEFORE drafting text a reader other than the author will see: fixes reader, type, claims and outline, then hands the draft to the `prose-editor` agent, which holds the prose rules.
---

# docs-write — before the draft

1. **Name the reader** and what they will do with the doc once they finish it.
2. **Pick ONE type**; a doc that needs two types becomes two linked docs.
   - Tutorial — one runnable happy path from a reachable clean state, each step verifiable.
   - Explanation — why it matters, then the mental model, then the mechanics.
   - How-to — the exact problem, preconditions, the shortest correct path, alternatives after.
   - Reference — uniform scannable entries covering the whole surface, verified against source.
   - Status / design (PR body, issue, ADR) — current state, problem, options, rationale, progress checklist.
3. **List the core claims** before any prose, each with its concrete number or identifier.
4. **Outline headings** that alone carry the argument.
5. **Draft** from that outline.
6. **Spawn `prose-editor`** on the draft and apply its findings before delivering or publishing; it reads as a zero-context outside reader, which the author never is.
