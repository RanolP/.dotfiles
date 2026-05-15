Prepare a handoff prompt for a new Claude Code session.

## Goal

The argument passed to this command is the goal for the next session: $ARGUMENTS

If no argument is provided, ask the user what the next task is before proceeding.

## Phase 1: Gather State

Run these commands before analyzing anything:

```bash
git status
git diff --stat
git log --oneline -5
```

## Phase 2: Extract from Conversation

Pull out:
- Original task and current goal
- Every file read, created, or modified (with paths)
- Key decisions and rationale
- **What was tried and abandoned** -- critical; saves hours in the next session
- Errors encountered and how resolved
- Uncommitted changes summary
- Any blockers or open questions

## Phase 3: Generate Handoff Document

Produce a single fenced code block containing the following. Omit empty sections -- except **Failed Approaches** (write "None" if truly nothing failed).

```
# Handoff: [brief title]

## Context
[repo root, stack, relevant files]

## Completed
- [x] [specific item]

## Not Yet Done
- [ ] [remaining task]

## Failed Approaches (Do Not Repeat)
[What was tried, why it failed, what replaced it. Be specific -- include error messages verbatim if relevant.]

## Key Decisions
| Decision | Rationale |
|----------|-----------|
| [choice] | [why] |

## Current State
**Working:** [what functions now]
**Broken:** [what doesn't, with error if known]
**Uncommitted changes:** [summary]

## Files to Know
| File | Why it matters |
|------|----------------|
| `path/to/file` | [description] |

## Resume Instructions
[Step-by-step. Each step must include expected outcome and what to check if it fails.]

1. [action]
   - Expected: [outcome]
   - If it fails: [what to check]

## Your Task
[goal from $ARGUMENTS, stated precisely with acceptance criteria]
```

## Phase 4: Save and Continue

1. Save to `.claude/handoff.md` in the repo root (create `.claude/` if needed).
2. Copy to clipboard: `pbcopy < .claude/handoff.md`
3. Spawn continuation session:
   ```bash
   zellij run -n "Claude Continue" -- bash -c "cd '$PWD' && $(which claude) '$PWD/.claude/handoff.md'"
   ```
   - Must use `$(which claude)` -- the `claude` alias is not available in new shell environments.
   - Do NOT add `-c` -- it causes the pane to close immediately when Claude exits.
4. If the spawn fails (not inside Zellij, or `$ZELLIJ` is unset):
   - Report the error clearly.
   - Tell the user: "Run manually: `claude .claude/handoff.md`"
5. Close this pane (only if inside Zellij and the spawn succeeded):
   ```bash
   zellij action close-pane
   ```
