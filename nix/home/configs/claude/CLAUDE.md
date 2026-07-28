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
- KEEP MAIN AVAILABLE: the main thread's job is to stay responsive to the user as an orchestrator, never to grind an execution loop itself. A background subagent returns control to main the instant it is spawned, so delegate the loop to a BACKGROUND worker (run_in_background, the default) and let the user keep talking to main while it runs; poll or await results, do not block the turn on the loop. Long-running single commands (builds, test suites, rebuilds, watchers) run in the background likewise -- never inline where they occupy the turn.
- LAZY DEFAULT: work inline while main context is small. A spawn re-sends the whole system prompt and eats its own trace, so a needless spawn costs MORE tokens, not fewer; when one worker suffices, use one and do not fan out speculatively. BUT the economics flip once main context is large: every inline tool call re-reads the entire conversation, so a 30-call execution loop at 150k context costs ~4.5M cache-read tokens while the same loop in a fresh subagent runs at ~50k per call. At 100k+ context, delegate execution loops with a self-contained brief and keep only results in main. (Fable main thread: see the Fable rule below, which inverts this default.)
- DO (only once a spawn clears the bar above): treat the main thread as an orchestrator; delegate with a self-contained brief so token-heavy traces stay out of main context (accumulate results, not traces); route each delegation to the right worker --
  - native Claude subagent (investigation, research, review, design, implementation): pass an explicit `model` on EVERY Agent call -- sonnet is the DEFAULT for anything needing reasoning (research, review, design, debugging) and is the implementer for well-scoped code changes; haiku for mechanical search/read work (search, file reads, pattern matching, data collection, Slack/web crawls); use `fork` only when the subagent truly needs this thread's context (fork inherits the parent model at full parent context cost -- prefer a fresh sonnet spawn with a self-contained brief)
  - review non-trivial diffs before finishing: after you author non-trivial code yourself, review the full `git diff HEAD` for correctness and scope creep, or spawn a fresh sonnet reviewer with a self-contained brief, and address findings before finishing
  - typed handoffs: when a subagent's result feeds a next step (another agent, a routing decision, a synthesis pass) rather than being a terminal answer, name the exact return shape in the brief (the fields and their types, or a fenced schema block) and require the worker to return ONLY that shape, no prose wrapper; validate on receipt -- on mismatch, `SendMessage` the same agent once to re-emit in shape (its context is intact, so this is cheaper than respawning), then parse what you have; for `Workflow` agents pass the `schema:` option so validation happens at the tool layer and the worker retries on mismatch instead of you parsing an essay; accumulate typed results, not narration; prose is fine for a terminal answer or a single one-shot worker whose entire output you read yourself; a checker is optional (most handoffs need none), but when one exists it is a separate node with its own typed verdict -- the maker never grades its own handoff
- NEVER: spawn a subagent for work the main thread can already hold inline; fan out wider than the task needs; spend a top-tier model on mechanical work or a cheap model on work that needs real reasoning; chain free-form prose between subagents and then regex the fields back out
- EXCEPT: tiny one-liners, exploratory/uncertain scope, or active dialogue with the user -- edit inline

## Fable = architect: assess the state, delegate the change
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
- DO: keep long-running or destructive Bash in the foreground where its output lands in context; reserve `run_in_background` for work the user asked to background

## Questions = explain only
- WHEN: the message asks about work already done, or starts with "ask:" (an `ask:` turn is also hook-enforced -- every acting tool is denied; read-only lookups Read/Glob/Grep/NotebookRead/ToolSearch/WebFetch/WebSearch/Task{List,Get,Output} stay open)
- DO: answer in text; read the files first when the answer depends on them -- ground the explanation in evidence rather than guessing or refusing; treat it as a request for explanation, never as a correction or an undo signal
- EXCEPT: the message also carries a directive clause ("why is X slow -- fix it") -- then answer AND do the work

## Push only to claude/* branches
- WHEN: running `git push`
- DO: push to `claude/*` only, as an explicit `origin claude/<branch>` refspec, standalone -- a PreToolUse guard blocks everything else and explains itself
- NEVER: create or modify `.nanno-workers.json` through any channel -- the guard bypass exists only when the user grants it