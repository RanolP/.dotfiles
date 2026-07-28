---
description: Hand off to the next unit of work through plan mode.
disable-model-invocation: true
argument-hint: "[goal for next session]"
---

## Goal

`$ARGUMENTS` is the goal for the next unit of work, and it is what this skill
serves. If empty, ask the user what the next task is before proceeding.

Everything below -- the state gathering, the template, the plan-mode dance -- is
only machinery for capturing the context that goal needs. Judge every line you
write by one test: does the next session need this to reach the goal? Carry what
passes, drop what does not, however complete the session's history feels.

## Phase 1: Gather state
Run before analyzing, then keep only what bears on the goal:

```bash
git status
git diff --stat
git log --oneline -5
```

## Phase 2: Draft the whole handoff BEFORE plan mode
Stay in normal mode. Finish every lookup the GOAL needs here -- read the files,
resolve the paths, confirm the commit hashes, check what still fails. Then compose
the FULL document from the template below in your head -- complete enough to paste
as-is. Keep it in this turn's reasoning only: no file, no message to the user, no
stopping. A drafted handoff that is not immediately consumed by plan mode is a
failed handoff.

Plan mode is not a research phase in this skill; it is only the surface that
carries the finished document forward with a cleared context. Entering it before
the document is written wastes the very context reset it exists for.

## Phase 3: Enter plan mode, paste, exit
The moment the document is complete, in the SAME turn, without pausing for the
user:

1. Call `EnterPlanMode` (load it with `ToolSearch`
   `select:EnterPlanMode,ExitPlanMode` first if deferred).
2. Write the already-drafted document into the plan file verbatim -- no new
   research, no new tool calls beyond that write.
3. Call `ExitPlanMode` immediately.

At the approval prompt, the intended choice is the context-clearing one: the plan
file is the compressed context that replaces this session's transcript.

## Template
The goal leads; every other section exists to support it. Reference existing
artifacts (PRDs, plans, ADRs, issue links, commit hashes, diffs) by path or URL
-- do not duplicate their content. Extract inline as you write; do not emit a
separate extraction step. Omit sections that are empty or that the goal does not
depend on.

Writing rules:
- Short isolated bullets, no narrative prose -- a coherent narrative is what hides facts from a fresh thread's attention.
- Before finalizing, re-scan the tail of the session for late user corrections and fold them into User constraints / Decisions -- recent context is what default summarization compresses hardest.
- Size budget: the whole handoff fits in ~100 lines / ~1-2k tokens; 3-5 sentences max per entry. Compression pressure drops prose, never the User constraints section -- it is copied verbatim regardless.

```
# Handoff: [brief title]

## Goal
[goal from $ARGUMENTS, with acceptance criteria]

## User constraints
[Verbatim quotes of user-stated constraints, preferences, and corrections from this session -- exact words, never paraphrased. "None" if none.]

## Context
[repo root, stack, the 2-4 files that matter most -- by path]

## State
**Anchor:** [branch @ short-SHA, dirty/clean, pushed/unpushed]
**Working:** [what functions now -- and HOW verified (test/command run)]
**Untested:** [changes made but never exercised]
**Broken:** [what doesn't, with error if known]
**Uncommitted:** [summary, or reference `git diff`]

## Done / Not done
- [x] [completed]
- [ ] [remaining]

## Decisions
- [decision] -- rejected: [alternatives]; why: [reason, one line]

## Failed approaches
[What was tried, why it failed, what replaced it. "None" if nothing failed.]

## Open questions
[Pending decisions awaiting user input.]

## Artifacts
[Plans/PRDs/ADRs/issues/commits/diffs by path or URL -- not copied here.]

## Suggested skills
[Skills the next session should invoke for this goal, e.g. /diagnose,
/tdd, /grill-me -- with one line on why each applies.]

## Resume
1. [first action] -- Expected: [outcome]; if it fails: [what to check]
```

## Phase 4: Exit plan mode
Call `ExitPlanMode`. The approval dialog is the user's choice, not yours: the handoff relies on the user picking "clear context and use auto mode" so the old transcript is dropped and the next thread runs on just the handoff -- state that expectation to the user when presenting the plan.

## Constraints
- ALWAYS treat `$ARGUMENTS` as the purpose and everything else as context capture
  serving it -- a section that does not move the next session toward that goal
  does not belong in the document
- ALWAYS finish drafting the full document before `EnterPlanMode` -- inside plan
  mode, write the plan file and exit, nothing else
- ALWAYS consume the draft with `EnterPlanMode` in the same turn it is written --
  ending the turn with the handoff sitting in a file or a chat message is a failure
- ALWAYS hand off through `EnterPlanMode` + `ExitPlanMode` -- the plan file is the
  only handoff surface
- NEVER write the handoff to any other file -- no `Write`/`Edit` to a temp path,
  `.claude/handoff.md`, or anywhere in the repo
- NEVER duplicate artifact content that can be referenced by path or URL
- NEVER include secrets -- redact API keys, tokens, passwords, and PII
- NEVER spawn a continuation session or copy to the clipboard -- the approved plan
  carries the work forward in this session
- NEVER hand off a summary of the transcript -- extract only the resume-critical state and the next goal; the point is a focused thread, not a lossy digest
- NEVER paraphrase user-stated constraints -- quote them verbatim in User constraints
