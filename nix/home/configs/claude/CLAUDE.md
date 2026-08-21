# Claude-Specific Rules

These rules are appended after `nix/home/configs/.agents/AGENTS.md` by Home Manager.

## Plan mode -- one gate, two signals: think and hand off
- PURPOSE: plan mode exists to keep working context lean -- the plan file, not the transcript, is what carries work forward
- SETUP: at session start, ToolSearch `select:TaskCreate,TaskUpdate,TaskList,EnterPlanMode,ExitPlanMode` before any other work -- a deferred EnterPlanMode is invisible at decision time
- WHEN (think): the shared "Plan after research, then act" rule's non-trivial bar is met and the task's FIRST mutation (Edit/Write/mutating Bash) has not happened yet
- DO (think): finish the research inline FIRST, then call EnterPlanMode -- `plan-mode-guard.py` denies every acting tool inside plan mode, so distilling the findings into the plan file and presenting it via ExitPlanMode is all that remains; an inline plan paragraph does not count as presenting a plan, and this ExitPlanMode approval is the ONE expected checkpoint the shared "Checkpoint only for genuine blockers" rule exempts
- WHEN (handoff): a finished unit of work hands off to the next one inside the same session -- every task boundary is a handoff point, not a context alarm
- DO (handoff): call EnterPlanMode and write the NEXT unit of work into the plan file -- the approved plan is the compressed context that replaces the old transcript; the cost of skipping it is a ramp, not a cliff: every later tool call re-reads the whole transcript as cache-read input, and once the harness auto-summarizes, the compression is generic instead of the one you chose; hand off at the boundary, never at a token count
- EXCEPT: the user handed a ready-made plan or spec to implement, explicitly said to skip planning, or the change is a few-line fix -- act directly
- NEVER: enter plan mode before research is finished; signal /compact or /clear as the compression mechanism -- EnterPlanMode is the handoff signal; silently let one session accumulate every task's transcript

## Orchestrate via subagents
- WHEN: a task is genuinely too heavy for the main thread -- large multi-file investigation, wide parallel steps, or token-heavy execution whose trace would bloat main context; ALSO when main-thread context is already large (roughly 100k+) and a multi-step execution loop is starting (build-test-fix cycles, migrations, repetitive edit batches)
- KEEP MAIN AVAILABLE: the main thread's job is to stay responsive to the user as an orchestrator, never to grind an execution loop itself. A background subagent returns control to main the instant it is spawned, so delegate the loop to a BACKGROUND worker (run_in_background, the default) and let the user keep talking to main while it runs; the harness re-invokes main when the worker finishes, so act on that completion notification -- continue other ready work or end the turn, per the shared "Wait inside one blocking call" rule. A single command that may run long or emit long output (builds, test suites, rebuilds, log greps, watchers) goes to a subagent likewise -- it returns the verdict, not the transcript.
- LAZY DEFAULT: work inline while main context is small. A spawn re-sends the whole system prompt and eats its own trace, so a needless spawn costs MORE tokens, not fewer; when one worker suffices, use one and do not fan out speculatively. BUT the economics flip once main context is large: every inline tool call re-reads the entire conversation, so a 30-call execution loop at 150k context costs ~4.5M cache-read tokens while the same loop in a fresh subagent runs at ~50k per call. At 100k+ context, delegate execution loops with a self-contained brief and keep only results in main. (A Fable main thread inverts this default; `fable-rules.py` injects that section at session start.)
- DO (only once a spawn clears the bar above): treat the main thread as an orchestrator; delegate with a self-contained brief so token-heavy traces stay out of main context (accumulate results, not traces); pass an explicit `model` on EVERY Agent call -- sonnet is the default, haiku is mechanical work, `subagent-model-guard.py` denies a spawn that omits it; `orchestration-guard.py` injects the `subagent-orchestration` skill at your first spawn, and it carries the tier table, the brief contents, the `fork` cost, the oracle escalation and the typed-handoff rules
- DO (review before finishing): after you author non-trivial code yourself, review the full `git diff HEAD` for correctness and scope creep, or spawn a fresh sonnet reviewer with a self-contained brief, and address findings before finishing
- NEVER: spawn a subagent for work the main thread can already hold inline; fan out wider than the task needs
- EXCEPT: tiny one-liners, exploratory/uncertain scope, or active dialogue with the user -- edit inline

## Multi-step work: register it, then run it by dependency
- WHEN: a task has 2+ independently meaningful steps -- whether or not any step is delegated
- DO: register every step with TaskCreate before the first one starts, so the whole shape is visible up front; mark a step `in_progress` as it begins and `completed` only once its result is confirmed -- the SETUP line above loads these tools for exactly this; this is bookkeeping the user can watch, not a second approval checkpoint
- DO: run steps in dependency order -- everything with no unmet dependency goes out together (independent Agent spawns belong in ONE message so they run concurrently), dependent steps wait and receive only (goal + relevant files), never the thread history
- DO: keep destructive Bash in the foreground where its output lands in context; route every long or noisy command to a subagent per the rule above, so only the verdict reaches the main thread

## Questions = explain only
- WHEN: the message asks about work already done, or starts with "ask:" (an `ask:` turn is also hook-enforced -- every acting tool is denied; read-only lookups Read/Glob/Grep/NotebookRead/ToolSearch/WebFetch/WebSearch/Task{List,Get,Output} stay open)
- DO: answer in text; read the files first when the answer depends on them -- ground the explanation in evidence rather than guessing or refusing; treat it as a request for explanation, never as a correction or an undo signal
- EXCEPT: the message also carries a directive clause ("why is X slow -- fix it") -- then answer AND do the work

## One thread of work = one PR
- WHEN: any work that will end in a pull request
- DO: before writing the code, search your own open PRs for one that already covers this task (`gh pr list --state open --author @me --json number,title,headRefName,files`), and get the user's approval for the split first when the work needs 2+ PRs
- DO: follow `github-master/guides/pr.md` for the rest -- the `gh-guard` PreToolUse hook injects it in full on every mutating `gh pr` command, so the duplicate-match cases, the base-branch rule, and the body format arrive at the command itself
## Push only to claude/* branches
- WHEN: running `git push`
- DO: push `claude/*` only, as an explicit standalone `origin claude/<branch>` refspec; `git-push-guard.py` denies the rest and explains itself
- DO (`~/.dotfiles`): work on `main` here and push `origin main` when the user asks -- "you must not make any branch here. just work with main."
- NEVER: create or modify `.nanno-workers.json` anywhere -- its `git_push_guard_bypass` exists only where the user granted it
