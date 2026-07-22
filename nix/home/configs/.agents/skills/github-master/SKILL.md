---
name: github-master
description: Disciplined GitHub workflow via the gh CLI. Lean router — per-command guides in guides/ (pr.md — PR template detection and filling, Korean 개조식 body, issue-closing keywords; issue.md — issue scoping and writing) are force-injected per session by the gh-guard PreToolUse hook on mutating gh pr / gh issue commands. Use when creating or updating pull requests, searching or triaging issues, or working with gh.
---

# GitHub master

Apply when working with GitHub PRs/issues through `gh`. Defers to `git-master` for all commit/branch/push mechanics and respects the `claude/*` push rule.

Per-command guides live in `guides/`; the `gh-guard` PreToolUse hook force-injects the matching guide once per session (3h window) when a mutating `gh pr` / `gh issue` command runs:

- `guides/pr.md` — PR template detection/filling (gh does NOT auto-apply it), title rules, Korean 개조식 body + inline prose rules, issue-closing keywords, hygiene.
- `guides/issue.md` — finding/scoping issues, issue templates, writing issues and comments.

If the hook just injected a guide, follow the injected text — no need to re-read the files.

---

*Distilled from [gh CLI docs](https://cli.github.com/manual/), [GitHub linking-issues docs](https://docs.github.com/issues), and toss/technical-writing Korean rules. Defers to `git-master` for git mechanics.*
