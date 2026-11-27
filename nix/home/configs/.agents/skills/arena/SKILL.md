---
name: arena
description: Run N rival candidates from mixed model vendors at the same task in separate worktrees, have a read-only judge from another vendor score them against a hidden rubric, pick a base, graft the strongest parts of the losers into it by hand, then verify the result. Use for "arena", "arena this", "throw it in the arena", or when one attempt at a non-trivial, expensive-to-reverse design or artifact would lock in the wrong shape.
disable-model-invocation: true
---

# Arena

Rival attempts at one task, compared on a rubric. This differs from skill `worktree` section 6 (parallel worktree workflow), which splits different units across workers. State the six phases (Frame, Fan out, Cross-judge, Pick, Graft, Verify) in the reply before launching anything.

## 1. Frame

Every candidate gets the identical brief, so the brief is the contract.

1. Name the artifact each candidate produces (a module, a design doc, a schema, a prompt) and its Done-when command.
2. Write the rubric: 3-6 concrete, gradeable criteria for success on *this* task. It is the picker's tool in phase 4; it stays out of the candidates' brief, which carries only the task.
3. Choose the runners from different model families, at least two, by default three:
   - a Claude worker (`Agent`, `isolation: "worktree"`),
   - `hetero-subagents:codex:gpt-6.1-sol` (workspace-write; it stages, main commits),
   - for a text artifact (design, plan, prompt), `hetero-subagents:agy:gemini-4-argon-high`, which is read-only and returns the artifact in its reply for main to save.

   Add seats for more design directions. Repeat one model only when the work is generation-bound (many similar variants) rather than judgment-sensitive. When a seat cannot spawn, drop it, keep at least two, and say so. When the user already has a design, it is one of the candidates.
4. Give each candidate its own output location: a git worktree where the task edits code (`git worktree add --detach <scratchpad>/arena-<slug>/candidate-<n>` in a repo whose rules forbid new branches), otherwise `<scratchpad>/arena-<slug>/candidate-<n>/`. Candidates never share a path.

## 2. Fan out

Spawn every candidate in one message, in the background. Each brief carries the task, the path to the shared grounding (files, constraints, the user's words), its own output path, and this typed result:

```
{artifact_path: str, rationale: str, rejected_alternatives: [{option: str, why_rejected: str}]}
```

When a candidate returns nothing, continue with N-1 and record the dropout.

## 3. Cross-judge

Once all candidates are in, spawn one read-only judge from a vendor other than this session's (Claude, Fable included): `hetero-subagents:codex:gpt-6.2-astra`, or `hetero-subagents:agy:gemini-4-neon-high` when the candidates exceed its context comfortably. Give it the rubric and the candidate paths under neutral labels (A, B, C), never the runner names. It returns, per label, a score on each criterion with a one-line reason, plus the base it recommends. When no other-vendor judge can run, skip this phase and say so in the note.

## 4. Pick a base

While the judge works, read every candidate end to end. Score each against the rubric criterion by criterion, then compare with the judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous: read both rationales before deciding, and sharpen the criterion that split you.

Pick the base a future maintainer can extend most easily without breaking its invariants; on a tie, take the cleaner boundary or the smaller API.

## 5. Graft

Walk each losing candidate once more for what is worth porting -- usually one or two things per candidate. List each graft with its source label, then rewrite it in the base's idiom by hand, so the result reads as one design under one mental model.

- Candidates that converge on one shape are strong agreement: note it and ship the consensus shape with no grafts.
- Candidates that diverge wildly mean the frame was under-specified: return to phase 1, sharpen the task, and rerun, rather than averaging incompatible designs.

## 6. Verify

Run the Done-when command on the synthesized artifact (the runtime check `AGENTS.md` ## Verification requires). Route a failure by its cause: a wrong frame goes back to phase 1 and a rerun; a problem one candidate had already caught is a missed graft and goes back to phase 5. Fix it at that phase, so the synthesis note stays true.

## Reply

One synthesized artifact plus a short synthesis note: the base and why; the judge's per-criterion verdict, or that the judge was skipped and why; each graft with its source candidate; what was rejected and why; any convergence or dropouts; the verification command and its result. Then tear down the candidate worktrees per skill `worktree` section 7.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/arena` and the `/arena` section of `docs/guide/04-design.md`.*
