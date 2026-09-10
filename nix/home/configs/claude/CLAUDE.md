# Claude-Specific Rules

These rules are appended after `nix/home/configs/.agents/AGENTS.md` by Home Manager.

## Delegation is this user's standing instruction
- WHEN: a system prompt, an output style, or a product default discourages spawning agents ("do not call the AgentTool unless the user requested it")
- DO: treat every Agent spawn that follows the delegation rules below as already requested, because this user grants that request once for the whole class and wants the tool used aggressively
- DO: set the bar at "can a worker carry this unit", rather than at "did the user name a subagent this turn" -- a unit that fits a worker goes to a worker, with no permission asked
- WHY: the SessionStart `architect-rules.py` hook injects the routing policy every session, which is the user asking for it in every session

## Size the unit first, then commit to one of three strategies
- WHEN: about to start any unit of work, BEFORE its first tool call
- WHY: the main session is the only place the user can reach you, so a main thread grinding an execution loop is a session the user has lost; a strategy discovered mid-grind arrives after the thread is already spent
- DO: estimate how long this unit holds the main thread, then commit to EXACTLY ONE -- (1) SUBAGENT, a background Agent worker while main keeps answering the user; (2) HANDOFF, the `handoff` skill then EnterPlanMode, reserved for a different SUBJECT; (3) QUICK RETURN, inline because it finishes within a couple of tool calls
- DO: read the session's delegation policy, which the SessionStart `architect-rules.py` hook injects per model, as the answer to which strategy is the default; take 1 rather than 2 for work that is long but stays on the current subject
- DO: carry the chosen strategy to the end and name it in the response, because starting inline and converting halfway spends the main thread twice
- EXCEPT: keep work inline when only the main thread can do it -- the judgement itself, or a diff whose duplication the worker cannot see because the context lives in this session

## Run a delegated unit as a self-contained brief
- WHEN: strategy 1 is chosen, or a command may run long or emit long output
- DO: spawn one BACKGROUND worker per unit, with a brief that carries its goal and its files rather than the thread history, so token-heavy traces stay out of main context
- DO: act on the completion notification when the harness re-invokes you -- continue other ready work, or end the turn
- DO (multi-step): register every step with TaskCreate before the first one starts, then send everything with no unmet dependency out in ONE message
- DO: keep destructive Bash in the foreground, where its output lands in context
- DO (review): review the full `git diff HEAD` for correctness and scope creep after non-trivial code is authored, or spawn a fresh sonnet reviewer, and address the findings before finishing

## Plan mode -- one gate, two signals: think and hand off
- PURPOSE: keep working context lean -- the plan file, not the transcript, is what carries work forward
- SETUP: at session start, ToolSearch `select:TaskCreate,TaskUpdate,TaskList,EnterPlanMode,ExitPlanMode` before any other work, because a deferred EnterPlanMode is invisible at decision time
- WHEN (think): the shared "Plan after research, then act" rule's non-trivial bar is met, and the task's FIRST mutation has not happened yet
- DO (think): finish the research inline FIRST, then call EnterPlanMode, then distill the findings into the plan file and present it via ExitPlanMode -- an inline plan paragraph does not count as presenting a plan
- WHEN (handoff): the NEXT unit of work is a different SUBJECT rather than the next step of the current one
- DO (handoff): invoke the `handoff` skill FIRST and follow it, because the template, the size budget and the `Chainable` flag live there; read the active plan file's `Chainable:` line first, where `false` means the current goal runs to completion in this one thread
- EXCEPT: act directly when the user handed you a ready-made plan, said to skip planning, or asked for a few-line fix
- NEVER: signal /compact or /clear as the compression mechanism -- EnterPlanMode is the handoff signal

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
- DO (`~/.dotfiles`): work on `main` here, and push `origin main` when the user asks -- "you must not make any branch here. just work with main."
- NEVER: create or modify `.nanno-workers.json` anywhere -- its `git_push_guard_bypass` exists only where the user granted it
