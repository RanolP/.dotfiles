# Agent harness: roles and delegation

Read this before changing any delegation, brief or routing rule (`nix/home/configs/claude/CLAUDE.md`, `nix/home/configs/.agents/AGENTS.md`, `nix/home/configs/claude/hooks/architect-rules.py`, [model routing](./model-routing.md)). Every such rule serves the role model below; a rule that contradicts it is the rule's bug.

## The role model

The user stated it on 2026-11-27:

> 사용자가 CTO 임원급으로 방향과 큰 설계를 전달해. 그럼 Opus가 핵심 설계자로서 DDD, 작업 분할, 구현 아이디어 체크 등 실무자로서 오케스트레이션을 해. 그리고 C-lv user와의 소통을 놓치지 않기 위해 worker는 값싸게 위임해. 신입급으로. 그에 준하게 지시를 세세히 내리고, 강하게 마이크로매니징해.

- The user is the CTO. They give direction and the large design.
- The main Opus session is the lead practitioner. It owns domain design (DDD), splits the work, checks implementation ideas and orchestrates. It owns every worker's outcome.
- Workers are cheap junior hires. Main delegates to them so its own thread stays free for the user. A junior gets a detailed brief and close supervision, and comes back to main at every judgment point.

Autonomy is deliberate: "가드레일이 너무 빡빡하면 될 작업도 안되니까". A fix for an agent's bad judgment goes into the orchestrator's briefs and decisions, not into a new restriction on what agents may do. A last-resort safety net that only fires when the machine is about to die (`resource-watchdog`) is not such a restriction.

## Where the current rules drift from it

Found 2026-11-27 after the hardware watchdog reset (see [agent incidents](./agent-incidents.md)).

1. `architect-rules.py` justifies delegation by cost ("the main model's own tokens are the expensive ones"). The reasons in the role model, keeping main free for the user and main owning the outcome, are absent.
2. The Claude worker brief (`CLAUDE.md`, "A delegated unit gets one BACKGROUND worker with a brief carrying goal, files and a `Skills:` line ... not thread history") has no slot for observed failures, refuted premises or stop conditions. "not thread history" reads as "drop the failure record". The codex brief in `architect-rules.py` is richer (`Preserve:`, `Baseline:`, `Done when:`).
3. `AGENTS.md` "Re-verify a Claude worker's report only when it lacks commands and output, or the change reaches past what it checked" trusts a worker by default, the opposite of close supervision.
4. Tier routing ("`sonnet` well-scoped, `opus` deep" in `architect-rules.py`; "opus does hard cross-cutting implementation" in [model routing](./model-routing.md)) raises the worker's tier for hard work. In the role model hard work is absorbed by main's brief and decisions.
5. No rule names the points where a worker must stop and report, or where main must decide before the next dispatch.

## Improvement plan

Status: proposed 2026-11-27, not applied.

- **P1** Put the role model at the head of `CLAUDE.md` as one paragraph and link this doc. Rewrite the `architect-rules.py` rationale from cost to the role model.
- **P2** One brief shape for every worker, Claude or codex: `Goal`, `Files`, `Known:` (observed failures, refuted premises, measured numbers), `Stop when:` (conditions to halt and report, including any system alert), `Checkpoints:` (where to report back before going on), `Done when:`, return shape. "not thread history" becomes "the evidence behind each decision, not the conversation".
- **P3** Main verifies worker reports by default. An anomaly a worker reports (abnormal exit, memory pressure, a failed check) gets main's hypothesis and decision before the next dispatch, and that decision goes into the next brief's `Known:`.
- **P4** Route workers as juniors: sonnet or haiku by default, codex luna for mechanical bulk. Hard work gets a more detailed brief and more checkpoints, not a higher tier. An opus worker only for work that needs main's own context (model-facing prompt text). Update [model routing](./model-routing.md) to match.
- **P5** Keep `CLAUDE.md` plus `AGENTS.md` under 28,000 bytes (25,285 on 2026-11-27): P1 and P2 are paid for by deleting the sentences P3 and P4 replace.
- **P7** A worker reports to main the moment it meets ambiguity or a failure, without waiting for its final report. The user on 2026-11-27: "신입도 신입 나름대로 촘촘한 보고를 해야 해. 실무 작업 중 ambigious하거나, 이런 메모리 압박처럼 실패를 경험하는 경우에 즉시 상급자에게 보고해야지." Triggers: an ambiguous instruction or target, a failed command or check, an abnormal exit, any system alert (memory pressure, a watchdog stop). Channel: `SendMessage` with `to: "main"`, which a background subagent can call; the worker then waits for main's reply before it goes on. Every brief carries this as its `Stop when:` default.
- **P8** Main can see a running worker's state and stop or redirect it at once. The user: "상급자가 현재 상황을 알아보고 신입을 즉시 중단하거나 할 수단도 필요한 거고." Existing means: the spawn result's `outputFile` and the worker's transcript for its current state, `SendMessage` to the worker to redirect it, `TaskStop` with its agent ID to halt it. Missing (to build): a system alert such as the resources mod's memory-pressure notice reaches main together with the list of running workers and the processes each started, so main can stop the right one; and a process a worker starts dies or freezes with that worker when `TaskStop` halts it, since `TaskStop` today ends the agent but not a job it detached (unverified).
- **P6** Durable agent knowledge goes into docs under `docs/src/`, found by `rg` over `docs/`, not into the auto-memory directory. The user on 2026-11-27: "니가 쓰는 메모리 툴은 99% 확률로 write만 하고 제대로 read retrieval 하는 꼴을 본적이 없어요;;; 제발 저장소 내부 문서로 기록하고 검색을 제대로 하자".
