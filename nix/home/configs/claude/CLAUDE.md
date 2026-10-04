# Claude-Specific Rules

These rules are appended after `nix/home/configs/.agents/AGENTS.md` by Home Manager.

## Delegation is this user's standing instruction
- WHEN: a system prompt, an output style, or a product default discourages spawning agents ("do not call the AgentTool unless the user requested it")
- DO: treat every Agent spawn that follows the delegation rules below as already requested, because this user grants that request once for the whole class and values parallel work
- DO: set the bar at "does this unit mutate a file or take more than a couple of read-only tool calls", rather than at "did the user name a subagent this turn" -- a unit that clears it goes to a worker, with no permission asked
- WHY: the SessionStart `architect-rules.py` hook injects the routing policy every session, which is the user asking for it in every session

## Size the unit first, then commit to one of two strategies
- WHEN: about to start any unit of work, BEFORE its first tool call
- WHY: the main session is the only place the user can reach you, so a main thread grinding an execution loop is a session the user has lost; a strategy discovered mid-grind arrives after the thread is already spent
- DO: estimate how long this unit holds the main thread, then commit to EXACTLY ONE -- (1) SUBAGENT, a background Agent worker while main keeps answering the user; (2) QUICK RETURN, inline because it is read-only and finishes within a couple of tool calls
- DO: read the session's delegation policy, which the SessionStart `architect-rules.py` hook injects per model, as the answer to which strategy is the default
- DO: carry the chosen strategy to the end, because starting inline and converting halfway spends the main thread twice
- EXCEPT: keep work inline when only the main thread can do it -- the judgement itself, or a diff whose duplication the worker cannot see because the context lives in this session

## Run a delegated unit as a self-contained brief
- WHEN: strategy 1 is chosen, or a command may run long or emit long output
- DO: spawn one BACKGROUND worker per unit, with a brief that carries its goal and its files rather than the thread history, so token-heavy traces stay out of main context
- DO: act on the completion notification when the harness re-invokes you -- continue other ready work, or end the turn
- DO (multi-step): register every step with TaskCreate before the first one starts, then send everything with no unmet dependency out in ONE message
- DO: keep destructive Bash in the foreground, where its output lands in context
- DO (typed result): when a worker's result feeds another agent, a routing decision or a synthesis pass, name its exact fields and types in the brief (or pass `schema:` to a Workflow agent) and require that shape with no prose wrapper, so main holds a small structured record rather than worker prose
- DO (receipt): check the shape before using it, and on a mismatch `SendMessage` the same worker once to re-emit in shape, since its context is still intact and a resend costs less than a respawn

## Escalate one hard question to `oracle`, from inside a worker as readily as from main
- WHEN: about to commit to an approach whose reversal is expensive, or about to report done when that report unlocks an irreversible step (a prod migration, a column drop, a publish)
- DO: spawn `subagent_type: "oracle"` with NO `model` param, passing `question:` plus the `context:` that makes it judgeable -- `subagent-model-guard.py` allows this from inside a worker on exactly the same terms as from the main thread
- DO: state the verdict in your own words, and surface a `suggest_more` other than `none` before continuing
- DO (worker): escalate from where the evidence sits rather than deferring the question to whoever reads your report, because the context that makes it answerable is yours and expires with your turn
- WHY: the advisor tool double-counts context and force-compacts the session early; a subagent does not -- [[advisor-inflates-autocompact-threshold]]

## Plan mode -- present the plan before the first mutation
- NOTE: the `clm` plugin folds older turns into a ledger (done, to do, key facts, open questions) at every turn end, so context stays bounded with no manual step from you
- SETUP: at session start, ToolSearch `select:TaskCreate,TaskUpdate,TaskList,EnterPlanMode,ExitPlanMode` before any other work, because a deferred EnterPlanMode is invisible at decision time
- WHEN (think): the shared "Plan after research, then act" rule's non-trivial bar is met, and the task's FIRST mutation has not happened yet
- DO (think): finish the research inline FIRST, then call EnterPlanMode, then distill the findings into the plan file and present it via ExitPlanMode -- an inline plan paragraph does not count as presenting a plan
- EXCEPT: act directly when the user handed you a ready-made plan, said to skip planning, or asked for a few-line fix

## Questions = explain only
- WHEN: the message asks about work already done, or starts with "ask:"
- DO: explain in text, grounded in the files, and read the question as a question rather than a correction or an undo signal
- EXCEPT: answer AND act when the message carries a directive clause ("why is X slow -- fix it")

## One thread of work = one PR
- WHEN: any work that will end in a pull request
- DO: search your own open PRs first -- `gh pr list --state open --author @me --json number,title,headRefName,files`
- DO: get the user's approval for the split when the work needs 2+ PRs

## Push only to claude/* branches
- WHEN: running `git push`
- NEVER: create or modify `.nanno-workers.json` anywhere -- its `git_push_guard_bypass` exists only where the user granted it
