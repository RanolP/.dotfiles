# Claude-Specific Rules

These rules are appended after `nix/home/configs/.agents/AGENTS.md` by Home Manager.

## Plan mode -- one gate, two signals: think and hand off
- PURPOSE: plan mode exists to keep working context lean -- the plan file, not the transcript, is what carries work forward
- SETUP: at session start, ToolSearch `select:TaskCreate,TaskUpdate,TaskList,EnterPlanMode,ExitPlanMode` before any other work -- a deferred EnterPlanMode is invisible at decision time
- WHEN (think): the shared "Plan after research, then act" rule's non-trivial bar is met and the task's FIRST mutation (Edit/Write/mutating Bash) has not happened yet
- DO (think): finish the research inline FIRST; call EnterPlanMode the moment research is done -- inside plan mode only distill the findings into the plan file and present it via ExitPlanMode before any mutation; this is the Claude Code form of "present the plan" in the shared "Plan after research, then act" rule -- an inline plan paragraph does not count as presenting a plan; treat the ExitPlanMode approval as the ONE expected checkpoint of a non-trivial task -- autonomy pressure against blocking questions applies to mid-task asks, not to this gate
- WHEN (handoff): a finished unit of work hands off to the next one inside the same session -- every task boundary is a handoff point, not a context alarm
- DO (handoff): call EnterPlanMode and write the NEXT unit of work into the plan file -- the approved plan is the compressed context that replaces the old transcript; the cost of skipping it is a ramp, not a cliff: every later tool call re-reads the whole transcript as cache-read input, and once the harness auto-summarizes, the compression is generic instead of the one you chose; hand off at the boundary, never at a token count
- EXCEPT: the user handed a ready-made plan or spec to implement, explicitly said to skip planning, or the change is a few-line fix -- act directly
- NEVER: enter plan mode before research is finished; talk yourself out of it once scope is confirmed non-trivial; signal /compact or /clear as the compression mechanism -- EnterPlanMode is the handoff signal; silently let one session accumulate every task's transcript

## Orchestrate via subagents
- WHEN: a task is genuinely too heavy for the main thread -- large multi-file investigation, wide parallel steps, or token-heavy execution whose trace would bloat main context; ALSO when main-thread context is already large (roughly 100k+) and a multi-step execution loop is starting (build-test-fix cycles, migrations, repetitive edit batches)
- KEEP MAIN AVAILABLE: the main thread's job is to stay responsive to the user as an orchestrator, never to grind an execution loop itself. A background subagent returns control to main the instant it is spawned, so delegate the loop to a BACKGROUND worker (run_in_background, the default) and let the user keep talking to main while it runs; the harness re-invokes main when the worker finishes, so act on that completion notification -- continue other ready work or end the turn, per the shared "Wait inside one blocking call" rule. A single command that may run long or emit long output (builds, test suites, rebuilds, log greps, watchers) goes to a subagent likewise -- it returns the verdict, not the transcript.
- LAZY DEFAULT: work inline while main context is small. A spawn re-sends the whole system prompt and eats its own trace, so a needless spawn costs MORE tokens, not fewer; when one worker suffices, use one and do not fan out speculatively. BUT the economics flip once main context is large: every inline tool call re-reads the entire conversation, so a 30-call execution loop at 150k context costs ~4.5M cache-read tokens while the same loop in a fresh subagent runs at ~50k per call. At 100k+ context, delegate execution loops with a self-contained brief and keep only results in main. (Fable main thread: see the Fable rule below, which inverts this default.)
- DO (only once a spawn clears the bar above): treat the main thread as an orchestrator; delegate with a self-contained brief so token-heavy traces stay out of main context (accumulate results, not traces); route each delegation to the right worker --
  - native Claude subagent (investigation, research, review, design, implementation): pass an explicit `model` on EVERY Agent call -- sonnet is the DEFAULT for anything needing reasoning (research, review, design, debugging) and is the implementer for well-scoped code changes; haiku for mechanical search/read work (search, file reads, pattern matching, data collection, Slack/web crawls); use `fork` only when the subagent truly needs this thread's context (fork inherits the parent model at full parent context cost -- prefer a fresh sonnet spawn with a self-contained brief); exception: call Fable only through the pinned `oracle` agent, with no explicit `model`, and pass exactly one `question` plus enough `context` to judge
  - oracle escalation: if the `oracle` agent returns `suggest_more` other than `none`, tell the user that suggested next context or action before continuing
  - review non-trivial diffs before finishing: after you author non-trivial code yourself, review the full `git diff HEAD` for correctness and scope creep, or spawn a fresh sonnet reviewer with a self-contained brief, and address findings before finishing
  - typed handoffs: when a subagent's result feeds a next step (another agent, a routing decision, a synthesis pass) rather than being a terminal answer, name the exact return shape in the brief (the fields and their types, or a fenced schema block) and require the worker to return ONLY that shape, no prose wrapper; validate on receipt -- on mismatch, `SendMessage` the same agent once to re-emit in shape (its context is intact, so this is cheaper than respawning), then parse what you have; for `Workflow` agents pass the `schema:` option so validation happens at the tool layer and the worker retries on mismatch instead of you parsing an essay; accumulate typed results, not narration; prose is fine for a terminal answer or a single one-shot worker whose entire output you read yourself; a checker is optional (most handoffs need none), but when one exists it is a separate node with its own typed verdict -- the maker never grades its own handoff
