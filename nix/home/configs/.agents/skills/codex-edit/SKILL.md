---
name: codex-edit
description: >
  Use OpenAI Codex CLI (codex exec) to make code edits when execution accuracy
  matters more than exploration. Invoke this skill when a task is well-scoped
  but execution-heavy: renaming symbols across files, rolling out a new
  interface, generating tests across a module, adding uniform error handling,
  or any multi-file mechanical change. Also invoke when the user says "use
  codex", "delegate to codex", or when a previous Claude edit attempt was
  imprecise or missed files. Prefer this over inline editing whenever the
  change touches 3+ files with a consistent pattern.
---

# codex-edit

`codex exec` runs a separate agent loop that reads your repo, plans changes,
and executes them with its own tool calls. Use it when you have a clear goal
and want precise execution across multiple files rather than exploratory
back-and-forth.

## When to delegate vs edit inline

| Delegate to codex exec | Edit inline |
|---|---|
| 3+ files with consistent pattern | Single targeted fix |
| Cross-cutting rename / interface rollout | Exploratory, uncertain scope |
| Generate tests across a module | Needs iterative reasoning |
| Add logging / error handling uniformly | Quick one-liner change |
| Previous Claude attempt missed files | Active dialogue with user |

## Core invocation

```bash
# Standard one-shot edit
codex exec -s workspace-write "PROMPT"

# With extra context piped from stdin (appended as <stdin> block)
git diff HEAD | codex exec -s workspace-write "PROMPT"
cat error.log | codex exec -s workspace-write "Diagnose and fix the cause in src/"

# Heavier tasks — more capable model
codex exec -m gpt-4.1 -s workspace-write "PROMPT"

# Upgrade reasoning effort without switching model
codex exec -c "model_reasoning_effort=high" -s workspace-write "PROMPT"

# Save agent's final summary message
codex exec -s workspace-write "PROMPT" -o /tmp/codex-summary.txt

# No session persistence (clean throwaway run)
codex exec --ephemeral -s workspace-write "PROMPT"
```

## Prompt structure

Always include four parts — vague prompts cause codex to guess scope:

```
Goal: <what to change>
Context: <relevant files, error, or reproduction step>
Constraints: <do not touch X, no new deps, keep API surface>
Done when: <tests pass / build succeeds / specific behavior confirmed>
```

**Good:**
```
Goal: Add retry with exponential backoff to all fetch calls in src/api/.
Context: The pattern to replicate is retryWithBackoff() already used in src/api/users.ts.
Constraints: Do not change any function signatures. No new npm dependencies.
Done when: Every file in src/api/ uses retryWithBackoff() for network calls.
```

**Weak:** `"Add retries to API calls"` — codex will guess which files and which pattern.

## Context codex auto-loads

- **`AGENTS.md`** in the repo root — put project conventions, build/test commands, and protected paths here; codex reads it automatically every run
- Files codex discovers via its own tool calls while executing
- Anything piped to stdin (appended as `<stdin>` block)

If `AGENTS.md` doesn't exist and the project is non-trivial, describe the relevant structure briefly in the prompt itself.

## Sandbox

`workspace-write` (used above) is the right default — it restricts edits to the project directory and blocks network access. Only escalate when codex needs to install packages or call external APIs:

```bash
# workspace-write + network (e.g. for npm install during the run)
codex exec -s workspace-write \
  -c 'sandbox_permissions=["disk-full-read-access","network-full-access"]' \
  "PROMPT"
```

Never use `--dangerously-bypass-approvals-and-sandbox` on the host machine.

## Verification workflow

Always checkpoint first so you can revert cleanly:

```bash
# 1. Checkpoint
git add -A && git commit -m "checkpoint before codex"

# 2. Run
codex exec -s workspace-write "PROMPT"

# 3. Review
git diff HEAD

# 4. Stage selectively or revert
git add -p            # keep what looks good
git checkout .        # revert everything if wrong
```

## Claude + codex workflow

1. Claude reads the task and decides this is a good codex candidate (3+ files, clear pattern)
2. Claude writes a precise prompt using Goal/Context/Constraints/Done-when
3. Claude runs `codex exec` via Bash and waits for it to finish
4. Claude runs `git diff HEAD` and reports what changed
5. If the result is wrong, Claude refines the prompt and reruns — or falls back to inline editing after two failed attempts
