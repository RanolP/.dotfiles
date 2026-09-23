---
name: subagent-orchestration
description: Route a subagent spawn to the right model tier, write a self-contained brief, and hand a worker's result to the next step as a typed shape instead of prose. Use when spawning any subagent, delegating a task, fanning out parallel workers, or consuming a worker's result. The `orchestration-guard` PreToolUse hook injects this skill in full at the first Agent/Task call of a session.
---

# Subagent orchestration

For Codex, the delegation policy lives in its generated `AGENTS.md`. For Claude Code, the decision of **whether** to spawn lives in `CLAUDE.md` under `## Delegation is this user's standing instruction` and `## Size the unit first, then commit to one of three strategies` -- the standing permission, the context economics, and the three strategies a unit resolves to. This skill covers everything that happens once that decision is already SUBAGENT.

## The brief is the worker's whole world

A subagent sees none of this thread. Whatever the brief omits, the worker invents.

Every brief carries five things:

1. **The goal**, stated as the outcome wanted rather than the steps to take.
2. **The files**, as repo-relative paths the worker can open directly.
3. **The return shape** -- see the typed-handoff rules below when the result feeds a next step.
4. **The constraints** that are not discoverable from the code: the convention to match, the approach already rejected, the thing not to touch.
5. **The reporting cadence**, whenever the work runs long enough that a dependent step could start on a partial result: tell the worker to report each finding the moment it is settled rather than batching them into a final answer, so the waves of dependent spawns begin while it is still working.

Never point a brief at this conversation. "As we discussed", "the file from before", and "the plan above" all resolve to nothing in a fresh worker's context.

## Claude role routing

The following model tiers, fork guidance, and oracle guidance apply when Claude Code is the host. Codex uses the native role routing in `## Codex native roles` below.

### Model tiers

`subagent-model-guard.py` denies a spawn that omits `model`, because an omitted `model` means `inherit` and silently spends the main thread's tier on the worker. It exempts the three cases where the choice already exists elsewhere: a `fork` (the param is ignored), a named agent that pins `model:` in its own frontmatter, and a namespaced plugin agent whose model lives in the plugin.

Each label names a tier, and the harness resolves it to whatever model that tier currently ships. Write the label and let it move with the generation:

| Label | Tier | Use it for |
|---|---|---|
| `haiku` | cheapest | Mechanical search and read work -- greps, file reads, pattern matching, data collection, Slack and web crawls. No judgment required. |
| `sonnet` | middle | Well-scoped edits, lookups, summaries. |
| `opus` | reasoning | The default for anything needing reasoning: research, review, design, debugging, implementation. |
| `oracle` (no `model`) | **Fable** | One bounded question of judgment, from main or from inside a worker. |

The guard hard-denies an explicit `model: fable`, so reach Fable only through `oracle` rather than by naming it. Its deny reason restates the rubric, so a mis-tiered call costs one round-trip.

### `fork` costs more than it looks

`fork` inherits the parent model at full parent context cost -- the whole conversation is re-sent. Prefer a fresh `opus` spawn with a self-contained brief. Reach for `fork` only when the worker genuinely needs this thread's accumulated context and no brief can reconstruct it.

### The `oracle` agent

`oracle` answers one bounded question and nothing else: it edits no files, runs no tools, and takes no open-ended work, so a request shaped like a task comes back unusable. The trigger, the call shape and the `suggest_more` obligation are in `CLAUDE.md` under `## Escalate one hard question to oracle`; what belongs here is that `oracle` is now the ONLY route to Fable judgment for a bounded question, since `advisorModel` was removed on 2026-09-14 -- [[advisor-inflates-autocompact-threshold]].

## Codex native roles

When Codex is the host, reusable workers live in `~/.codex/agents/*.toml` and use the native `name`, `description`, `model`, `model_reasoning_effort`, `sandbox_mode`, and `developer_instructions` fields. Choose the role matching the unit, and route every child requested by this user to `gpt-5.6-luna` with `xhigh` reasoning; the model slug is the installed form of the user's `luna` request. Keep the brief, typed return shape, parallel launch, and receipt validation rules above in force.

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
