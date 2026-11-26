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

**Dense, with the boundaries marked.** A body earns its space by packing information, and density tires the reader exactly where nothing shows one unit ending and the next beginning. So every unit opens with a marker the eye lands on before the content: a `###` sub-header for a group of items, an area label such as `JS → Native:` before an item's sentence, a label prefix such as `증거:` for a line of a known kind, `**[BREAKING]**` on a change that breaks its callers, and indentation for what a cause forced. Push the density as far as the markers hold it, and reach for one more marker before reaching for one more sentence of explanation.

**Sections = the repo template, verbatim.** Keep its headers as they are and add no `##` of your own; anything extra goes in as a `###` under one of them.

**개요 gives the background.** In one sentence it says where the change comes from and why now -- the document, incident or earlier decision that makes it due (`v2 문서에 있는 VideoSource 개념을 사전 도입해 ...`) -- because the title already says what was done. A measurement, a refuted hypothesis, and the scope of application all belong elsewhere, and a refuted hypothesis stays out of the body until a reviewer asks for it.

**작업 내역 = one `영역 라벨: 한 문장` item per group of commits that does one thing.** Group the commits by what they accomplish. The label names the area the group touched (`JS → Native:`, `iOS DRM Key 리팩토링:`), and the sentence after it says what was done there. An arrow inside a label marks a direction (`JS → Native`). Carry no short sha and no commit subject into the body: the reviewer already has the commit list on the PR screen, so copying it there buys nothing.

**A breaking change opens with `**[BREAKING]**`**, and its sub-items give the background (what existed before) and the reason (why it has to change). When the change covers more than one prior case, each case gets its own background sub-item, so two cases never merge into one sentence. The reason is the part the code cannot carry; the consequences -- an error code, a type error, a contract version bump -- already show in the diff, so the diff carries them.

**Consequences that must be listed hang under their cause.** Write the cause once as the parent item (`네이티브 Source 형태가 바뀌었기 때문에`) and each action it forced as a sub-item sentence (`네이티브 계약 버전을 1 올린다.`), so the reviewer reads the cause once and takes every action with it.

**A number is one `A -> B (-N%p)` line**, and its backing is a `증거: <링크>` line. Whatever the reviewer confirms by opening the link stays unexplained in the body. A table earns its place only from three columns up, with a different kind of thing per row.

**~25 lines.** A body that restates every commit message is the failure this replaces. Evidence logs, run histories and long tables go in a PR comment the body links to: the body keeps one line per check, its command and verdict, and that line carries the comment's link.

**A count or tree claim holds at the landing commit.** Re-run the command behind each number or file tree in the body at the final head, and put that command in a fence under the claim, so a reviewer regenerates it rather than trusting it. Refresh both after any later push.

**A bug-fix body carries the proof.** Under the template's sections, add `재현:` (the steps that showed the bug), `원인:` (the root cause in one sentence), `증거:` (before and after, the failing then passing test or the two screenshots) and `영향 범위:` (each caller, screen or config the diff reaches, and what was run for it) label lines. A fix whose after-evidence still fails says so in the `증거:` line rather than claiming the fix.

**Show, don't narrate.** A diagram or a rendered screenshot goes *inside* the item it belongs to:

- **Block coding** for flow and branching — an indented `┣━` / `┗━` text tree in a plain fence, per the `prose-editor` agent (Rule 5). A structure picture is a hand-drawn SVG rendered to PNG, because mermaid's auto-layout reads poorly. Diagram only what this PR does.
- **Screenshot / rendered output** instead of describing UI in prose.
- In Jira ADF, place the SVG with the `jira` CLI. A hosted image goes in as a `media` node with `type: "external"` through `jira edit queue`. A local file needs the human to upload it through the Jira web UI first, because the CLI has no upload path; `jira media ls -i KEY` then prints the id to position.
- A fence that fails to parse shows the reader "Unable to render rich display" and nothing else. The `pr-body-guard` hook lints every fence before `gh pr create|edit` runs — inside a backtick markdown-string label, use a real newline, never `<br/>`.

