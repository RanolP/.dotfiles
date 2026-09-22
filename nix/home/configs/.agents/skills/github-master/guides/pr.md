# gh pr — creating and updating pull requests

## PR template — the gotcha

`gh pr create --body`/`--body-file` does **NOT** auto-apply the repo's PR template — that only happens in the web UI. You must find it and fill it in yourself:

1. **Detect it**, in order: `.github/` first, then repo root, then `docs/`. Match `PULL_REQUEST_TEMPLATE` case-insensitively with a `.md` or `.txt` extension. A `PULL_REQUEST_TEMPLATE/` *directory* means multiple named templates — pick the one that fits.
2. **Fill every section.** Keep the template's headers verbatim; write the prose underneath. Don't drop sections — answer them or mark them N/A with a reason. Never invent your own section layout when a template exists.
3. **Write to a temp file**, then `gh pr create --title "<title>" --body-file <file>`.

## PR title

Conventional Commits, imperative mood — same rules as commit subjects (see `git-master`).

## PR body — the shape

The body answers one question: **what does the reviewer genuinely want to know?** Everything below follows from that. Worked specimens live in `guides/pr-body-examples.md` — read one when a principle here is clear but its shape is not.

**Dense, with the boundaries marked.** A body earns its space by packing information, and density tires the reader exactly where nothing shows one unit ending and the next beginning. So every unit opens with a marker the eye lands on before the content: a `###` sub-header for a group of items, a label prefix such as `리뷰 포인트:` or `증거:` for a line of a known kind, an arrow segment for 원인 / 결과 / 조치 inside one item, and indentation for what a cause forced. Push the density as far as the markers hold it, and reach for one more marker before reaching for one more sentence of explanation.

**Sections = the repo template, verbatim.** Keep its headers as they are and add no `##` of your own; anything extra goes in as a `###` under one of them.

**개요 is one line.** It says what was wrong and what was done. A measurement, a refuted hypothesis, and the scope of application all belong elsewhere, and a refuted hypothesis stays out of the body until a reviewer asks for it.

**작업 내역 = one short line per group of commits that does one thing.** Group the commits by what they accomplish, then write each group as a single line saying what was done. Carry no short sha and no commit subject into the body: the reviewer already has the commit list on the PR screen, so copying it there buys nothing.

Add a `리뷰 포인트:` sub-bullet only where you judge that without it a Haiku-level reader could not understand the change. That bar is deliberately high — most groups get the one line and nothing else. When one does earn the sub-bullet, say **why it had to be that way**, never what was decided, because the decision already sits in the diff and the reason is the only part the code cannot carry.

**A number is one `A -> B (-N%p)` line**, and its backing is a `증거: <링크>` line. Whatever the reviewer confirms by opening the link stays unexplained in the body. A table earns its place only from three columns up, with a different kind of thing per row.

**~25 lines.** A body that restates every commit message is the failure this replaces.

**Show, don't narrate.** A diagram or a rendered screenshot goes *inside* the item it belongs to:

- **Mermaid** for flow, state, and sequence — GitHub renders ` ```mermaid ` fences natively. Diagram only what this PR does.
- **Screenshot / rendered output** instead of describing UI in prose.
- Where mermaid does not render (Jira ADF), precompile to SVG and place it with the `jira` CLI. A hosted image goes in as a `media` node with `type: "external"` through `jira edit queue`. A local file needs the human to upload it through the Jira web UI first, because the CLI has no upload path; `jira media ls -i KEY` then prints the id to position.
- A fence that fails to parse shows the reader "Unable to render rich display" and nothing else. The `pr-body-guard` hook lints every fence before `gh pr create|edit` runs — inside a backtick markdown-string label, use a real newline, never `<br/>`.

**Link instead of duplicating.** Never restate information that already lives in Figma — link it properly. A bare ticket key auto-links and renders the card title, so never hand-write the title beside it, and never leave a raw Jira URL in a body.

**Plain and honest over defensive.** Say the limitation outright: "PR 전체는 완전한 코드, 개별 커밋은 Lint/Typecheck 실패 가능" — not a hedged clause about a transitional state.

**Title**: one short line with the description merged in, not a bare ticket key.

## PR body — Korean, 개조식-first

A reviewer opens a body to decide where to look, so both rules below make an item readable by position. `guides/pr-body-examples.md` holds a folded specimen.

**One predicate per unit (개조식).** An arrow chain (`->`) of noun phrases puts 원인, 결과 and 조치 in fixed positions, so each is found by position. Cut the item at every connective, let one predicate stand per segment, and put what is true but not load-bearing in parentheses.

**Forward reasoning 대국적으로.** Fold the items by cause: name the root cause, put it alone at the top level, and indent every action it forced. The reviewer then reads the cause once and takes its whole subtree with it, and the 개요 compresses the same chain into one line.

The `pr-body-guard` hook enforces both: it passes a Hangul item that keeps one predicate per arrow-segment and ends on a noun or `-함`/`-됨`/`-임`/`-음`, and passes a section once its items nest under their cause (a section stays under the guard's eye from 5 top-level items up; commit-sha lines, fences, headings and template lines are exempt). Both share one escape hatch: when the prose or the flat list is deliberate, re-run with `PR_BODY_GUARD_ALLOW_PROSE=1` in front of the command.

Apply inline prose rules (from technical-writing's Korean rules):

- **Strip translationese (번역투)**: noun stacks → verbs, passive → active, no `~되어지다`, inanimate subject → the real actor, `~를 통해` → `~로`, drop the unnecessary plural `-들`.
- **One idea per item** — never join two claims with `~하고` inside one bullet.
- **Concrete numbers over vague wording** — write `콜드스타트 800ms → 120ms`, not `크게 개선`.
- **One term per concept** — never alternate 매개변수/인자/옵션 for the same thing.
- **Expand an abbreviation on its first appearance.**

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
