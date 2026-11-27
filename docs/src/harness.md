# Agent harness: roles and delegation

Read this before changing any delegation, brief or routing rule (`nix/home/configs/claude/CLAUDE.md`, `nix/home/configs/.agents/AGENTS.md`, `nix/home/configs/claude/hooks/architect-rules.py`, [model routing](./model-routing.md)). Every such rule serves the role model below; a rule that contradicts it is the rule's bug.

## The role model

The user stated it on 2026-11-27:

> 사용자가 CTO 임원급으로 방향과 큰 설계를 전달해. 그럼 Opus가 핵심 설계자로서 DDD, 작업 분할, 구현 아이디어 체크 등 실무자로서 오케스트레이션을 해. 그리고 C-lv user와의 소통을 놓치지 않기 위해 worker는 값싸게 위임해. 신입급으로. 그에 준하게 지시를 세세히 내리고, 강하게 마이크로매니징해.

- The user is the CTO. They give direction and the large design.
- The main Opus session is the lead practitioner. It owns domain design (DDD), splits the work, checks implementation ideas and orchestrates. It owns every worker's outcome.
- Workers are cheap junior hires. Main delegates to them so its own thread stays free for the user. A junior gets a detailed brief and close supervision, and reports to main whenever an instruction is ambiguous or something fails (triggers in P7).

Autonomy is deliberate: "가드레일이 너무 빡빡하면 될 작업도 안되니까" (guardrails that are too tight block work that would otherwise succeed). A fix for an agent's bad judgment changes the orchestrator's briefs and decisions; agents keep their current permissions. A last-resort safety net that fires only when the machine is about to die stays: `resource-watchdog.py` (`nix/home/configs/claude/resource-watchdog.py`), which freezes the biggest agent job under memory pressure.

## Where the current rules drift from it

Found 2026-11-27, after the Mac's hardware watchdog (iBoot) reset the machine (see [agent incidents](./agent-incidents.md)).

1. `architect-rules.py` justifies delegation by cost ("the main model's own tokens are the expensive ones"). The reasons in the role model, keeping main free for the user and main owning the outcome, are absent.
2. The Claude worker brief (`CLAUDE.md`, "A delegated unit gets one BACKGROUND worker with a brief carrying goal, files and a `Skills:` line ... not thread history") has no slot for observed failures, refuted premises or stop conditions. "not thread history" reads as "drop the failure record". The codex brief in `architect-rules.py` is richer (`Preserve:`, `Baseline:`, `Done when:`).
3. `AGENTS.md` "Re-verify a Claude worker's report only when it lacks commands and output, or the change reaches past what it checked" trusts a worker by default, the opposite of close supervision.
4. Tier routing ("`sonnet` well-scoped, `opus` deep" in `architect-rules.py`; "opus does hard cross-cutting implementation" in [model routing](./model-routing.md)) raises the worker's tier for hard work. In the role model, main's brief and decisions absorb hard work.
5. No rule names the points where main must decide before the next dispatch.
6. A worker reports only at the end. No rule makes it report an ambiguity or failure while it works.
7. Main cannot see which worker started which process, and stopping a worker may leave a job it detached running.
9. Review hooks decide by path, not by reader or lifetime. `prose-review-nudge.py` orders "spawn the `prose-editor` subagent" for every `.md`/`.html` outside agents, skills and memory, so a one-line `SUMMARY.md` entry and a long-lived doc get the same order. The agent can only obey it everywhere or skip it everywhere.
8. `AGENTS.md` routes durable narratives to `memory/evidence/` ("One file under `memory/evidence/` per non-obvious conclusion ... skill `evidence-store`"; repo `AGENTS.md`: "write the narrative into `memory/evidence/` or `docs/src/agent-incidents.md`"). Agents write there and rarely read it back.

## Improvement plan

Proposed 2026-11-27; checked items applied the same day. P10 kept the hooks that guard against an irreversible or machine-wide loss (apology-leak, baseline-lock, claude-dir-edit, declarative-package, flake-stage, git-integrity, git-push, gui-launch, leak, nsc, publish, slack-subagent, ssh) and the non-guard hooks (architect-rules, mcp-auth-log, rex-project-theme), and removed the other 20. P8 (`0663f69`): a subagent's Bash runs with `CLAUDE_AGENT_ID=<agent id>` exported, so its detached children keep the tag; the resources mod names the worker on every pressure and watchdog note, and a successful `TaskStop` kills the tagged processes (SIGTERM, then SIGKILL after 3 s). Before this, a subagent's env matched main's, and a `(nohup sleep 1777 &)` survived `TaskStop` with ppid 1 (measured 2026-11-27). The `export` prefix turned every worker call into an approval ask, which in auto mode meant approving every command by hand; a `tool.check` re-check of the untagged command did not stop it. The prefix and the re-check are removed (2026-11-27). Worker attribution needs a tracker that leaves the command text untouched; until one lands, nothing exports `CLAUDE_AGENT_ID`, so pressure notes say `started by main` for every job and `TaskStop` kills no detached job.

