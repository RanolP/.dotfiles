# gh pr — creating and updating pull requests

## PR template — the gotcha

`gh pr create --body`/`--body-file` does **NOT** auto-apply the repo's PR template — that only happens in the web UI. You must find it and fill it in yourself:

1. **Detect it**, in order: `.github/` first, then repo root, then `docs/`. Match `PULL_REQUEST_TEMPLATE` case-insensitively with a `.md` or `.txt` extension. A `PULL_REQUEST_TEMPLATE/` *directory* means multiple named templates — pick the one that fits.
2. **Fill every section.** Keep the template's headers verbatim; write the prose underneath. Don't drop sections — answer them or mark them N/A with a reason. Never invent your own section layout when a template exists.
3. **Write to a temp file**, then `gh pr create --title "<title>" --body-file <file>`.

## PR title

Conventional Commits, imperative mood — same rules as commit subjects (see `git-master`).

## PR body — Korean, 개조식 위주

Write the body in Korean, terse outline style (개조식): noun-phrase or `-함`/`-됨` bullets, not full paragraphs. Typical sections (only when the repo has no template): 요약 · 변경사항 · 테스트 · 관련 이슈.

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

## PR hygiene

- `--draft` for work in progress.
- Keep PRs small and single-purpose.
- Check for an existing PR first: `gh pr list --head <branch>`.
- Self-review the diff before requesting review.
- Ensure the branch is clean and rebased before opening (defer to `git-master`).
