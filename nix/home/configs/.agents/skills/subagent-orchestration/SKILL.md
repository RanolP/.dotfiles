---
name: subagent-orchestration
description: Route a subagent spawn to the right model tier, write a self-contained brief, and hand a worker's result to the next step as a typed shape instead of prose. Use when spawning any subagent, delegating a task, fanning out parallel workers, or consuming a worker's result. The `orchestration-guard` PreToolUse hook injects this skill in full at the first Agent/Task call of a session.
---

# Subagent orchestration

The decision of **whether** to spawn lives in `CLAUDE.md` under `## Orchestrate via subagents` -- the lazy default, the context economics, and the bar a spawn must clear. This skill covers everything that happens once that decision is already yes.

## The brief is the worker's whole world

A subagent sees none of this thread. Whatever the brief omits, the worker invents.

Every brief carries four things:

1. **The goal**, stated as the outcome wanted rather than the steps to take.
2. **The files**, as repo-relative paths the worker can open directly.
3. **The return shape** -- see the typed-handoff rules below when the result feeds a next step.
4. **The constraints** that are not discoverable from the code: the convention to match, the approach already rejected, the thing not to touch.

Never point a brief at this conversation. "As we discussed", "the file from before", and "the plan above" all resolve to nothing in a fresh worker's context.

## Model tiers

`subagent-model-guard.py` denies any `Agent`/`Task` call that omits `model`, because an omitted `model` means `inherit` and silently spends the main thread's tier on the worker. Choose deliberately:

| Tier | Use it for |
|---|---|
| `haiku` | Mechanical search and read work -- greps, file reads, pattern matching, data collection, Slack and web crawls. No judgment required. |
| `sonnet` | The default. Anything needing reasoning: research, review, design, debugging. Also the implementer for well-scoped code changes. |
| `opus` | Only from a Fable main thread, where the main thread is not the reasoning tier. From an Opus main thread, hard reasoning belongs in the main thread itself. |
| Fable | Only through the pinned `oracle` agent, with no `model` param. |

The guard hard-denies an explicit `model: fable` and denies anything above `sonnet` from a non-Fable main thread. Its deny reason restates the rubric, so a mis-tiered call costs one round-trip.

### `fork` costs more than it looks

`fork` inherits the parent model at full parent context cost -- the whole conversation is re-sent. Prefer a fresh `sonnet` spawn with a self-contained brief. Reach for `fork` only when the worker genuinely needs this thread's accumulated context and no brief can reconstruct it.

### The `oracle` agent

Pass exactly one `question` plus enough `context` to judge it. It answers; it does not edit files, run tools, or take open-ended work.

When `oracle` returns a `suggest_more` other than `none`, tell the user what further context or action it suggested before continuing. That suggestion is the oracle saying its answer is incomplete, and swallowing it wastes the escalation.

## Typed handoffs

A worker's result is either **terminal** (you read it yourself and act) or a **handoff** (it feeds another agent, a routing decision, or a synthesis pass).

Prose is fine for a terminal result. A handoff needs a declared shape.

### Declaring the shape

Name the exact fields and their types in the brief, or paste a fenced schema block, and require the worker to return **only** that shape with no prose wrapper:

```json
{
  "verdict": "pass" | "fail",
  "findings": [{ "file": "string", "line": "number", "claim": "string" }]
}
```

For `Workflow` agents, pass the `schema:` option instead. Validation then happens at the tool layer and the worker retries on a mismatch, rather than you parsing an essay after the fact.

### Validating on receipt

Check the shape before using it. On a mismatch, `SendMessage` the same agent once and ask it to re-emit in shape -- its context is still intact, which makes this cheaper than respawning. Then parse whatever came back.

### Accumulate results, not narration

The point of a typed handoff is that the main thread holds a small structured record instead of a growing pile of worker prose. Chaining free-form prose between subagents and regexing the fields back out defeats the whole arrangement.

### A checker is a separate node

Most handoffs need no checker. When one is warranted, it is its own agent with its own typed verdict. The maker never grades its own handoff.