- [x] **P1** (drift 1) Put the role model at the head of `CLAUDE.md` as one paragraph and link this doc. Rewrite the `architect-rules.py` rationale from cost to the role model.
- [x] **P2** (drift 2) One brief shape for every worker: `Goal`, `Files`, `Skills:`, `Known:` (observed failures, refuted premises, measured numbers), `Stop when:` (P7's defaults plus unit-specific conditions), `Checkpoints:` (where to report back before going on), `Done when:`, return shape. A codex brief keeps `Budget:`, `writable:`, `Preserve:`, `Reuse:` and `Baseline:` ahead of these. "not thread history" becomes "the evidence behind each decision, not the conversation".
- [x] **P3** (drift 3, 5) Main reruns the brief's `Done when:` command and opens each `file:line` a worker report cites before acting on it. An anomaly a worker reports (abnormal exit, memory pressure, a failed check) gets main's hypothesis and decision before the next dispatch, and that decision goes into the next brief's `Known:`.
- [x] **P4** (drift 4) Route workers as juniors: sonnet or haiku by default, codex `gpt-6-luna` for mechanical bulk. Hard work gets a more detailed brief and more checkpoints at the same tier. An opus worker only for work that needs main's own context (model-facing prompt text). Update [model routing](./model-routing.md) to match.
- [x] **P5** Keep `CLAUDE.md` plus `AGENTS.md` under 28,000 bytes (25,285 on 2026-11-27): P1 and P2 are paid for by deleting the sentences P3 and P4 replace.
- [x] **P6** (drift 8) Durable agent knowledge goes into docs under `docs/src/`, found by `rg` over `docs/`. The user on 2026-11-27: "니가 쓰는 메모리 툴은 99% 확률로 write만 하고 제대로 read retrieval 하는 꼴을 본적이 없어요;;; 제발 저장소 내부 문서로 기록하고 검색을 제대로 하자". Changes the `evidence-store` rule in `nix/home/configs/.agents/AGENTS.md` and the "always-loaded rules files" rule in the repo `AGENTS.md`.
- [x] **P7** (drift 6) A worker reports to main the moment it meets ambiguity or a failure. The user: "신입도 신입 나름대로 촘촘한 보고를 해야 해. 실무 작업 중 ambigious하거나, 이런 메모리 압박처럼 실패를 경험하는 경우에 즉시 상급자에게 보고해야지."
  - Triggers: an ambiguous instruction or target, a failed command or check, an abnormal exit, any system alert (memory pressure, a `resource-watchdog` stop).
  - Channel: `SendMessage` with `to: "main"`, which a background subagent can call. The worker waits for main's reply before it goes on.
  - These triggers are the default contents of P2's `Stop when:` slot.
- [x] **P9** (drift 9) Main decides by itself, per artifact, whether a review earns its cost: does a person read it, and will it be read again after this task. The user on 2026-11-27: "사람이 마주하는 것과 아닌 것을 판단하고, 장기적으로 쓰일 것과 아닐 것을 판단해서 적절한 장소에만 써야지." Remove `prose-review-nudge.py`. The user: "nudge 훅이 필요한 것부터가 구조적 실패라니까? 지능이 알아서 판단해야 하는데 그게 안돼서 실패하니까 자꾸 훅으로 가잖아."
- [x] **P10** Audit every hook under `nix/home/configs/claude/hooks/`. Keep a hook that is a last-resort safety net against an irreversible or machine-wide loss (a destructive command, a leaked secret, an unbuildable config). Remove a hook that stands in for a judgment the orchestrator owns (a nudge, a hint, a reminder to load a skill), and move the judgment's reason into this doc.
- [x] **P11** Remove what keeps producing hooks. The user on 2026-11-27: "대부분의 훅이 그딴 사고로 니가 멍청하게 하네스 개선만 주장해서 생긴 훅이야". Two producers: the rule in `nix/home/configs/.agents/AGENTS.md` "Build a deterministic guard (CI check, git hook, `PreToolUse` hook) for anything a script can verify ... then strip the prose rule", and `repeat-correction-nudge.py`, which answers every repeated correction with "turn it into a mechanism (a guard, check or test over prose)". A correction is answered by fixing the instance and, when it reveals a misunderstanding of the role model, by fixing this doc. On 2026-11-27 `nix/home/configs/claude/hooks/` held 37 hook scripts besides tests; commit subjects such as "enforce agent rules mechanically with four new hooks" and "force-inject github-master guides via gh-guard hook" show the pattern. P10's audit runs after P11.
- [x] **P8** (drift 7) Main can see a running worker's state and stop or redirect it at once. The user: "상급자가 현재 상황을 알아보고 신입을 즉시 중단하거나 할 수단도 필요한 거고."
  - Exists today: the spawn result's `outputFile` and the worker's transcript show its state; `SendMessage` redirects it; `TaskStop` with its agent ID halts it.
  - To build: the `resources` mod (the Claude Code mod that posts memory-pressure notices into sessions) also tells main which running worker started each heavy process, so main stops the right one.
  - To build: a process a worker started stops with that worker under `TaskStop`. Unverified whether `TaskStop` already ends a job the worker detached with `&`; the check is to start a detached `sleep` from a worker, `TaskStop` it, and look for the pid.
