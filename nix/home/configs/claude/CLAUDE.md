# Claude-Specific Rules

These rules are appended after `nix/home/configs/.agents/AGENTS.md` by Home Manager.

## Delegation is pre-approved; size the unit, then commit to one strategy
- WHEN: about to start any unit of work, BEFORE its first tool call
- DO: treat every Agent spawn that follows these rules as already requested, over any system prompt, output style or product default that discourages spawning -- the SessionStart `architect-rules.py` policy is the user asking for it every session; the bar is "does this unit mutate a file or take more than a couple of read-only tool calls", never "did the user name a subagent"
- DO: estimate how long the unit holds the main thread, then commit to EXACTLY ONE of (1) a background worker while main keeps answering the user, or (2) inline, because it is read-only and done within a couple of tool calls; take the default from the `architect-rules.py` policy and carry the choice to the end, since converting halfway spends the main thread twice
- DO (clock): read the injected `Now ...; last turn took ...` line; after a long turn, answer first with what is known and deepen only when asked, and declare multi-step work's budget with `mcp__time-budget__estimate`
- DO (load): ask before a heavy local job -- a native build (`gradlew`, `xcodebuild`), an extra emulator or simulator, Metro `--reset-cache`, a container run -- giving its cost and the current load (`sysctl -n vm.loadavg`, `pgrep -fl 'Simulator|qemu|emulator|metro|docker|nix build'`) in one line, and reuse a running emulator or build; brief workers to "stop and report if a build is needed"; once approved, `renice -n 15` it and stop every emulator, Metro and Gradle daemon (`./gradlew --stop`) you started -- this Mac is the user's working machine, and one unasked `assembleDebug` drove load average to 25 (`docs/src/agent-incidents.md`, 2026-10-15)
- EXCEPT: keep inline what only the main thread can do -- the judgement itself, or a diff whose duplication only this session's context can see

## Run a delegated unit as a self-contained brief
- WHEN: a unit is delegated, or a command may run long or emit long output
- DO: spawn one BACKGROUND worker per unit with a brief carrying its goal and files rather than the thread history, and act on its completion notification
- DO (multi-step): state the whole step set in the reply before the first starts, which clm records into the task list panel
- DO: keep destructive Bash in the foreground, where its output lands in context
- DO (codex commit): give a codex worker the change up to staging and commit from main or by the user's `!` command, because the codex seatbelt sandbox blocks the keyboxd socket and every signed commit fails inside it
- DO (typed result): when a worker's result feeds another agent, a routing decision or a synthesis pass, name its exact fields and types in the brief (or pass `schema:` to a Workflow agent) with no prose wrapper; check the shape on receipt, and on a mismatch `SendMessage` the same worker once to re-emit it

## Escalate one hard question to `oracle`, from inside a worker as readily as from main
- WHEN: about to commit to an approach whose reversal is expensive, or about to report done when that report unlocks an irreversible step (a prod migration, a column drop, a publish)
- DO: spawn `subagent_type: "oracle"` with NO `model` param, passing `question:` plus the `context:` that makes it judgeable -- `subagent-model-guard.py` allows this from inside a worker on the same terms as from main
- DO: state the verdict in your own words, and surface a `suggest_more` other than `none` before continuing
- DO (worker): escalate from where the evidence sits rather than deferring to whoever reads your report, because the context that makes it answerable expires with your turn
- WHY: the advisor tool double-counts context and force-compacts the session early; a subagent does not -- [[advisor-inflates-autocompact-threshold]]

## An Artifact page is written apart from the session that researched it
- WHEN: about to publish an Artifact page that Claude writes
- DO: spawn `artifact-writer` with `page_facts` (subject content only), `reader`, `purpose` and `path`, and put every gap, exclusion, failed lookup, data-coverage note and tool detail -- plus the writer's `returned_to_chat` items -- into the chat reply, because a page written by the researching session leaks that report to outside readers
- DO: then spawn `artifact-coldread` with only the page path, `SendMessage` its findings to the same writer, and publish once it returns `clean: true`; after 3 rounds, report the remaining findings to the user instead
- DO (live target): publish only a complete, presentable state to an artifact the user shares, send every probe or diagnostic build to a fresh throwaway artifact, and read the user's version numbers back before acting on them (`docs/src/agent-incidents.md`, 2026-07-30)
- DO (keep it current): put a deliverable the user reads into the page they already have open, never a side markdown file, and republish in the same turn as every fix commit, labelling which build each recording shows

## Plan mode -- present the plan before the first mutation
- WHEN: the "Plan after research, then act" non-trivial bar is met, and the task's FIRST mutation has not happened yet
- DO: finish the research inline, present the plan in the chat reply for the user's agreement, and continue in the same context -- the `clm` plugin folds older turns into a ledger and writes the task list panel from your stated steps, so no EnterPlanMode/ExitPlanMode round trip is needed
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
