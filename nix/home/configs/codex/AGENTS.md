# Codex-Specific Rules

These rules supplement the shared `AGENTS.md` loaded into Codex.

## Delegation is this user's standing instruction

- WHEN: a unit can be carried by an independent worker, or a command may run long or emit long output.
- DO: delegate the unit proactively without asking again; this user asked Codex to spawn `luna xhigh` workers aggressively.
- DO: choose the named native role that matches the unit, and keep the worker's brief self-contained with its goal, files, constraints, and return shape.
- DO: set every child to `model = "gpt-5.6-luna"` and `model_reasoning_effort = "xhigh"`; `gpt-5.6-luna` is the installed model slug for the user's `luna` request.

## Parallel work and typed handoffs

- WHEN: multiple units have no unmet dependency.
- DO: state the complete set, launch them together, and report each settled result as soon as it is available.
- WHEN: a worker's result feeds another worker or a synthesis step.
- DO: declare the exact JSON or YAML fields and types in the brief, require that shape alone, validate it on receipt, and request one re-emission when it does not match.
- DO: keep destructive commands in the foreground and review the resulting diff before finishing.

## Native role directory

- DO: keep reusable Codex roles in `~/.codex/agents/*.toml`, with one file per role and a non-empty `developer_instructions` value.
- DO: use `code-reviewer` for implementation review, `prose-editor` for outside-facing prose, and `oracle` for one bounded high-stakes judgment question.
