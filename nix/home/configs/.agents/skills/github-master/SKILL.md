---
name: github-master
description: Disciplined GitHub workflow via the gh CLI — scope issues before starting, fill out the repo's PR template by hand (gh does NOT auto-apply it), write PR bodies in Korean 개조식 with inline prose rules, and link issues with exact closing keywords. Use when creating or updating pull requests, searching or triaging issues, or working with gh.
---

# GitHub master

Apply when working with GitHub PRs/issues through `gh`. Defers to `git-master` for all commit/branch/push mechanics and respects the `claude/*` push rule.

## Find & scope issues before starting

- List candidates: `gh issue list --label "<label>" --state open`.
- Search across a repo/org for unclaimed work: `gh search issues --owner <org> --no-assignee --state open`. Note: `gh search issues --state` accepts only `open|closed`; for richer filters use search qualifiers in the query (`is:open`, `is:closed`, `no:assignee`, `label:bug`).
- Read the whole thread before committing: `gh issue view <N> --comments`.
- Confirm the issue is unassigned / not already in progress, and read CONTRIBUTING before opening a PR.

## PR template — the gotcha

`gh pr create --body`/`--body-file` does **NOT** auto-apply the repo's PR template — that only happens in the web UI. You must find it and fill it in yourself:

1. **Detect it**, in order: `.github/` first, then repo root, then `docs/`. Match `PULL_REQUEST_TEMPLATE` case-insensitively with a `.md` or `.txt` extension. A `PULL_REQUEST_TEMPLATE/` *directory* means multiple named templates — pick the one that fits.
2. **Fill every section.** Keep the template's headers verbatim; write the prose underneath. Don't drop sections — answer them or mark them N/A with a reason.
3. **Write to a temp file**, then `gh pr create --title "<title>" --body-file <file>`.

## PR title

Conventional Commits, imperative mood — same rules as commit subjects (see `git-master`).

## PR body — Korean, 개조식 위주

Write the body in Korean, terse outline style (개조식): noun-phrase or `-함`/`-됨` bullets, not full paragraphs. Typical sections: 요약 · 변경사항 · 테스트 · 관련 이슈.

Apply inline prose rules (from technical-writing's Korean rules):

- **번역투 제거**: 명사 나열 → 동사로, 피동 → 능동, `~되어지다` 금지, 무생물 주어 → 행위 주체, `~를 통해` → `~로`, 불필요한 `-들` 삭제.
- **한 항목당 한 가지 생각** — 한 불릿에 두 주장을 `~하고`로 잇지 않는다.
- **모호한 표현 대신 구체적 수치** — "크게 개선" 대신 "콜드스타트 800ms → 120ms".
- **개념당 한 용어** — 같은 것을 매개변수/인자/옵션으로 번갈아 부르지 않는다.
- **약어는 첫 등장에 풀어 쓴다.**

For high-stakes PRs, optionally suggest a `prose-editor` agent pass (Korean pipeline) — helpful, not mandatory.

## Link issues

Use exact closing keywords so the issue auto-closes on merge: `close`/`closes`/`closed`, `fix`/`fixes`/`fixed`, `resolve`/`resolves`/`resolved`.

- A keyword must precede *each* number: `Fixes #12, fixes #15` (not `Fixes #12, #15`).
- Auto-close fires only when the PR merges into the **default branch**.
- Cross-repo: `Fixes owner/repo#N`.

## PR hygiene

- `--draft` for work in progress.
- Keep PRs small and single-purpose.
- Check for an existing PR first: `gh pr list --head <branch>`.
- Self-review the diff before requesting review.
- Ensure the branch is clean and rebased before opening (defer to `git-master`).

---

*Distilled from [gh CLI docs](https://cli.github.com/manual/), [GitHub linking-issues docs](https://docs.github.com/issues), and toss/technical-writing Korean rules. Defers to `git-master` for git mechanics.*
