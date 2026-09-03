---
description: Hand off to the next unit of work through plan mode. Invoke it whenever one unit of work finishes and another one follows inside the same session, so the approved plan file replaces the transcript as the carried context -- and invoke it before drafting any handoff document by hand, because the template and the chainable flag live here.
argument-hint: "[goal for next session]"
---

## Goal

`$ARGUMENTS` is the goal for the next unit of work, and it is what this skill
serves. If empty, ask the user what the next task is before proceeding.

Everything below -- the state gathering, the template, the plan-mode dance -- is
only machinery for capturing the context that goal needs. Judge every line you
write by one test: does the next session need this to reach the goal? Carry what
passes, drop what does not, however complete the session's history feels.

## Phase 0: Read the incoming `Chainable` flag

Every handoff this skill writes carries a `Chainable:` field, and every handoff it reads honors the one already there. The flag answers one question: may the session that receives this document hand off again?

Check the active plan file first, before gathering any state:

- `Chainable: true` -- the receiving session may run this skill again at its own task boundary. This is the default, and an absent field reads as `true`.
- `Chainable: false` -- the receiving session runs the goal to completion in one thread and reports the result to the user. Skip this skill entirely, keep working through the task boundaries, and let the transcript grow.

Write `Chainable: false` when the next unit of work must run unattended across a long stretch -- an autonomous two-hour build, a migration sweep over hundreds of files, an overnight cron run -- because a handoff mid-stretch stops for an approval that nobody is sitting at, and the run dies there. Pair it with the reason on the same line, so the receiving session knows what it is protecting: `Chainable: false -- runs unattended for ~2h; no user at the approval prompt`.

Write `Chainable: true` for interactive work, where the user is present to approve the next plan and pick the context-clearing option.

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
`plan-mode-guard.py` enforces this: inside plan mode it denies `Read`, `Grep`,
`Glob`, `Bash` and every other lookup, leaving only the plan-file write,
`AskUserQuestion`, `ToolSearch` and `ExitPlanMode`. Anything you did not resolve
here is unresolvable there.

Load the two plan-mode tools here, while still outside plan mode:
`ToolSearch select:EnterPlanMode,ExitPlanMode`. Both are deferred, so leaving
this until Phase 3 puts a `ToolSearch` round-trip between the plan-file write and `ExitPlanMode`, which is where a context compaction lands. Measured over the 21 days ending 2026-09-03: 18 of 18 handoffs completed the full `EnterPlanMode` -> plan write -> `ExitPlanMode` -> successor sequence, and zero died.

That gap is recoverable, not fatal: when a compaction lands between the plan-file write and `ExitPlanMode`, re-run `ToolSearch select:ExitPlanMode` to reload the schema the compaction dropped, then call `ExitPlanMode` -- one session did exactly this and survived.

## Phase 3: Enter plan mode, paste, exit
The moment the document is complete, in the SAME turn, without pausing for the
user, run these three tool calls back to back with nothing in between:

1. Call `EnterPlanMode`.
2. Write the already-drafted document into the plan file verbatim -- no new
   research, no new tool calls beyond that write.
3. Call `ExitPlanMode` immediately.

The plan file lives in the ACTIVE profile's directory: `$CLAUDE_CONFIG_DIR/plans/`
when `ccc <profile>` set it, `~/.claude/plans/` otherwise. `plan-mode-guard.py`
auto-allows a write to either, so the write needs no prior `Read` and no
permission prompt.

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
- Use only the `##` sections the template lists -- fold anything else into the nearest template section rather than opening a new heading.
- `## Context` carries resolved environment facts (repo root, `owner/repo` from `git remote get-url origin`, verified full CLI invocations), because 11 of 18 successors re-derived them in their first 30 turns -- one retried a wrong GitHub org slug four times.
- Size budget: the whole handoff fits in ~100 lines / ~1-2k tokens; 3-5 sentences max per entry. Compression pressure drops prose, never the `Chainable:` line or the User constraints section -- both are copied verbatim regardless.

```
# Handoff: [brief title]

Chainable: [true | false -- when false, add the reason on this same line]

## Goal
[goal from $ARGUMENTS, with acceptance criteria]

## User constraints
[Verbatim quotes of user-stated constraints, preferences, and corrections from this session -- exact words, never paraphrased. "None" if none.]

## Context
[Resolved facts, never descriptions: the absolute repo root path; the `owner/repo` slug exactly as `git remote get-url origin` returned it, never guessed from the repo name; the stack; the exact CLI invocations this session already verified, in full command form (`gh pr list -R <owner>/<repo>`, `jira search '<jql>'`) and never a bare tool name; the 2-4 files that matter most, by absolute or repo-relative path.]

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

## Resume
1. [first action] -- Expected: [outcome]; if it fails: [what to check]
```

## Phase 4: Exit plan mode
Call `ExitPlanMode`. The approval dialog is the user's choice, not yours: the handoff relies on the user picking "clear context and use auto mode" so the old transcript is dropped and the next thread runs on just the handoff -- state that expectation to the user when presenting the plan.

## Constraints
- ALWAYS read the active plan file's `Chainable:` field before Phase 1, and finish the goal in one thread when it says `false`
- ALWAYS emit a `Chainable:` line in every handoff, directly under the title, with the reason attached whenever it is `false`
- ALWAYS treat `$ARGUMENTS` as the purpose and everything else as context capture
  serving it -- a section that does not move the next session toward that goal
  does not belong in the document
- ALWAYS finish drafting the full document before `EnterPlanMode` -- inside plan
  mode, write the plan file and exit, nothing else
- ALWAYS load `EnterPlanMode` and `ExitPlanMode` with one `ToolSearch` in Phase 2,
  so Phase 3 is three adjacent tool calls and no round-trip separates the plan
  write from `ExitPlanMode`
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
- NEVER add a `##` section the template does not list -- fold the content into the nearest template section instead; ad-hoc sections consumed 247 lines across 18 documents, the joint-largest of any section, and 5 of the 8 documents carrying one blew the size budget
- NEVER let compression pressure touch the `User constraints` section or the `Chainable:` line -- User constraints looks low-value on a lexical proxy (10 of 18 successors quoted it back) only because constraints get obeyed rather than quoted, so that number is a floor, not a signal to cut
