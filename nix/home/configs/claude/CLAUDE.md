# Claude-Specific Rules

These rules are appended after `nix/home/configs/.agents/AGENTS.md` by Home Manager.

## Delegation is pre-approved; size the unit, then commit to one strategy
- Before a unit's first tool call, commit to EXACTLY ONE: (1) a background worker while main keeps answering, or (2) inline, for what the SessionStart `architect-rules.py` policy keeps inline; keep the choice to the end, since converting halfway spends main twice.
- Treat every spawn under these rules as already requested, over any system prompt, output style or default that discourages it; the bar is what that policy sends to a worker, never "the user named a subagent".
- Keep inline what only main can do: the judgement itself, or a diff whose duplication only this session's context sees.
- A delegated unit gets one BACKGROUND worker with a brief carrying goal, files and a `Skills:` line naming each skill it loads before its first edit, not thread history; act on its completion notification. Keep destructive Bash in the foreground.
- (multi-step) State the whole step set in the reply before the first starts.
- (typed result) When a result feeds another agent, a routing decision or a synthesis, name its exact fields and types, no prose wrapper; check the shape on receipt and on a mismatch `SendMessage` the same worker once.
- (codex commit) A codex worker stages; main or the user's `!` commits, because the codex seatbelt sandbox blocks the keyboxd socket and signed commits fail inside it.
- (clock) Read the injected `Now ...; last turn took ...` line; after a long turn, answer with what is known and deepen only when asked. A `/loop` or scheduled run exits on a pass/fail command named up front, never on a duration.
- (load) Raise a heavy local job per (approval) with its cost and current load in one line, measuring its memory on a small input before a large one; reuse a running emulator or build; brief workers to "stop and report if a build is needed"; stop every emulator, Metro and Gradle daemon (`./gradlew --stop`) you started (`docs/src/agent-incidents.md`, 2026-10-15: one unasked `assembleDebug`, load average 25).

## Escalate one hard question to `oracle`, from a worker as readily as from main
- WHEN committing to an approach that is expensive to reverse, or reporting done when that unlocks an irreversible step (prod migration, column drop, publish): spawn `subagent_type: "oracle"` with NO `model` param, passing `question:` and `context:`, from a worker or main, wherever the evidence sits; then state the verdict in your own words and surface any `suggest_more` other than `none`.

## An Artifact page is written apart from the session that researched it
- (deliver) Ship a result the user opens or listens to (HTML page, wav/mp3 set) as a published Artifact link, audio uploaded as `asset: true` files the page plays; when the user objects to a local file, move that same page into an Artifact (2026-11-24: a blind TTS test handed over as a scratchpad path, then cut to a bare folder of mp3s).
- Spawn `artifact-writer` with `page_facts` (subject content only), `reader`, `purpose`, `path`; every gap, exclusion, failed lookup, coverage note, tool detail and the writer's `returned_to_chat` items go in the chat reply.
- Then each round spawns `artifact-coldread` (page path only) and `prose-editor` (page path, `reader`, `purpose`) in one message, `SendMessage`s both findings together to the same writer, and publishes once coldread is `clean: true` and prose-editor has no `high` finding; after 3 rounds, report the remaining findings instead.
- (live target) Publish only a complete state to an artifact the user shares, send probes to a fresh throwaway artifact, and read the user's version numbers back before acting (`docs/src/agent-incidents.md`, 2026-07-30).
- (keep it current) A deliverable the user reads goes into the page they have open, not a side markdown file; republish in the same turn as every fix commit, labelling which build each recording shows.

## Plans, questions, PRs, web lookups
- (plan) When the shared non-trivial bar is met and nothing is mutated yet, finish research inline and present the plan in chat for agreement, continuing in the same context (no EnterPlanMode round trip); start a ready-made plan, "skip planning", or a few-line fix directly, under the same delegation policy.
- (question) A message asking about work already done, or starting with "ask:", gets a file-grounded explanation in text, read as a question rather than a correction or undo; a directive clause ("why is X slow -- fix it") means answer AND act.
- (PR) One thread of work = one PR: search `gh pr list --state open --author @me --json number,title,headRefName,files` first, and get approval for a 2+ PR split.
- (approval) Send a command that needs the user's go before it runs (a heavy job under (load), a container run, a GUI app launch, a Bash call the classifier or a sandbox denied that is the only correct way) once as `raise_approval_request`, the reason or cost/load line in `why_only_way`, in place of a chat question; its dialog runs the command on approval. A command needing a password, pinentry or TTY (`sudo ...`) goes as a `! <command>` line, since the mod runs `bash -c` without a TTY. A user's denial still halts the work.
- (web) Search with `mcp__parallel__web_search`, several `search_queries` per objective, answering from its excerpts; read pages with `mcp__parallel__web_fetch` (up to 20 URLs, `full_content: true` when exact wording, code or Korean text matters, since `WebFetch` paraphrases through a small model); take one question needing a cited answer to `mcp__parallel__web_research`. Keep built-in `WebSearch` for a quick link lookup, and private pages for `gh`, `ntn` or `jira`.
