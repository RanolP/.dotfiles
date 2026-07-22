---
name: docs-write
description: Entry point for writing any outside-facing document — READMEs, guides, tutorials, API references, design/status docs, issue bodies, PR bodies, release notes. Use BEFORE drafting anything a reader other than the author will see. Classifies the document's purpose, routes to the matching docs-write-* purpose skill, and mandates a prose-editor review pass on every draft. Also holds the shared core rules: information architecture, sentence craft, Korean prose, labels & jargon.
---

# docs-write — writing pipeline entry

Every outside-facing document goes through this pipeline. Never skip a step.

1. **Classify the purpose** with the table below. One dominant purpose per document — if it needs two, split into two documents and link them.
2. **Invoke the matching purpose skill** and draft by its checklist plus the core rules below.
3. **Review**: spawn the `prose-editor` agent on the finished draft. This step is mandatory even when the draft feels done — the reviewer is a zero-context outside reader; the author never is.
4. **Apply the findings**, then deliver or publish.

| Purpose | Reader's goal | Skill |
|---------|---------------|-------|
| Learning (tutorial) | "Teach me to do this, step by step" | `docs-write-tutorial` |
| Deep explanation (concept) | "Help me understand why/how it works" | `docs-write-concept` |
| Problem-solving (how-to) | "I have a specific task — unblock me" | `docs-write-howto` |
| Reference | "Let me look up an exact fact" | `docs-write-reference` |
| Status / design (issue, ADR, PR body) | "What's the state, what was decided, why" | `docs-write-status` |

## Core rules (apply to every purpose)

### 1. Information architecture

1. **One thing per page.** A page answers one question. "Also, …" means a second page.
2. **Never skip the overview.** Open with what this is, who it's for, and what the reader can do after.
3. **Be predictable.** Conventional section order, names, and structure for the doc type. Surprise is friction.
4. **Value first.** Most useful information at the top of the page and of each section. Defer caveats and background.
5. **Headings carry the outline.** The whole doc should be understandable from headings alone; make them specific and parallel.
6. **Explain in detail where it counts.** Slow down on error-prone steps: exact command, expected output, failure modes.

### 2. Sentence craft

Write each sentence to be read once.

- **Compact** — cut words that carry no information. ("To use this feature, install the package first.")
- **Concrete** — specifics over vague qualifiers. ("cuts cold-start latency from ~800ms to ~120ms", not "significantly improves performance")
- **Consistent** — one term per concept, one format per repeated element.
- **Clear subject, active voice** — name who does what.
- **One idea per sentence** — split sentences that chain claims with "and"/"but".

### 3. Korean prose (한국어 문서)

- **번역체를 피한다.** "~되어진다", "~에 의해", "~에 대해" 남용 금지; 능동·간결한 한국어로. ("이 함수가 데이터를 처리한다.")
- **불필요한 한자어·외래어를 줄인다.** 쉬운 우리말 우선; 정착된 기술 용어(캐시, 토큰, 빌드)는 억지로 바꾸지 않는다.
- **주어를 분명히 한다.** 행위 주체가 모호하면 오해를 부른다.
- **조사와 어미를 일관되게.** 한 문서 안에서 "~합니다/~한다"를 섞지 않는다.
- **로마자·코드 식별자는 원형 그대로.** `useState`를 "유즈스테이트"로 쓰지 않는다.

### 4. Labels, jargon, and compression

Each rule earned by a real review:

- **Never use a label before defining it.** Letter labels ("Option A/B"), coined terms ("신원 블로커"), role abstractions ("정책 평면") mean nothing to a cold reader. Introduce the alternatives first, then the decision; prefer real names over letters. A coined term that must exist gets an inline definition at first use, plus a glossary entry if used repeatedly.
- **Describe the mechanism, don't name-drop the pattern.** "점진적으로 적용한다. 한 번에 갈아엎지 않고 하나씩 옮긴다" beats "Strangler Fig 패턴으로 간다".
- **Replace abstract role-words with concrete duties.** "controller가 신원 확인·권한 검사·감사를 맡는다", not "controller가 정책 평면을 맡는다".
- **Telegraphic compression is not concision.** Em-dash/middot/arrow chains and "X = Y" noun fragments make the reader decompress. Write complete sentences; get brevity from structure: one topic per bullet line, elaboration one level down as a sub-list.
- **Don't narrate the obvious.** No meta-sentences like "현재 상태는 `지금 구조` 절에 있다" — headings already say that.
- **Use the platform's affordances.** On GitHub: task-list checkboxes (`- [x]` / `- [ ]`) for done/remaining work, Mermaid instead of ASCII diagrams.

## Pre-publish checklist

- [ ] Single, correct purpose — not a mix; the purpose skill's own checklist passed.
- [ ] Overview up top; most valuable content first; headings convey the outline.
- [ ] Sentences compact, concrete, consistent, active, one-idea-each.
- [ ] (Korean) no 번역체, clear subjects, uniform 어미.
- [ ] Every label/coined term defined at or before first use; glossary (if any) at the bottom, unannounced.
- [ ] No pattern name-drops where a plain description works; no telegraphic "X = Y" fragments.
- [ ] Every factual claim (command, type, default, version) verified against source.
- [ ] `prose-editor` ran on the final draft and its findings were applied.

---

*Core rules adapted from [toss/technical-writing](https://github.com/toss/technical-writing) ("개발자를 위한 글쓰기 기본기", technical-writing.dev), licensed CC BY-NC-SA 4.0, and shared under the same license.*
