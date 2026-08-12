# gh pr — creating and updating pull requests

## PR template — the gotcha

`gh pr create --body`/`--body-file` does **NOT** auto-apply the repo's PR template — that only happens in the web UI. You must find it and fill it in yourself:

1. **Detect it**, in order: `.github/` first, then repo root, then `docs/`. Match `PULL_REQUEST_TEMPLATE` case-insensitively with a `.md` or `.txt` extension. A `PULL_REQUEST_TEMPLATE/` *directory* means multiple named templates — pick the one that fits.
2. **Fill every section.** Keep the template's headers verbatim; write the prose underneath. Don't drop sections — answer them or mark them N/A with a reason. Never invent your own section layout when a template exists.
3. **Write to a temp file**, then `gh pr create --title "<title>" --body-file <file>`.

## PR title

Conventional Commits, imperative mood — same rules as commit subjects (see `git-master`).

## PR body — the shape

The body answers one question: **리뷰어가 진정으로 궁금해할 게 뭘까.** Everything below follows from that.

**Sections = the repo template, verbatim.** In `internal-web` and `internal-app` that is exactly four headers, checklist boilerplate included:

```
## 개요
## 작업 내역
## 관련 카드
## 변경 체크리스트
- [ ] 변경 후 확인이 필요한 기능을 명시해주세요
- [ ] Ex) 작품이 iOS에서 재생
```

Add no section of your own. A PR body has no meta section, no "이 PR은 …" preamble, no apology, no 사족 — `리뷰에에게 절이 왜 필요해 ㅋㅋ`.

**작업 내역 = one numbered item per commit**, in commit order, each opening with the short sha and the commit subject. Under it, one sub-bullet stating the **intent** of the change, and a `리뷰 포인트:` sub-bullet when a decision is non-obvious — name the decision and the evidence behind it:

```markdown
3. 795077968 feat: 최근 채팅 pill 컴포넌트를 구현한다
   - 표현 전용 배지 — 쌓인 개수는 주입받고, 탭 시 꼬리 복귀만 위임
4. e1b01069a feat: 채팅 리스트 컴포넌트를 구현한다
   - 비반전 Animated.FlatList + 꼬리 500행 상주 창 — 스크롤 핸들러는 UI 스레드
   - 리뷰 포인트: 창 고정 앵커를 길이가 아닌 머리 행 id로 잡은 이유(포화 시 길이 파생
     창은 읽던 행이 밀림, getWindowStart 순수 함수 + 테스트)
```

Never re-paste a commit body under its own item. The reviewer clicks the sha for that; the item exists to say *why*, not *what again*.

**~25 lines.** A body that restates every commit message is the failure this replaces.

**Show, don't narrate.** A diagram or a rendered screenshot goes *inside* the numbered item it belongs to:

- **Mermaid** for flow, state, and sequence — GitHub renders ` ```mermaid ` fences natively. Diagram only what this PR does.
- **Screenshot / rendered output** instead of describing UI in prose.
- Where mermaid does not render (Jira ADF), precompile to SVG and leave a placeholder region for the human to upload.
- A fence that fails to parse shows the reader "Unable to render rich display" and nothing else. The `pr-body-guard` hook lints every fence before `gh pr create|edit` runs — inside a backtick markdown-string label, use a real newline, never `<br/>`.

**Link instead of duplicating.** 피그마에 이미 있는 정보를 중복해서 적지 말자 — link it properly. A bare `TICKET-####` auto-links and renders the card title, so never hand-write the title beside it, and never leave a raw Jira URL in a body.

**Plain and honest over defensive.** Say the limitation outright: "PR 전체는 완전한 코드지만, 개별적인 커밋은 Lint/Typecheck가 실패할 수 있다" — not a hedged clause about 과도기.

**Title**: one short line with the description merged in, not a bare ticket key.

## PR body — Korean, 개조식 위주

Write the body in Korean, terse outline style (개조식): noun-phrase or `-함`/`-됨` bullets, not full paragraphs.

Apply inline prose rules (from technical-writing's Korean rules):

- **번역투 제거**: 명사 나열 → 동사로, 피동 → 능동, `~되어지다` 금지, 무생물 주어 → 행위 주체, `~를 통해` → `~로`, 불필요한 `-들` 삭제.
- **한 항목당 한 가지 생각** — 한 불릿에 두 주장을 `~하고`로 잇지 않는다.
- **모호한 표현 대신 구체적 수치** — "크게 개선" 대신 "콜드스타트 800ms → 120ms".
- **개념당 한 용어** — 같은 것을 매개변수/인자/옵션으로 번갈아 부르지 않는다.
- **약어는 첫 등장에 풀어 쓴다.**

A PR body is outside-facing prose: run a `prose-editor` agent pass (Korean pipeline) on it before publishing.

## Link issues

Use exact closing keywords so the issue auto-closes on merge: `close`/`closes`/`closed`, `fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved`.

- A keyword must precede *each* number: `Fixes #12, fixes #15` (not `Fixes #12, #15`).
- Auto-close fires only when the PR merges into the **default branch**.
- Cross-repo: `Fixes owner/repo#N`.
- Inside lists, a bare `#N` renders with the issue title on GitHub — don't hand-write a duplicate summary next to it.

## Before you create — find the PR this task already has

Always check first. Scope the search by what the user said:

- **User named a specific PR** → that PR is the target, whoever authored it. Read it and continue it.
- **User named none** → search the user's own PRs only, with `--author @me`. Other people's PRs never decide where your work belongs.

`gh pr list --head <branch>` misses the real duplicate: it arrives on a NEW branch, usually after a context reset. Match by content instead:

```sh
gh pr list --state open --author @me --limit 30 --json number,title,headRefName,files \
  --jq '.[] | "\(.number) \(.headRefName) — \(.title) | \([.files[].path] | join(", "))"'
```

Compare that file list against `git diff --name-only origin/<default-branch>...HEAD`, then follow the first case that applies:

1. **A found PR covers this same task** → it owns the work. Name it to the user — number, title, head branch — and ask whether to continue it. Wait for the answer, then commit onto its head branch and push. Create nothing.
2. **Work builds on an unmerged PR** → ask the user which base to use, and wait for the answer. Open a stacked PR only when the user asks for one.
3. **Work needs more than one PR** → present the split and get approval before you write any of the code.
4. **No overlap, single PR** → create it against the repo default branch.

## PR hygiene

- `--draft` for work in progress.
- Keep PRs small and single-purpose.
- Self-review the diff before requesting review.
- Ensure the branch is clean and rebased before opening (defer to `git-master`).
