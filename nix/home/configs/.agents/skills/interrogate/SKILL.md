---
name: interrogate
description: Adversarial multi-model review -- two or three adversaries from different vendors, each in its own worktree with the change copied in, try to break a change or design; a finding survives only when main reruns its command and the output shows the intent broken. Reports findings and applies no fixes.
when_to_use: When the user says "interrogate", "adversarial review", "multi-model review", "challenge this", "stress test this code", "find blind spots", or "tear this apart".
disable-model-invocation: true
---

# Interrogate

Adversaries try to break a change or a design, and only run-proven findings count. The output is a report; fixes stay with the user's next request. For a single-model review scored by confidence, use the `code-reviewer` agent instead.

## 1. Frame

The scope is what the user names; otherwise the branch diff from its merge base with the base branch through the working tree (`git diff $(git merge-base HEAD origin/<base>)`, untracked files included). Restate the intent in one paragraph from the user's message, the commit messages and the PR description, and ask the user when the intent stays unclear -- every finding is judged against it.

## 2. Fan out

Use phase 1 steps 3-4 and phase 2 of skill `arena` for seats and worktrees, with these changes:

- Seats must be able to run commands: a Claude worker (`Agent`, `isolation: "worktree"`) and `hetero-subagents:codex:gpt-6.1-sol`, optionally a second Claude or codex seat. The agy seats have no shell, so they sit out.
- Copy the scope's uncommitted changes into each worktree (`git diff HEAD | git -C <worktree> apply`, then copy untracked files).
- Give each adversary the scope, the intent, and this brief in place of the arena task:

> Break this change. Prove each finding with a run against the real code: a failing test, a repro script, or command output that shows the wrong behavior. For a design or plan, run a prototype or probe the current tree. Keep repros inside your own worktree. Report only what you ran, as a list of `{title: str, command: str, actual_output: str, required_output: str}`, where `required_output` is what the intent demands. Style, naming, structure and risks that need a future change to matter are out of scope. An empty list is a valid result.

## 3. Verify

Rerun every finding's command yourself. Keep a finding when the output shows the failure and that failure breaks the intent; drop the rest with a reason. Merge findings that share a root cause. Adversaries find different failures, so the verdict keeps every verified finding from every adversary rather than picking one adversary's list. Arena's judge, pick and graft phases do not apply.

## Output

- **Intent**: the restatement.
- **Findings**: per verified finding, the command, its output, how it breaks the intent, and the adversaries that found it; "no verified findings" when none survive.
- **Dropped**: per adversary, the count of dropped findings and why.

Then tear down the adversary worktrees per skill `worktree` section 7.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/interrogate`.*
