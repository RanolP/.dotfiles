---
name: codex-edit
description: >
  Use OpenAI Codex CLI (codex exec) as the DEFAULT implementer for non-trivial
  code changes — codex has the higher quota and is surgical at feature work.
  Invoke this skill for any well-scoped implementation: a new feature, renaming
  symbols across files, rolling out a new interface, generating tests across a
  module, adding uniform error handling, or any multi-file change. Also invoke
  when the user says "use codex", "delegate to codex", or when a previous Claude
  edit attempt was imprecise. Covers both directions of review: Claude reviews
  codex's diff for over-editing, and `codex exec review` reviews Claude's work.
  Prefer this over inline editing or a Claude implementer subagent whenever the
  scope is clear. Edit inline only for tiny one-liners or exploratory scope.
---

# codex-edit

`codex exec` runs a separate agent loop that reads your repo, plans changes,
and executes them with its own tool calls. Use it when you have a clear goal
and want precise execution across multiple files rather than exploratory
back-and-forth.

## When to delegate vs edit inline

codex is the default implementer — reach for it whenever the scope is clear,
not only for multi-file changes. Prefer it over spawning a Claude implementer
subagent (codex has the higher quota).

| Delegate to codex exec | Edit inline |
|---|---|
| A new, well-scoped feature | Single targeted fix / one-liner |
| 3+ files with consistent pattern | Exploratory, uncertain scope |
| Cross-cutting rename / interface rollout | Needs iterative reasoning |
| Generate tests across a module | Active dialogue with user |
| Add logging / error handling uniformly | Previous codex diff is being reviewed |

## Core invocation

```bash
# Standard one-shot edit
codex exec -s workspace-write "PROMPT"

# With extra context piped from stdin (appended as <stdin> block)
git diff HEAD | codex exec -s workspace-write "PROMPT"
cat error.log | codex exec -s workspace-write "Diagnose and fix the cause in src/"

# Model and reasoning effort come from ~/.codex/config.toml (gpt-5.5 at xhigh)
# for substantive implementation — you rarely override.

# Fast tier: for mechanical/quick coding tasks (fmt, lint, rename, tiny edits)
# prefer codex-spark — an ultra-fast coding model, the much-faster alternative
# to a haiku subagent. Reach for this instead of downgrading effort:
codex exec -m gpt-5.3-codex-spark -s workspace-write "PROMPT"

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
Constraints: <touch ONLY these paths; no adjacent refactors; no new deps; keep API surface>
Done when: <tests pass / build succeeds / specific behavior confirmed>
```

codex's main failure mode is over-editing — refactoring code it wasn't asked
to touch. Counter it in Constraints: name the exact files/paths it may modify
and explicitly forbid touching anything else. Then verify in the review step.

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

## Cross-review — both directions

The two agents check each other. Neither ships an unreviewed diff.

### Claude reviews codex's work (default path)

1. Claude decides this is a codex candidate and writes a precise prompt
2. Checkpoint-commit, then run `codex exec -s workspace-write`
3. `git diff HEAD` — read every hunk, specifically hunting codex's over-editing:
   changes outside the named paths, unrequested refactors, drive-by renames
4. Revert scope creep (`git checkout -- <path>` / `git add -p` to keep only the
   in-scope hunks); keep only what the Goal asked for
5. If the core change is wrong, refine the prompt and rerun — fall back to inline
   editing after two failed attempts

### codex reviews Claude's work (the vice-versa)

After Claude implements something non-trivial itself, get codex's second pair of
eyes before finishing:

```bash
# Review the working-tree changes Claude just made
codex exec review --uncommitted

# Or review against a base branch / a specific commit
codex exec review --base main
codex exec review --commit HEAD
```

Address codex's findings, or note why a finding is a deliberate choice. This is
the counterpart to Claude reviewing codex — every change gets a review from the
agent that did not write it.
