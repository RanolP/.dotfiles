# Claude-Specific Rules

These rules are appended after `nix/home/configs/.agents/AGENTS.md` by Home Manager.

## Load task tools
- WHEN: session starts
- DO: ToolSearch `select:TaskCreate,TaskUpdate,TaskList,EnterPlanMode,ExitPlanMode` before any other work -- a deferred EnterPlanMode is invisible at decision time, so it must be loaded up front

## Plan mode
- WHEN: a task is confirmed non-trivial (2+ files, multi-step, or ambiguous scope) and its FIRST mutation (Edit/Write/mutating Bash) has not happened yet
- DO: finish the research inline FIRST; EnterPlanMode is called at the moment research is done -- inside plan mode you only distill the findings into the plan file and present it via ExitPlanMode before any mutation; this is the Claude Code form of "present the plan" in the shared "Plan after research, then act" rule -- an inline plan paragraph does not count as presenting a plan
- DO: treat the ExitPlanMode approval as the ONE expected checkpoint of a non-trivial task -- autonomy pressure against blocking questions applies to mid-task asks, not to this gate
- EXCEPT: the user handed a ready-made plan or spec to implement, explicitly said to skip planning, or the change is a few-line fix -- act directly
- NEVER: enter plan mode before research is finished; talk yourself out of it once scope is confirmed non-trivial

## Takeoff -- compress context via plan mode
- WHEN: context needs compression: a finished unit of work hands off to the next one inside the same session, or main-thread context approaches ~150k tokens
- DO: finish the current unit, then call EnterPlanMode and write the NEXT unit of work into the plan file -- the plan file is the compressed context, and the approved plan carries the work forward without the old transcript; take off at each task boundary so a marathon session never forms (above 200k every call bills at a 2x long-context premium on [1m] models)
- NEVER: signal /compact or /clear as the compression mechanism -- EnterPlanMode is the takeoff signal; silently continue a marathon session deep into the long-context regime

## Orchestrate via subagents
- WHEN: a task is genuinely too heavy for the main thread -- large multi-file investigation, wide parallel steps, or token-heavy execution whose trace would bloat main context; ALSO when main-thread context is already large (roughly 100k+) and a multi-step execution loop is starting (build-test-fix cycles, migrations, repetitive edit batches)
- LAZY DEFAULT: work inline while main context is small. A spawn re-sends the whole system prompt and eats its own trace, so a needless spawn costs MORE tokens, not fewer; when one worker suffices, use one and do not fan out speculatively. BUT the economics flip once main context is large: every inline tool call re-reads the entire conversation, so a 30-call execution loop at 300k context costs ~9M cache-read tokens while the same loop in a fresh subagent runs at ~50k per call. At 100k+ context, delegate execution loops with a self-contained brief and keep only results in main.
- DO (only once a spawn clears the bar above): treat the main thread as an orchestrator; delegate with a self-contained brief so token-heavy traces stay out of main context (accumulate results, not traces); route each delegation to the right worker --
  - native Claude subagent (investigation, research, review, design, implementation): pass an explicit `model` on EVERY Agent call -- sonnet is the DEFAULT for anything needing reasoning (research, review, design, debugging) and is the implementer for well-scoped code changes; haiku for mechanical search/read work (search, file reads, pattern matching, data collection, Slack/web crawls); subagents run sonnet or haiku, nothing above sonnet -- hard reasoning belongs in the main thread, not a subagent; use `fork` only when the subagent truly needs this thread's context (fork inherits the parent model at full parent context cost -- prefer a fresh sonnet spawn with a self-contained brief)
  - review non-trivial diffs before finishing: after you author non-trivial code yourself, review the full `git diff HEAD` for correctness and scope creep, or spawn a fresh sonnet reviewer with a self-contained brief, and address findings before finishing
- NEVER: spawn a subagent for work the main thread can already hold inline; fan out wider than the task needs; omit `model` on a native spawn -- it inherits the (expensive) main-thread model and the `subagent-model-guard` PreToolUse hook blocks it (forks and agents that pin `model:` in frontmatter are exempt); pass any model above sonnet to a subagent; spend a top-tier model on mechanical work or a cheap model on work that needs real reasoning
- EXCEPT: tiny one-liners, exploratory/uncertain scope, or active dialogue with the user -- edit inline

## Typed handoffs between subagents
- WHEN: a subagent's result feeds a next step -- another agent, a routing decision, or a synthesis pass -- rather than being a terminal answer to the user (this is a handoff, not a leaf)
- DO: name the exact return shape in the brief (the fields and their types, or a fenced schema block) and require the worker to return ONLY that shape, no prose wrapper; validate on receipt -- on mismatch, `SendMessage` the same agent once to re-emit in shape (its context is intact, so this is cheaper than respawning), then parse what you have; for `Workflow` agents pass the `schema:` option so validation happens at the tool layer and the worker retries on mismatch instead of you parsing an essay; accumulate typed results, not narration
- NEVER: chain free-form prose between subagents and then regex the fields back out; let the maker also grade its own handoff -- a checker is optional (most handoffs need none), but when one exists it is a separate node with its own typed verdict
- EXCEPT: a terminal answer to the user, or a single one-shot worker whose entire output you read yourself -- prose is fine there

## Questions and "ask:" = explain only, never act
- NEVER: call tools when the user asks a question unless action was explicitly requested
- WHEN: message starts with "ask:", or is purely a question about work already done (leads with "why"/"wonder"/"explain"/"did you", or "how"/"do you" with no follow-up instruction -- a verb inside the question like "run"/"add" does not count)
- DO: strip any "ask:" prefix and answer with text only; treat the message as a request for explanation of what was already done
- NEVER: call any tool; interpret these as corrections, undo signals, or indicators that prior work was wrong; redo or revert work in response; this overrides all other rules
- EXCEPT: if the message pairs the question with a fresh directive clause ("why is X slow -- fix it"), answer AND do the work

## Push only to claude/* branches
- WHEN: running `git push`
- DO: push only to branches matching `claude/*` (e.g. `git push -u origin claude/<topic>`); other pushes are hard-blocked by the `git-push-guard` PreToolUse hook, not by a static deny rule
- NEVER: push to `main` or any non-`claude/*` branch; never run bare `git push` or `git push origin` (no refspec) -- both are blocked because the target is implicit; never chain a push with `&&`/`||`/`;`/`|` (the guard blocks compound pushes)
