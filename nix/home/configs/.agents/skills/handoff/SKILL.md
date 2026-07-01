---
description: Write a handoff document for a new Claude Code session.
disable-model-invocation: true
argument-hint: "[goal for next session]"
---

## Goal

`$ARGUMENTS` is the goal for the next session. If empty, ask the user what the
next task is before proceeding.

## Phase 1: Gather state
Run before analyzing:

```bash
git status
git diff --stat
git log --oneline -5
```

## Phase 2: Write the handoff
Write the document to a file in the OS temp dir (`$TMPDIR` on macOS, `/tmp`
otherwise), e.g. `"$TMPDIR/handoff-<short-slug>.md"`. Report the path to the user.

Reference existing artifacts (PRDs, plans, ADRs, issue links, commit hashes,
diffs) by path or URL -- do not duplicate their content. Extract inline as you
write; do not emit a separate extraction step. Omit empty sections.

```
# Handoff: [brief title]

## Goal
[goal from $ARGUMENTS, with acceptance criteria]

## Context
[repo root, stack, the 2-4 files that matter most -- by path]

## State
**Working:** [what functions now]
**Broken:** [what doesn't, with error if known]
**Uncommitted:** [summary, or reference `git diff`]

## Done / Not done
- [x] [completed]
- [ ] [remaining]

## Failed approaches
[What was tried, why it failed, what replaced it. "None" if nothing failed.]

## Artifacts
[Plans/PRDs/ADRs/issues/commits/diffs by path or URL -- not copied here.]

## Suggested skills
[Skills the next session should invoke for this goal, e.g. /decompose,
/diagnose, /tdd -- with one line on why each applies.]

## Resume
1. [first action] -- Expected: [outcome]; if it fails: [what to check]
```

## Constraints
- NEVER write the handoff into the repo (no `.claude/handoff.md`) -- temp dir only
- NEVER duplicate artifact content that can be referenced by path or URL
- NEVER include secrets -- redact API keys, tokens, passwords, and PII
- NEVER spawn a continuation session or copy to the clipboard -- just write the file and report its path
