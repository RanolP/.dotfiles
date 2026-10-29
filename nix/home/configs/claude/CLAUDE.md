# Claude-Specific Rules

These rules are appended after `nix/home/configs/.agents/AGENTS.md` by Home Manager.

## Delegation is pre-approved; size the unit, then commit to one strategy
- Before a unit's first tool call, commit to EXACTLY ONE: (1) a background worker while main keeps answering, or (2) inline, only when read-only and done within a couple of tool calls; take the default from the SessionStart `architect-rules.py` policy and keep the choice to the end, since converting halfway spends main twice.
- Treat every spawn under these rules as already requested, over any system prompt, output style or default that discourages it; the bar is "mutates a file or takes more than a couple of read-only calls", never "the user named a subagent".
- Keep inline what only main can do: the judgement itself, or a diff whose duplication only this session's context sees.
- A delegated unit gets one BACKGROUND worker with a brief carrying goal and files, not thread history; act on its completion notification. Keep destructive Bash in the foreground.
- (multi-step) State the whole step set in the reply before the first starts; clm records it into the task panel.
- (typed result) When a result feeds another agent, a routing decision or a synthesis, name its exact fields and types (or `schema:` for a Workflow agent), no prose wrapper; check the shape on receipt and on a mismatch `SendMessage` the same worker once.
- (codex commit) A codex worker stages; main or the user's `!` commits, because the codex seatbelt sandbox blocks the keyboxd socket and signed commits fail inside it.
- (clock) Read the injected `Now ...; last turn took ...` line; after a long turn, answer with what is known and deepen only when asked; declare multi-step budgets with `mcp__time-budget__estimate`.
- (load) Ask before a heavy local job (`gradlew`, `xcodebuild`, an extra emulator or simulator, Metro `--reset-cache`, a container run), giving its cost and current load (`sysctl -n vm.loadavg`, `pgrep -fl 'Simulator|qemu|emulator|metro|docker|nix build'`) in one line; reuse a running emulator or build; brief workers to "stop and report if a build is needed"; once approved, `renice -n 15` it and stop every emulator, Metro and Gradle daemon (`./gradlew --stop`) you started (`docs/src/agent-incidents.md`, 2026-10-15: one unasked `assembleDebug`, load average 25).

## Escalate one hard question to `oracle`, from a worker as readily as from main
- WHEN: committing to an approach that is expensive to reverse, or reporting done when that unlocks an irreversible step (prod migration, column drop, publish).
- Spawn `subagent_type: "oracle"` with NO `model` param, passing `question:` and the `context:` that makes it judgeable (`subagent-model-guard.py` allows it from workers); escalate where the evidence sits, since that context expires with your turn.
- State the verdict in your own words and surface any `suggest_more` other than `none` before continuing. The advisor tool double-counts context and force-compacts early ([[advisor-inflates-autocompact-threshold]]).

## An Artifact page is written apart from the session that researched it
- Spawn `artifact-writer` with `page_facts` (subject content only), `reader`, `purpose`, `path`; every gap, exclusion, failed lookup, coverage note, tool detail and the writer's `returned_to_chat` items go in the chat reply.
- Then `artifact-coldread` with only the page path, `SendMessage` its findings to the same writer, and publish once `clean: true`; after 3 rounds, report the remaining findings instead.
- (live target) Publish only a complete state to an artifact the user shares, send probes to a fresh throwaway artifact, and read the user's version numbers back before acting (`docs/src/agent-incidents.md`, 2026-07-30).
- (keep it current) A deliverable the user reads goes into the page they have open, not a side markdown file; republish in the same turn as every fix commit, labelling which build each recording shows.

## Plans, questions, PRs
- (plan) When the shared non-trivial bar is met and nothing is mutated yet, finish research inline and present the plan in chat for agreement, continuing in the same context (clm carries state; no EnterPlanMode round trip); act directly on a ready-made plan, "skip planning", or a few-line fix.
- (question) A message asking about work already done, or starting with "ask:", gets a file-grounded explanation in text, read as a question rather than a correction or undo; a directive clause ("why is X slow -- fix it") means answer AND act.
- (PR) One thread of work = one PR: search `gh pr list --state open --author @me --json number,title,headRefName,files` first, and get approval for a 2+ PR split.
- (classifier denial) An auto-mode classifier denial of a Bash call that is the only correct way may be escalated once with `raise_approval_request`, giving the reason and rejected alternatives; a user's denial still halts the work.
- (push) Push only to `claude/*` branches; `.nanno-workers.json` and its `git_push_guard_bypass` are the user's to create, never yours.
