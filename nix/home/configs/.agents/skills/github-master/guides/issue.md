# gh issue — finding, scoping, and writing issues

## Find & scope before starting

- List candidates: `gh issue list --label "<label>" --state open`.
- Search across a repo/org for unclaimed work: `gh search issues --owner <org> --no-assignee --state open`. Note: `gh search issues --state` accepts only `open|closed`; for richer filters use search qualifiers in the query (`is:open`, `is:closed`, `no:assignee`, `label:bug`).
- Read the whole thread before committing: `gh issue view <N> --comments`.
- Confirm the issue is unassigned / not already in progress, and read CONTRIBUTING before opening a PR.

## Writing issues and comments

- Check for an issue template first (`.github/ISSUE_TEMPLATE/`); when one exists, keep its headers verbatim and fill every section — never invent your own layout.
- Issue text is outside-facing prose: Korean 개조식, same inline prose rules as PR bodies (see `guides/pr.md`).
