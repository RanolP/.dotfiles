---
name: technical-writing
description: Principles for writing and reviewing developer-facing documentation — READMEs, API docs, guides, tutorials, design docs, reference pages, and release notes. Use when writing or restructuring any technical doc, or when the user asks to improve a document's wording, structure, or clarity. Covers picking the right document type, information architecture, sentence craft, and Korean prose rules. Distilled from toss/technical-writing (technical-writing.dev).
---

# Technical writing

Apply these rules whenever you write or review a technical document. The goal is a reader who finds what they need fast, understands it the first time, and trusts it. Default to revising the doc to satisfy these rules rather than just reporting that it violates them.

## 1. Choose the document type first

Every doc serves one dominant purpose. Pick one before writing — mixing types is the most common structural failure. If a doc needs two purposes, split it into two docs and link them.

| Type | Reader's goal | Lead with | Watch for |
|------|---------------|-----------|-----------|
| **Learning** (tutorial) | "Teach me to do this, step by step" | A concrete, runnable end-to-end path | Don't branch into options; one happy path only |
| **Deep explanation** (concept) | "Help me understand why/how it works" | The mental model, then the mechanics | Don't turn it into a how-to; explain, don't instruct |
| **Problem-solving** (how-to / guide) | "I have a specific task — get me unblocked" | The task and its precondition | Don't teach fundamentals; assume the reader knows the domain |
| **Reference** | "Let me look up an exact fact" | Structure for scanning (tables, signatures) | Don't narrate; be exhaustive and consistent, not prosy |

Per-type checklist:

- **Learning** — starts from a clean state the reader can reach; every step is verifiable ("you should now see X"); no step depends on knowledge not yet given; ends with a working result.
- **Deep explanation** — opens with why the topic matters; builds one concept on the previous; uses analogies and diagrams; separates "what it does" from "why it's designed this way."
- **Problem-solving** — title names the exact problem; states preconditions up front; gives the shortest correct path; lists alternatives and their trade-offs only after the main path.
- **Reference** — complete coverage of the surface; uniform entry structure; accurate types/signatures/defaults; examples for non-obvious entries; no opinion or tutorial drift.

## 2. Information architecture

1. **One thing per page.** A page answers one question or covers one topic. If you're tempted to write "also, …", that's a second page.
2. **Never skip the overview.** Open with what this is, who it's for, and what the reader will be able to do after. Don't drop the reader into step 1 with no map.
3. **Be predictable.** Match the reader's expectations: conventional section order, conventional names, conventional structure for the doc type. Surprise is friction.
4. **Value first.** Put the most useful information at the top of the page and the top of each section. Readers scan; reward the scan early. Defer caveats, edge cases, and background.
5. **Headings carry the outline.** A reader should understand the whole doc from headings alone. Make them specific and parallel ("Configure the database" not "Configuration"; "Step 2: Install dependencies" not "More setup").
6. **Explain in detail where it counts.** Don't gesture at hard parts. Where a step is error-prone or a concept is subtle, slow down, show the exact command/output, and name the failure modes.

## 3. Sentence craft

Write each sentence to be read once.

- **Compact** — cut words that carry no information.
  - Don't: "In order to be able to make use of this feature, you will first need to perform the installation of the package."
  - Do: "To use this feature, install the package first."
- **Concrete** — prefer specifics over vague qualifiers.
  - Don't: "This can significantly improve performance in many cases."
  - Do: "This cuts cold-start latency from ~800ms to ~120ms."
- **Consistent** — one term per concept, one format per repeated element. Don't alternate "parameter / argument / option" for the same thing. Keep tense, person, and list parallelism uniform.
  - Don't: "The `user` arg… the user parameter… that option…"
  - Do: "The `user` parameter… the `user` parameter…"
- **Clear subject, active voice** — name who does what.
  - Don't: "The config is loaded and the cache is then invalidated."
  - Do: "The server loads the config, then invalidates the cache."
- **One idea per sentence** — split sentences that join two claims with "and"/"but"/"," when each deserves its own.
  - Don't: "The function validates the input and if it fails it logs an error and returns null which the caller must handle."
  - Do: "The function validates the input. On failure, it logs an error and returns `null`. The caller must handle the `null`."

## 4. Korean prose (한국어 문서)

When the document is in Korean, also apply these — they don't translate from the English rules above:

- **번역체를 피한다.** 영어 어순·수동태를 그대로 옮기지 말 것. "~되어진다", "~에 의해", "가지다"(have 직역), "~에 대해" 남용을 줄이고 능동·간결한 한국어로 쓴다.
  - Don't: "이 함수에 의해 데이터가 처리되어진다."
  - Do: "이 함수가 데이터를 처리한다."
- **불필요한 한자어·외래어를 줄인다.** 쉬운 우리말이 있으면 그것을 쓴다. 단, 정착된 기술 용어(예: 캐시, 토큰, 빌드)는 억지로 바꾸지 않는다.
  - Don't: "해당 기능을 활용하여 작업을 수행한다."
  - Do: "이 기능으로 작업한다."
- **주어를 분명히 한다.** 한국어는 주어 생략이 잦지만, 기술 문서에서 행위 주체가 모호하면 오해를 부른다. 누가/무엇이 하는지 드러낸다.
- **조사와 어미를 일관되게.** "~합니다/~한다" 문체를 한 문서 안에서 섞지 않는다. 문서 전체에서 하나의 종결 어미 체계를 유지한다.
- **로마자·코드 식별자**는 원형 그대로 두고, 억지로 음차하지 않는다(예: `useState`를 "유즈스테이트"로 쓰지 않는다).

## 5. AI-assisted review (optional)

When reviewing a draft, run three focused passes rather than one vague "make it better":
1. **Structure pass** — is the document type singular and right? Does it open with an overview? Is the most valuable content first? Do headings alone tell the story?
2. **Sentence pass** — apply section 3 to each paragraph: compact, concrete, consistent, active, one-idea.
3. **Accuracy pass** — every command, signature, default, and version claim verified against source. Flag anything you couldn't verify rather than asserting it.

## Pre-publish checklist

- [ ] Single, correct document type — not a mix.
- [ ] Overview up top: what, who, outcome.
- [ ] Most valuable content first, on the page and in each section.
- [ ] Headings convey the full outline and are specific + parallel.
- [ ] One topic per page.
- [ ] Sentences are compact, concrete, consistent, active, one-idea-each.
- [ ] (Korean) no 번역체, clear subjects, uniform 어미, sensible 한자어/외래어.
- [ ] Every factual claim (command, type, default, version) is verified.
- [ ] Hard/error-prone steps are explained in detail with expected output.

---

*Adapted from [toss/technical-writing](https://github.com/toss/technical-writing) ("개발자를 위한 글쓰기 기본기", technical-writing.dev), licensed CC BY-NC-SA 4.0. This skill distills its principles and is shared under the same license.*
