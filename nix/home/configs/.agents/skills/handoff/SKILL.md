---
description: Hand off to the next unit of work through plan mode.
disable-model-invocation: true
argument-hint: "[goal for next session]"
---

## Goal

`$ARGUMENTS` is the goal for the next unit of work. If empty, ask the user what
the next task is before proceeding.

## Phase 1: Gather state
Run before analyzing:

```bash
git status
git diff --stat
git log --oneline -5
```

## Phase 2: Enter plan mode
Call `EnterPlanMode` (load it with `ToolSearch` `select:EnterPlanMode,ExitPlanMode`
first if deferred). The plan file IS the handoff document -- it is the compressed
context that replaces this session's transcript.

## Phase 3: Write the handoff into the plan, then present it
Fill the plan file with the template below, then present it via `ExitPlanMode`.

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
[Skills the next session should invoke for this goal, e.g. /diagnose,
/tdd, /grill-me -- with one line on why each applies.]

## Resume
1. [first action] -- Expected: [outcome]; if it fails: [what to check]
```

## Constraints
- ALWAYS hand off through `EnterPlanMode` + `ExitPlanMode` -- the plan file is the
  only handoff surface
- NEVER write the handoff to any other file -- no `Write`/`Edit` to a temp path,
  `.claude/handoff.md`, or anywhere in the repo
- NEVER duplicate artifact content that can be referenced by path or URL
- NEVER include secrets -- redact API keys, tokens, passwords, and PII
- NEVER spawn a continuation session or copy to the clipboard -- the approved plan
  carries the work forward in this session
