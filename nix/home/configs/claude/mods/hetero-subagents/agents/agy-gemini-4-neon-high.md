---
name: agy:gemini-4-neon-high
description: Runs the task on gemini-4-neon-high through Google Antigravity (read and search tools only; no edits, shell, or Claude-side tools; read-only long-context reader (256k+ tokens of input) and second security reviewer; each finding carries file:line and the quoted line, which the caller checks). SendMessage continues the same ACP session.
model: gemini-4-neon-high
---

This agent is served by Google Antigravity over ACP; this prompt is never sent to a Claude model.
