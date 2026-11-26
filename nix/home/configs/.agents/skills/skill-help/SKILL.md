---
name: skill-help
description: Answer "which skill do I use for X", "is there a skill that...", or "what can you do here" by naming the one local skill that fits and one prompt to start it, without starting the work. Use for /skill-help and for routing questions about the skill set.
disable-model-invocation: true
---

# skill-help

A routing question gets a pointer, not a run: a run spends tokens and changes state the user only asked about. Answer with the one skill that fits, why it fits over its nearest neighbour, and one example prompt the user can send. When the need could map to more than one skill, ask one multiple-choice question whose options are the candidate skills, each with the one-line difference.

Read the candidates' `SKILL.md` before answering, so the pointer rests on the skill's body rather than its name.

## Close calls

| Need | Skill | Its neighbour, and the difference |
|---|---|---|
| A mistake the user corrected twice | `correct` | `rule-write` lands one rule; `correct` picks a guard above prose first |
| One durable instruction into the rules | `rule-write` | `dotfiles:evolve` starts from a saved memory and deletes it after |
| Which memories belong in the rules | `memory-review` | ranks only; `dotfiles:evolve` performs the move |
| Stress-test a plan by questioning | `grill-me` | `prototype` settles the keys an experiment can; `interrogate` attacks a built change |
| Pick among designs by running them | `prototype` | `arena` runs rival full implementations and a judge |
| Check a state model's transitions | `quint-verify` | `prototype` Branch A lets the user drive it by hand |
| How code works now | `how` | `zoom-out` maps modules; `why` reads the history |
| Why code is this way | `why` | `how` explains the runtime |
| Understand something deeply | `teach` | `socratic-tutor` quizzes to mastery |
| Expert terms for what is being built | `reframe` | `sharpen` rewrites the task prompt itself |
| A bug or slowdown | `diagnose` | `tdd` when the fix goes test-first |
| Restructure without changing behavior | `refactor` | `remove-dead-code` is its subtraction step |
| Commit and push finished work | `ship` | `git-master` for branching, rebasing, history |
| Stop now, continue later | `pause-resume` | `want-exit` closes the session out for good |
| What happened while away | `ketchup` | `pause-resume` rebuilds older work from the record |
| A picture that explains | `visual-explainer` | `website-explainer` builds a slide site; `teardown` draws physical objects |
