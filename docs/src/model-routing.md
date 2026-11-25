# Choosing a subagent by kind of work

Pick a subagent by the tools it can reach first, then by the numbers on its model card. Read this before changing the routing, to see why each model does each job. The model-card facts were read on 2026-11-25.

## Pick by tool reach first

- A codex worker uses its own shell and `apply_patch`, plus this session's read-only MCP tools relayed to it.
- A read-only type cannot edit files.
- An agy worker gets no Claude-side tools.
- Device UI driving, Artifacts and write MCP tools stay with Claude workers. The `agent-device` daemon does not start inside codex's seatbelt sandbox (observed 2026-11-25).

## Registered non-Claude models and their jobs

### codex `gpt-6.1-sol` medium: default implementer

Its card reports that it failed to disclose a broken search tool 2.1% of the time. `gpt-6.2-sol` costs the same, but the `gpt-6.2-sol` card says that model is "more likely to omit known obstacles when reporting their work".

### codex `gpt-6-luna` xhigh: cheapest bulk work

It costs $0.10 input and $0.50 output per MTok. Its card reports that it failed to disclose a broken tool 28.7% of the time, so it gets only units whose `Done when` check the caller reruns.

### codex `gpt-6.2-astra` high, read-only: cross-vendor reviewer

It reviews high-stakes diffs that a Claude worker wrote, so a model from another vendor checks them. It has a frontier model card and costs $8 input and $40 output per MTok.

### agy `gemini-4-neon` high, read-only: long-context reader and second security reviewer

It scores 95.2% on GraphWalks 256k-1M, against 66.8% for Opus 5.5. On WebExploitBench it scores 51.3, against 37.1 for Opus 5.5.

## Claude models and their jobs

- haiku does mechanical work.
- sonnet does scoped edits, UI and device driving, and web research that reads untrusted pages. The Sonnet 5.5 card reports a 0.4% prompt-injection attack success rate.
- opus does hard cross-cutting implementation and long-context coding. It scores 91.2 on ProgramBench.
- Fable is used only through the `oracle` agent.

## Models left unregistered, and why

- `gpt-5.6-sol`: its card notes a "greater tendency to go beyond user intent in agentic coding", and the GPT-6 Astra card cites a 48% scope-overreach rate for it.
- `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-sol` and `gpt-6-astra`: superseded, because the 6.x successors do the same job at about half the price.
- `gemini-3.8-flash`: it scores 19.1% on Terminal-bench 4.0.

Legacy models are allowed. Add one only together with a job where its card beats the current roster.

## Why agy is read-only

`decidePermission` in `daemon/acp-bridge.mjs` allowed every shell `execute` call. As a result an agy worker's shell commands ran outside any sandbox and bypassed every Claude `PreToolUse` guard (found 2026-11-25).

## The fixed cost of codex

A one-word `codex exec` reply used 24.7k-31.7k tokens (measured 2026-11-25). Codex therefore gets units that touch several files or take 10+ tool calls.

## Writing

Blind comparison pending (started 2026-11-25).

The comparison has Opus 5.5, `gpt-5.6-sol`, `gpt-6.1-sol`, `gemini-4-argon` and `gemini-4-hydrogen` each write a Korean PR body, a doc section and a Slack draft.

## Where the guidance lives

- When to pick each type: the `TYPES` blurbs in `nix/home/configs/claude/mods/hetero-subagents/hooks/register.ts`.
- The type list the main session sees: the hetero-subagents mod's prompt.compose section `hetero-subagents:routing`, generated from `TYPES`; subagents do not see it.
- Claude tier routing and the codex brief format: `nix/home/configs/claude/hooks/architect-rules.py`.
- Dated numbers: this doc.

Re-check the cards whenever a vendor ships a model. The promo prices for `gpt-5.6-sol` and `gemini-4-carbon` end on 2026-11-30.
