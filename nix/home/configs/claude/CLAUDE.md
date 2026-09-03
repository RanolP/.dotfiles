# Claude-Specific Rules

These rules are appended after `nix/home/configs/.agents/AGENTS.md` by Home Manager.

## Plan mode -- one gate, two signals: think and hand off
- PURPOSE: keep working context lean -- the plan file, not the transcript, is what carries work forward
- SETUP: at session start, ToolSearch `select:TaskCreate,TaskUpdate,TaskList,EnterPlanMode,ExitPlanMode` before any other work, because a deferred EnterPlanMode is invisible at decision time
- WHEN (think): the shared "Plan after research, then act" rule's non-trivial bar is met, and the task's FIRST mutation has not happened yet
- DO (think): finish the research inline FIRST, then call EnterPlanMode
- DO (think): distill the findings into the plan file and present it via ExitPlanMode -- an inline plan paragraph does not count as presenting a plan
- NOTE: `plan-mode-guard.py` denies every tool inside plan mode except the plan-file write, AskUserQuestion, ToolSearch and ExitPlanMode -- Read, Grep and Glob included, because a read inside plan mode puts back the context the mode exists to drop; this ExitPlanMode approval is the ONE checkpoint the shared "Checkpoint only for genuine blockers" rule exempts
- WHEN (handoff): the NEXT unit of work is a different SUBJECT rather than the next step of the current one -- a finished unit whose successor stays on the same subject continues in this thread
- DO (handoff): invoke the `handoff` skill FIRST and follow it, because the template, the size budget and the `Chainable` flag live there and a handoff drafted from these four lines alone lands as a bare plan the user must still clean up
- DO (handoff): call EnterPlanMode and write the NEXT unit of work into the plan file, because the approved plan is the compressed context that replaces the old transcript
- DO (handoff): hand off at the TOPIC boundary first -- never at a task boundary that sits inside one topic; and when `handoff-nudge.py` names the thread's resident context, run the handoff at the next topic seam rather than riding the thread to a compaction, because the nudge fires at 110k tokens and auto-compaction fires near 170k, so the room it reports is the room the handoff itself has to run in
- WHY (handoff timing): measured over the 21 days ending 2026-09-03, handoff was invoked at a median resident context of 139,250 tokens against a ~167k-172k auto-compaction trigger, and a compaction landed inside 5 of the 17 handoffs -- every one of those 17 was a user-typed `/handoff` and none were model-initiated, while 466 compactions fired across 126 sessions doing the job handoff exists to do
- DO (chainable): read the active plan file's `Chainable:` line before handing off -- `true` or absent allows this handoff, and `false` means the current goal runs to completion in this one thread because nobody is at the approval prompt to advance it
- EXCEPT: act directly when the user handed you a ready-made plan, said to skip planning, or asked for a few-line fix
- NEVER: enter plan mode before the research is finished
- NEVER: signal /compact or /clear as the compression mechanism -- EnterPlanMode is the handoff signal

## Size the unit first, then commit to one of three strategies
- WHEN: about to start any unit of work, BEFORE its first tool call
- WHY: the main session is the only place the user can reach you, so a main thread grinding an execution loop is a session the user has lost; the strategy is a decision made up front, and one discovered mid-grind arrives after the thread is already spent
- DO: estimate how long this unit holds the main thread, then commit to EXACTLY ONE -- (1) SUBAGENT, a background Agent worker while main keeps answering the user; (2) HANDOFF, the `handoff` skill then EnterPlanMode, reserved for a different SUBJECT; (3) QUICK RETURN, inline because it finishes within a couple of tool calls
- DO (default): take 1 whenever the return looks slow, and whenever the size is unclear -- an unclear size IS a slow return
- DO: take 1 rather than 2 for work that is long but stays on the current subject, because length alone earns a subagent and only a topic change earns a handoff
- DO (chainable): read the active plan file's `Chainable:` line before taking 2 -- `false` means the current goal runs to completion in this one thread
- DO: carry the chosen strategy to the end and name it in the response, so the user sees which of the three is running -- starting inline and converting to a subagent halfway spends the main thread twice

## Orchestrate via subagents
- SETUP: the delegation policy arrives at session start -- `architect-rules.py` injects `## Architect mode` under a Fable or Opus main model and `## Delegation threshold` under every other, so exactly one policy decides when to spawn
- DO: delegate to a BACKGROUND worker whenever the sizing rule above chose strategy 1, so the user keeps talking to main while it runs
- DO: act on the completion notification when the harness re-invokes you -- continue other ready work, or end the turn
- DO: send any command that may run long or emit long output to a subagent, so it returns the verdict rather than the transcript
- DO: spawn one worker per unit of work, with a self-contained brief, so token-heavy traces stay out of main context
- DO: pass an explicit `model` on EVERY Agent call -- sonnet is the default and haiku is mechanical work
- DO (review before finishing): review the full `git diff HEAD` for correctness and scope creep after you author non-trivial code yourself, or spawn a fresh sonnet reviewer, and address the findings before finishing
- SKILL: `subagent-orchestration`, injected by `orchestration-guard.py` at your first spawn, for the tier table, the brief contents, the `fork` cost, the oracle escalation and the typed handoffs
- NOTE: `subagent-model-guard.py` denies a spawn that omits `model`

## Multi-step work: register it, then run it by dependency
- WHEN: a task has 2+ independently meaningful steps, delegated or not
- DO: register every step with TaskCreate before the first one starts, so the whole shape is visible up front
- DO: mark a step `in_progress` as it begins, and `completed` only once its result is confirmed
- DO: send everything with no unmet dependency out together -- independent Agent spawns belong in ONE message, so they run concurrently
- DO: give a dependent step only its goal and its relevant files, never the thread history
- DO: keep destructive Bash in the foreground, where its output lands in context
- NOTE: this is bookkeeping the user can watch, not a second approval checkpoint

## Questions = explain only
- WHEN: the message asks about work already done, or starts with "ask:"
- DO: answer in text, and read the files first when the answer depends on them
- DO: ground the explanation in evidence rather than guessing or refusing
- DO: treat the question as a request for explanation, never as a correction or an undo signal
- EXCEPT: answer AND do the work when the message also carries a directive clause ("why is X slow -- fix it")
- NOTE: an `ask:` turn is hook-enforced -- every acting tool is denied, and read-only lookups stay open

## One thread of work = one PR
- WHEN: any work that will end in a pull request
- DO: search your own open PRs for one that already covers this task before writing the code -- `gh pr list --state open --author @me --json number,title,headRefName,files`
- DO: get the user's approval for the split first, when the work needs 2+ PRs
- SKILL: `github-master`, injected by `gh-guard.py` on every mutating `gh pr` command, carrying the duplicate-match cases, the base-branch rule, and the body format

## Push only to claude/* branches
- WHEN: running `git push`
- DO: push `claude/*` only, as an explicit standalone `origin claude/<branch>` refspec
- DO (`~/.dotfiles`): work on `main` here, and push `origin main` when the user asks -- "you must not make any branch here. just work with main."
- NEVER: create or modify `.nanno-workers.json` anywhere -- its `git_push_guard_bypass` exists only where the user granted it
- NOTE: `git-push-guard.py` denies every other refspec and explains itself
