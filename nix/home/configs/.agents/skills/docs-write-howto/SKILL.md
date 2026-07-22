---
name: docs-write-howto
description: Write a problem-solving document (how-to / guide) — the reader has a specific task and wants to be unblocked. Invoked from the docs-write pipeline; also usable directly when the task is unambiguously a how-to.
---

# docs-write-howto

Load `docs-write` first if its core rules are not already in context. Draft by the rules below, then finish with the pipeline's review step: spawn `prose-editor` on the draft and apply its findings before publishing.

## Shape

- Title names the exact problem. Preconditions stated up front.
- Give the shortest correct path first. Assume the reader knows the domain — don't teach fundamentals.
- Alternatives and their trade-offs come only after the main path.
- Show exact commands and expected output on error-prone steps; name the failure modes.

## Watch for

- Tutorial drift: teaching instead of unblocking.
- A "main path" that secretly branches — pick one and demote the rest.
- Missing preconditions discovered halfway through the steps.
