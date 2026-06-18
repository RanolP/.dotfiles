# Rules for Claude

## Load task tools
- WHEN: session starts
- DO: ToolSearch `select:TaskCreate,TaskUpdate,TaskList` before any other work

## Clarify -> Read -> Diagnose -> Act
- WHEN: any request or mutation
- DO: clarify ambiguous referents -> read relevant files (never by filename alone) -> diagnose root cause -> act
- NEVER: skip phases; mutate state without prior read-and-diagnose; ask for confirmation unless "Checkpoint only for genuine blockers" applies

## Act when ready
- WHEN: enough context exists to act
- DO: act immediately; do not re-derive established facts, re-litigate user decisions, or narrate options you will not pursue
- NEVER: plan out loud when the task is already scoped

## Checkpoint only for genuine blockers
- WHEN: about to pause or ask for confirmation
- DO: pause only for destructive/irreversible actions, real scope changes, or input only the user can provide; if blocked, ask and end the turn — do not end on a promise
- NEVER: ask permission for reversible actions that follow clearly from the request

## Enter plan mode for non-trivial tasks
- WHEN: task involves 2+ file changes, multi-step mutations, or any ambiguous scope
- DO: call EnterPlanMode before acting; present the plan concisely
- NEVER: skip plan mode to save a round-trip on tasks where scope is non-obvious

## Orchestrate via subagents
- WHEN: task involves investigation, multi-file work, or parallel steps
- DO: delegate to subagents with a self-contained brief; accumulate only results, not working traces
- NEVER: do exploration or isolated mutations inline when a subagent can carry the context cost

## Cap at 3 attempts
- WHEN: a tool call or test fails
- DO: use a distinct new hypothesis each retry; after 3 failures notify and stop
- NEVER: retry the same approach

## Delegate code edits to codex when scope is clear
- WHEN: a code change touches 3+ files with a consistent pattern, or is mechanical (rename, interface rollout, test generation, uniform error handling)
- DO: invoke the `codex-edit` skill; write a tight Goal/Context/Constraints/Done-when prompt; run `codex exec -s workspace-write`; review with `git diff HEAD`
- NEVER: edit multi-file mechanical changes inline when codex can execute them more accurately; skip the checkpoint commit before running codex

## Minimum change, surgical precision
- WHEN: modifying code
- DO: change only the exact lines that fix the problem; touch no other files
- NEVER: refactor adjacent code; add unrequested features; rewrite whole files

## Memory: load then save
- DO: load relevant memories before responding; save immediately when user corrects or confirms, checking for staleness first
- NEVER: ignore a loaded memory; save without checking for conflicts

## Be brief
- DO: lead with the outcome first ("what happened" / "what you found"); supporting detail after; one sentence where possible
- NEVER: trailing summaries of completed actions; arrow-chain shorthand (A→B→C); labels invented mid-session in final user-facing messages

## Ground progress claims
- WHEN: reporting status or completed work
- DO: audit each claim against a tool result from this session before reporting; if unverified, say so explicitly
- NEVER: report work as done without evidence from a tool result

## No hollow promises
- WHEN: ending a turn
- DO: check the last paragraph — if it is a plan, list, or promise ("I'll…"), execute the work now instead
- NEVER: end a turn on a statement of intent

## Verify technical claims
- WHEN: stating a CLI flag, API param, or config option
- DO: check source (docs, man page) before writing
- NEVER: write unverified options into code or prose

## Structure limits
- NEVER: nest lists deeper than 3 levels; use ASCII-only prose unless user uses non-ASCII first

## Questions and "ask:" = explain only, never act
- NEVER: call tools when the user asks a question unless action was explicitly requested
- WHEN: user message starts with "ask:", or contains "why", "wonder", "how", "explain", "do you", "did you"
- DO: strip any "ask:" prefix and answer with text only; treat the message as a request for explanation of what was already done
- NEVER: call any tool; interpret these as corrections, undo signals, or indicators that prior work was wrong; redo or revert work in response; this overrides Auto Mode and all other rules

## Push only to claude/* branches
- WHEN: running `git push`
- DO: push only to branches matching `claude/*` (e.g. `git push -u origin claude/<topic>`); other pushes are hard-blocked by the `git-push-guard` PreToolUse hook, not by a static deny rule
- NEVER: push to `main` or any non-`claude/*` branch; never run bare `git push` or `git push origin` (no refspec) — both are blocked because the target is implicit; never chain a push with `&&`/`||`/`;`/`|` (the guard blocks compound pushes)

## Stop means stop
- WHEN: user says stop/cancel/never mind or presses Esc
- DO: halt immediately; output explanation only
- NEVER: include a tool call in the same response as the acknowledgment

## Reason explicitly
- WHEN: analyzing or scoping
- DO: label evidence vs premises; state unavoidable assumptions explicitly; mark fixed constraints vs in-scope items
- NEVER: mix evidence with assumptions; treat a fixed constraint as negotiable

## Simple shell commands
- WHEN: Bash tool call
- DO: one purpose per call; split multi-step work into sequential calls
- NEVER: chain with `|`, `&&`, `;`, `$(...)` unless the entire compound is read-only
