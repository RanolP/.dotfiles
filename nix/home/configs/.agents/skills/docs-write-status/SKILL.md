---
name: docs-write-status
description: Write a status/design document — living issue bodies, ADRs, design docs, PR bodies. The reader wants "what's the state, what was decided, and why". Invoked from the docs-write pipeline; also usable directly for issue/ADR/PR-body writing.
---

# docs-write-status

Load `docs-write` first if its core rules are not already in context. Draft by the rules below, then finish with the pipeline's review step: spawn `prose-editor` on the draft and apply its findings before publishing.

## Section order = thought flow

Order sections the way the decision was thought through, not by reference convenience:

1. **현황** — a short callout: the options that existed, what was chosen, the one-line reason.
2. **문제 상황** — what hurts, and the constraints that cannot move. State the overall goal plainly; demote heavy examples to one line under it.
3. **해결책 제안** — each candidate side by side, **each carrying its own diagram**. Mark 채택/보류 in the heading.
4. **채택 근거** — why the winner won and the loser was dropped, plus the conditions for revisiting.
5. **진행 상황** — split into 된 것 / 해야 할 것 / 안 할 것, in step order.
6. Appendices after a divider: deferred plans, references, glossary.

## Rules

- **A glossary is a footnote.** It goes at the bottom, unannounced — never open the document with a term table, never write "용어는 아래에 있다".
- **Checkboxes for state.** Done work `- [x]`, remaining work `- [ ]` — the platform then shows progress in the issue list. Deferred plans also get `- [ ]` so they're trackable if revived.
- **Diagrams render.** Mermaid (`flowchart LR`) over ASCII art; each option's diagram lives under that option's heading, not in a shared pile.
- **Decisions carry their rejection.** "안 할 것" states what was rejected in one line and points at 채택 근거 — never re-explains it.
- For GitHub mechanics (templates, gh commands, comment conventions), see the `github-master` skill's `guides/issue.md` and `guides/pr.md`.

## Watch for

- The failure mode that motivated this skill: a body that is one telegraphic term-dump — "X = Y" fragments, undefined labels ("Option A"), pattern name-drops, glossary-first ordering. See `docs-write` core §4.
- Status lines that mix done and pending in one sentence — split them into the checklist.
- A "미래/보류" plan styled like the adopted one — gate it visibly ("재검토 조건 충족 시").