**Link instead of duplicating.** Never restate information that already lives in Figma — link it properly. A bare ticket key auto-links and renders the card title, so never hand-write the title beside it, and never leave a raw Jira URL in a body.

**Plain and honest over defensive.** Say the limitation outright: "PR 전체는 완전한 코드, 개별 커밋은 Lint/Typecheck 실패 가능" — not a hedged clause about a transitional state.

**Title**: one short line with the description merged in, not a bare ticket key. It names what the PR achieves -- `feat(billing): 결제 수단 변경 지원` -- and leaves the implementation pieces to the body.

## PR body — Korean, 한다체 sentences

A reviewer opens a body to decide where to look, so the rules below let the item's own sentence say what happened and where. `guides/pr-body-examples.md` holds the user's own body as the specimen.

**Every item is a complete 한다체 sentence** ending in `-다.`, with its subject, object and verb in place, so the reader takes each relation from the sentence instead of rebuilding it. A cause rides on a connective inside the sentence (`~했고`, `~하기 때문에`, `~하므로`).

**Established terms keep their original form.** Write a term the field already names as it is named -- `Externally Tagged Union`, `struct`, `Online/Offline DRM` -- because the reader recognizes the original and has to decode a coined half-translation such as `태그 유니언`.

**Forward reasoning 대국적으로.** Fold the items by cause: name the root cause, put it alone at the top level, and indent every action it forced. The reviewer then reads the cause once and takes its whole subtree with it.

The `pr-body-guard` hook checks two of these: it passes a Hangul line once it ends in 한다체 rather than 합니다체 or 해요체 (`-니다`, `-요`), and passes a section once its items nest under their cause (a section stays under the guard's eye from 5 top-level items up; commit-sha lines, fences, headings and template lines are exempt). Both share one escape hatch: when the ending or the flat list is deliberate, re-run with `PR_BODY_GUARD_ALLOW_PROSE=1` in front of the command.

Apply inline prose rules (from technical-writing's Korean rules):

- **Strip translationese (번역투)**: noun stacks → verbs, passive → active, no `~되어지다`, inanimate subject → the real actor, `~를 통해` → `~로`, drop the unnecessary plural `-들`.
- **One idea per item** — two unrelated claims go in two items; a connective inside one item joins only clauses of the same fact.
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
3. **Work needs more than one PR** → present the split and get approval before you write any of the code. Split the code, not the save points: expand (add the new API beside the old, behavior unchanged), switch (move the call sites, the only behavior change), contract (delete the old code and any shim, and rewrite the tests to assert the new contract, deleting each test that only pinned the old internals). Each PR stays near 300 lines with its tests, passes type-check on its own, and is safe to deploy alone; "the switch is atomic" is a reason to re-plan, never to keep one large PR. Base an independent PR on the default branch and a dependent one on the PR below it, merge the stack bottom-up, and confirm each base with `gh pr view <n> --json baseRefName`.
4. **No overlap, single PR** → create it against the repo default branch.

## PR hygiene

- `--draft` for work in progress. Once the user has approved the PR and the first unit is pushed, open it as a draft right away, so CI and review bots run beside the remaining work.
- Keep PRs small and single-purpose. A feature PR carries only that feature: a new test framework, build-config changes and edits to unrelated packages go to their own PR, so read `git diff --stat origin/<default>` and move every path outside the feature out. Shared modules stay read-only in a feature PR -- build the behavior inside the feature directory, and justify each file outside it first when auditing the diff.
- Renaming a branch (`gh api -X POST repos/{owner}/{repo}/branches/{branch}/rename -f new_name=...`) retargets every PR that uses it as base, but permanently CLOSES the PR whose head it is: `gh pr reopen` fails because the old head ref is gone. Say before the rename that the head PR dies and its number changes, then recreate it as a draft with the old body (`gh pr view <old> --json body -q .body > file`, `gh pr create --draft --body-file file`) and update every Jira, Slack and doc link to the new number. Deleting and re-pushing the branch closes it the same way.
- Self-review the diff before requesting review.
- Ensure the branch is clean and rebased before opening (defer to `git-master`).
