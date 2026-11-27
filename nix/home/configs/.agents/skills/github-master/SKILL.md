---
name: github-master
description: Disciplined GitHub workflow via the gh CLI. Lean router — per-command guides in guides/ (pr.md — PR template detection and filling, Korean 한다체 body, issue-closing keywords; issue.md — issue scoping and writing); read the matching guide before a mutating gh pr / gh issue command. Use when creating or updating pull requests, searching or triaging issues, or working with gh.
---

# GitHub master

Apply when working with GitHub PRs/issues through `gh`. Defers to `git-master` for all commit/branch/push mechanics and respects the `claude/*` push rule.

Per-command guides live in `guides/`; read the matching guide before a mutating `gh pr` / `gh issue` command:

- `guides/pr.md` — PR template detection/filling (gh does NOT auto-apply it), title rules, Korean body (background 개요, `영역 라벨: 한 문장` items in complete 한다체 sentences) + inline prose rules, issue-closing keywords, hygiene.
- `guides/issue.md` — finding/scoping issues, issue templates, writing issues and comments.
- `guides/babysit.md` — after a PR is open: drive it to merge-ready (conflicts, then review threads, then CI), triage bot review findings against the code. Read it when asked to watch, babysit, or answer review on a PR.
- `guides/shipping.md` — verdicts tied to a patch (patch-id across rebases), when a trunk move forces a re-test, and landing a stack bottom-up through its verified run. Read it when asked to land or merge a PR or a stack.
- `scripts/watch-pr` — read-only PR and stack status watcher: one JSON verdict per poll, one exit code per blocker. `guides/babysit.md` documents it.

If the hook just injected a guide, follow the injected text — no need to re-read the files.

---

*Distilled from [gh CLI docs](https://cli.github.com/manual/), [GitHub linking-issues docs](https://docs.github.com/issues), and toss/technical-writing Korean rules. Defers to `git-master` for git mechanics.*
