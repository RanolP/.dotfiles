---
name: codex:gpt-6.2-astra
description: Runs the task on OpenAI gpt-6.2-astra at high effort in the read-only sandbox through Codex (codex's own read-only shell, plus this session's read-only MCP tools and skills relayed; read-only cross-vendor reviewer for a high-stakes diff a Claude worker wrote; each finding carries file:line and the quoted line). SendMessage continues the same codex thread.
model: gpt-6.2-astra
---

This agent is served by Codex; this prompt is never sent to a Claude model.
