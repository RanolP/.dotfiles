# Claude-Specific Rules

These rules are appended after `nix/home/configs/.agents/AGENTS.md` by Home Manager.

## Load task tools
- WHEN: session starts
- DO: ToolSearch `select:TaskCreate,TaskUpdate,TaskList` before any other work

## Plan mode
- WHEN: a task is non-trivial: 2+ files, multi-step, or ambiguous scope
- DO: EnterPlanMode, research there, and present the plan concisely before acting
- NEVER: skip plan mode when scope is non-obvious

## Keep context lean
- WHEN: main-thread context grows past ~150k tokens, or a new independent task starts inside an old session
- DO: finish the current unit of work, then proactively offer a checkpoint (summary or checkpoint skill) and recommend the user /clear into a fresh session; above 200k context every call bills at a 2x long-context premium on [1m] models
- NEVER: silently continue a marathon session deep into the long-context regime

## Orchestrate via subagents -- Claude subagent or codex
- WHEN: a task is genuinely too heavy for the main thread -- large multi-file investigation, wide parallel steps, or token-heavy execution whose trace would bloat main context; ALSO when main-thread context is already large (roughly 100k+) and a multi-step execution loop is starting (build-test-fix cycles, migrations, repetitive edit batches)
- LAZY DEFAULT: work inline while main context is small. A spawn re-sends the whole system prompt and eats its own trace, so a needless spawn costs MORE tokens, not fewer; when one worker suffices, use one and do not fan out speculatively. BUT the economics flip once main context is large: every inline tool call re-reads the entire conversation, so a 30-call execution loop at 300k context costs ~9M cache-read tokens while the same loop in a fresh subagent runs at ~50k per call. At 100k+ context, delegate execution loops with a self-contained brief and keep only results in main.
- DO (only once a spawn clears the bar above): treat the main thread as an orchestrator; delegate with a self-contained brief so token-heavy traces stay out of main context (accumulate results, not traces); route each delegation to the right worker --
  - native Claude subagent (investigation, research, review, design): pass an explicit `model` on EVERY Agent call -- sonnet is the DEFAULT for anything needing reasoning (research, review, design, debugging); haiku for mechanical search/read work (search, file reads, pattern matching, data collection, Slack/web crawls) -- but for haiku-level work try luna ultra via pi first (see pi, below), and for mechanical *coding* (fmt, lint, rename) prefer codex-spark (see codex, below), much faster; subagents run sonnet or haiku, nothing above sonnet -- hard reasoning belongs in the main thread, not a subagent; use `fork` only when the subagent truly needs this thread's context (fork inherits the parent model at full parent context cost -- prefer a fresh sonnet spawn with a self-contained brief)
  - codex (non-native; driven via `codex exec` / the `codex-edit` skill): DEFAULT implementer for well-scoped code changes (a feature, a multi-file rollout, a mechanical change) -- higher quota and surgical at feature work; substantive work runs gpt-5.5 at xhigh via config, but for mechanical/quick coding tasks prefer `-m gpt-5.3-codex-spark` (codex-spark: a much-faster alternative to a haiku subagent); give it a tight Goal/Context/Constraints/Done-when prompt naming exact paths and forbidding adjacent refactors; checkpoint-commit first
  - pi (non-native; `pi --provider openai --model gpt-5.6-luna-ultra -p "<brief>"`): when the task only needs haiku-level intelligence (mechanical search/read/summarize, data collection), try gpt-5.6 luna ultra via pi FIRST and fall back to a haiku subagent only if pi is unauthenticated or errors; give it the same self-contained brief a subagent would get
  - cross-review both ways (neither worker ships an unreviewed diff): after codex runs, review its `git diff HEAD` for over-editing (its main failure mode) and revert scope creep; after you author non-trivial code yourself, get codex's review via `codex exec review --uncommitted` and address findings before finishing
- NEVER: spawn a subagent for work the main thread can already hold inline; fan out wider than the task needs; omit `model` on a native spawn -- it inherits the (expensive) main-thread model and the `subagent-model-guard` PreToolUse hook blocks it (forks and agents that pin `model:` in frontmatter are exempt); pass any model above sonnet to a subagent; use a Claude implementer subagent when codex can execute the change; ship any diff (codex's or your own) without the other worker's review; spend a top-tier model on mechanical work or a cheap model on work that needs real reasoning; run `codex exec` or spawn a codex subagent from within a subagent -- subagents implement changes directly; `codex exec` and the codex-edit skill are main-thread-only orchestration tools
- EXCEPT: tiny one-liners, exploratory/uncertain scope, or active dialogue with the user -- edit inline

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