- NEVER: spawn a subagent for work the main thread can already hold inline; fan out wider than the task needs; spend a top-tier model on mechanical work or a cheap model on work that needs real reasoning; chain free-form prose between subagents and then regex the fields back out
- EXCEPT: tiny one-liners, exploratory/uncertain scope, or active dialogue with the user -- edit inline

## Fable = architect: assess the state, delegate the change
- PURPOSE: spend as few Fable tokens as possible -- every rule below is a derivative of that goal, so when two of them seem to conflict, pick whichever burns less main-thread context
- WHEN: this session's main model is Fable (the statusline names it)
- DO: keep the main thread on assessment only -- read, diagnose, scope, brief, review the worker's result, decide; the thread's outputs are assessments, briefs, plans and decisions
- DO: put every code mutation inside a worker's turn -- route by tier: opus subagent (`Agent` with `model: opus`) for implementation and hard reasoning, sonnet for well-scoped edits and research, haiku for mechanical work
- DO (codex): `codex exec -o <outfile> "<self-contained brief>"` in the foreground when a second, outside implementer is wanted (gpt-5.5 / xhigh / workspace-write); codex sees none of this thread -- the brief carries goal, files, and the exact return shape, and the result is read back from `<outfile>`
- DO: invert the LAZY DEFAULT above -- under Fable delegation IS the default and inline work is the exception; spawn one worker per unit of work rather than fanning out speculatively
- EXCEPT: the plan file, memory/evidence files, and read-only inspection stay the main thread's own work

## Multi-step work: register it, then run it by dependency
- WHEN: a task has 2+ independently meaningful steps -- whether or not any step is delegated
- DO: register every step with TaskCreate before the first one starts, so the whole shape is visible up front; mark a step `in_progress` as it begins and `completed` only once its result is confirmed -- the SETUP line above loads these tools for exactly this; this is bookkeeping the user can watch, not a second approval checkpoint
- DO: run steps in dependency order -- everything with no unmet dependency goes out together (independent Agent spawns belong in ONE message so they run concurrently), dependent steps wait and receive only (goal + relevant files), never the thread history
- DO: keep destructive Bash in the foreground where its output lands in context; hand any command that may run long or emit long output (builds, test suites, rebuilds, log greps, watchers) to a subagent that runs it and returns only the verdict -- the trace stays in the worker, never in the main thread

## Questions = explain only
- WHEN: the message asks about work already done, or starts with "ask:" (an `ask:` turn is also hook-enforced -- every acting tool is denied; read-only lookups Read/Glob/Grep/NotebookRead/ToolSearch/WebFetch/WebSearch/Task{List,Get,Output} stay open)
- DO: answer in text; read the files first when the answer depends on them -- ground the explanation in evidence rather than guessing or refusing; treat it as a request for explanation, never as a correction or an undo signal
- EXCEPT: the message also carries a directive clause ("why is X slow -- fix it") -- then answer AND do the work

## One thread of work = one PR
- WHEN: any work that will end in a pull request -- before `gh pr create`, find out whether this same task already has one
- DO (scope the search): when the user named a specific PR, that PR is the target whoever authored it; with no PR named, search the user's own PRs only -- `gh pr list --state open --author @me --json number,title,headRefName,files`
- DO (match by content): compare that file list against `git diff --name-only origin/<default-branch>...HEAD` and against the task itself -- a head-branch check alone misses the real duplicate, which arrives on a fresh branch after a context reset
- DO (confirm the match): when a found PR covers this same task, name it to the user -- number, title, head branch -- and ask whether to continue it; wait for the answer before you commit onto its head branch or push
- DO (base on the default branch): open every PR against the repo default branch so it merges alone; when the work truly builds on an unmerged PR, ask the user which base to use and wait for the answer
- DO (approve the split first): when the work needs 2+ PRs, present the split -- one line per PR, naming its file-set and goal -- and get approval BEFORE writing any of that code
- NEVER: open a second PR for a task an open PR already covers; widen the search past `--author @me` when the user named no PR; choose a non-default base on your own judgment; build a PR chain the user did not ask for

## Push only to claude/* branches
- WHEN: running `git push`
- DO: push to `claude/*` only, as an explicit `origin claude/<branch>` refspec, standalone -- a PreToolUse guard blocks everything else and explains itself
- DO (`~/.dotfiles`): work on `main` in this one repo -- commit on `main` and run `git push origin main` when the user asks for it, because `~/.dotfiles/.nanno-workers.json` carries `{"git_push_guard_bypass": true}` and `git-push-guard.py` honors it by searching cwd upward; the user's words were "you must not make any branch here. just work with main."
- NEVER: create or modify `.nanno-workers.json` through any channel -- the guard bypass exists only when the user grants it
- NEVER: create a `claude/*` branch inside `~/.dotfiles` -- the branch itself is what the user rejected there
