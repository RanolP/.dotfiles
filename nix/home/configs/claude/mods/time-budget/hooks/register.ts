import type { EngineInterface, Register, Timer, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Report, Unit } from '../types'
import {
  CHECKPOINTS, GRACE_MS, LAST, TOOL, budgetFor, budgetLine, calibrationFactor, crossed, dueAt, extensionFrom, gate, haltReason,
  isReport, mins, parsePairs, projectedMin, reportText, statusText, type Pair,
} from './budget'

// time-budget: the user's rule, enforced rather than requested --
// "작업을 시작하기 전에 시간을 추정하고, 보고하라. 추정 시간 기준 1/3, 1/2, 2/3,
// 5/6 지점에 중간 보고하라. 추정 시간을 넘을 것 같다면 즉시 작업을 중단하고 보고하라."
//
// A unit is the main thread's task from a user prompt on (a "+Nm" reply
// continues it), or one subagent run. Its first tool call must be the estimate
// tool; at each checkpoint a timer marks a report due and every other tool
// waits on it; a report that projects past the budget, or the budget running
// out, denies every tool but the report, and GRACE_MS after 6/6 a main turn
// still running is aborted. A codex agent runs its shell inside codex where
// no gate reaches, so its spawner declares the estimate as the prompt's first
// line. The calibration history is time-budget.py's file, read and written in
// the same shape, one pair per unit.

const UNITS = { plugin: 'time-budget', key: 'units' } as const
const MAIN = 'main'
const CODEX = 'codex-subagent:'
const USER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])
const STATUS_REFRESH_MS = 60_000

const minutes = { type: 'number', exclusiveMinimum: 0 }
const TOOLS = [
  {
    name: 'estimate',
    description: 'Declare how long the task will take before any other tool call of the task. The harness scales the estimate by how far past estimates ran, shows the budget to the user, and asks for a report at 1/3, 1/2, 2/3 and 5/6 of it. Call it again to revise the estimate.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { ...minutes, description: 'Your estimate for the whole task, in minutes' },
        scope: { type: 'string', description: 'What the task covers, in one line' },
        steps: { type: 'array', items: { type: 'string' }, description: 'The planned steps, in order' },
      },
      required: ['minutes', 'scope', 'steps'],
    },
  },
  {
    name: 'report',
    description: 'File a progress report against the time budget: what is verified done, what is open, and the extra minutes the open items need. The harness projects the finish from it.',
    inputSchema: {
      type: 'object',
      properties: {
        done: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, check: { type: 'string', description: 'The check that proved it done' } }, required: ['item', 'check'] } },
        open: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, next: { type: 'string', description: 'The next action on it' } }, required: ['item', 'next'] } },
        more_min: { type: 'number', minimum: 0, description: 'Extra minutes the open items need beyond the budget' },
      },
      required: ['done', 'open'],
    },
  },
  {
    name: 'grant',
    description: 'Give a running subagent more minutes on its time budget, after reading its report.',
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string', description: 'The subagent id its report names' }, minutes },
      required: ['agent_id', 'minutes'],
    },
  },
] as const

type Ctx = EngineInterface
type S = {
  units: Record<string, Unit>
  timers: Map<string, Timer>
  handedBack: Map<string, boolean>
  runningTurn?: string
  pairs?: Pair[]
  refresh?: Timer
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function log($: Ctx, text: string) {
  $.ui.log(`[time-budget] ${text}`, { to: 'debug' })
}

async function save($: Ctx, s: S) {
  try {
    await $.state.set(UNITS, JSON.parse(JSON.stringify(s.units)) as Record<string, Unit>)
  } catch (err) {
    log($, `state.set failed: ${errText(err)}`)
  }
}

async function showStatus($: Ctx, s: S) {
  const u = s.units[MAIN]
  try {
    $.ui.status(u ? statusText(u, await $.clock.now()) : undefined)
  } catch (err) {
    log($, `ui.status failed: ${errText(err)}`)
  }
}

async function calibrationFile($: Ctx) {
  const dir = (await $.env.get('TIME_BUDGET_DIR')) ?? `${(await $.env.get('HOME')) ?? '.'}/.local/share/claude-time-budget`
  return `${dir}/calibration.jsonl`
}

async function loadPairs($: Ctx, s: S): Promise<Pair[]> {
  if (s.pairs) return s.pairs
  const path = await calibrationFile($)
  try {
    s.pairs = (await $.fs.exists(path)) ? parsePairs((await $.fs.read(path)) as string) : []
  } catch (err) {
    log($, `cannot read ${path}: ${errText(err)}; calibration falls back to 1.0`)
    s.pairs = []
  }
  return s.pairs
}

// One pair per unit, logged when the unit closes; `end` is when its last turn ended.
async function logPair($: Ctx, s: S, u: Unit, end: number) {
  if (u.estimateMin === undefined || u.budgetMin === undefined) return
  const pair: Pair = {
    kind: u.kind, agent_type: u.agentType ?? null, estimate_min: u.estimateMin, budget_min: u.budgetMin,
    actual_min: Math.round(((end - u.start) / 60_000) * 100) / 100, at: Math.floor(end / 1000),
  }
  const path = await calibrationFile($)
  try {
    const prev = (await $.fs.exists(path)) ? ((await $.fs.read(path)) as string) : ''
    await $.fs.write(path, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}${JSON.stringify(pair)}\n`)
    ;(await loadPairs($, s)).push(pair)
  } catch (err) {
    log($, `cannot append ${JSON.stringify(pair)} to ${path}: ${errText(err)}`)
  }
}

function disarm(s: S, key: string) {
  s.timers.get(key)?.cancel()
  s.timers.delete(key)
}

// A main turn still running GRACE_MS after the stop has had its chance to report.
function armAbort($: Ctx, s: S) {
  $.clock.after(GRACE_MS, () => {
    const turnId = s.runningTurn
    if (!s.units[MAIN]?.halted || !turnId) return
    $.turn.abort({ turnId }).catch(err => log($, `turn.abort(${turnId}) failed: ${errText(err)}`))
  })
}

// Moves the unit to the checkpoint the clock has reached; the timer and every tool call run it.
async function advance($: Ctx, s: S, key: string, now: number) {
  const u = s.units[key]
  if (!u || u.budgetMin === undefined || u.halted) return
  const c = crossed(now - u.start, u.budgetMin)
  let changed = false
  if (c > u.fired) {
    u.fired = c
    if (c < LAST) u.reportDue = CHECKPOINTS[c - 1]!.label
    changed = true
  }
  const reason = haltReason(u, now)
  if (reason) {
    u.halted = reason
    u.haltedAt = now
    u.reportDue = undefined
    if (key === MAIN) armAbort($, s)
    changed = true
  }
  if (!changed) return
  await save($, s)
  if (key === MAIN) await showStatus($, s)
}

async function arm($: Ctx, s: S, key: string) {
  disarm(s, key)
  const u = s.units[key]
  if (!u || u.budgetMin === undefined || u.halted || u.fired >= LAST) return
  const delay = Math.max(0, u.start + dueAt(u.fired, u.budgetMin) - (await $.clock.now()))
  s.timers.set(key, $.clock.after(delay, () => {
    void (async () => {
      await advance($, s, key, await $.clock.now())
      await arm($, s, key)
    })().catch(err => log($, `checkpoint for ${key} failed: ${errText(err)}`))
  }))
}

async function closeMain($: Ctx, s: S, now: number) {
  const u = s.units[MAIN]
  if (!u) return
  disarm(s, MAIN)
  delete s.units[MAIN]
  await logPair($, s, u, u.lastEnd ?? now)
}

const openMain = (s: S, now: number): Unit => (s.units[MAIN] = { kind: 'main', start: now, fired: 0 })

function unreadReports(s: S, now: number): string[] {
  const out: string[] = []
  for (const [id, u] of Object.entries(s.units)) {
    if (!u.unread || !u.report) continue
    u.unread = false
    out.push(`Subagent report (${u.agentType ?? 'subagent'} ${id}, ${mins(now - u.start)}/${Math.round(u.budgetMin ?? 0)} min${u.halted ? `, stopped: ${u.halted}` : ''}):\n${reportText(u.report)}\nGrant it time with ${TOOL.grant} {agent_id: "${id}", minutes}, or narrow its scope with SendMessage.`)
  }
  return out
}

export const register: Register = (on) => {
  const s: S = { units: {}, timers: new Map(), handedBack: new Map() }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      const read = await $.state.get(UNITS)
      s.units = read.value ? { ...read.value } : {}
    } catch (err) {
      log($, `state.get failed: ${errText(err)}`)
    }
    for (const t of TOOLS) {
      try {
        await $.tool.register({ ...t, inputSchema: t.inputSchema as unknown as Record<string, unknown> })
      } catch (err) {
        log($, `tool.register(${t.name}) failed: ${errText(err)}`)
      }
    }
    for (const key of Object.keys(s.units)) await arm($, s, key)
    s.refresh?.cancel()
    s.refresh = $.clock.every(STATUS_REFRESH_MS, () => { void showStatus($, s) })
    await showStatus($, s)
    return started
  })

  on('session.end', async ($, e, next) => {
    await closeMain($, s, await $.clock.now())
    await save($, s)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // A prompt typed into a running turn, or one the user did not type, belongs to the unit already running.
    if (e.turnId || !USER_ORIGINS.has(e.origin.kind)) return next(e)
    const now = await $.clock.now()
    const u = s.units[MAIN]
    const extra = extensionFrom(e.text)
    let note: string
    if (u && u.budgetMin !== undefined && extra !== undefined) {
      u.budgetMin += extra
      u.halted = undefined
      u.haltedAt = undefined
      u.reportDue = undefined
      u.fired = crossed(now - u.start, u.budgetMin)
      note = `The user's reply continues the timed task on the same clock: +${extra} min, budget now ${Math.round(u.budgetMin)} min (${mins(now - u.start)} min elapsed).`
      await arm($, s, MAIN)
    } else {
      await closeMain($, s, now)
      openMain(s, now)
      note = `Before your first tool call of this task, call ${TOOL.estimate} with minutes, scope and steps.`
    }
    await save($, s)
    await showStatus($, s)
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('turn.start', async ($, e, next) => {
    s.runningTurn = e.turnId
    if (!s.units[MAIN]) {
      openMain(s, await $.clock.now())
      await save($, s)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    if (e.agentId) {
      const u = s.units[e.agentId]
      if (u) {
        disarm(s, e.agentId)
        s.handedBack.delete(e.agentId)
        delete s.units[e.agentId]
        await logPair($, s, u, now)
        await save($, s)
      }
      return r
    }
    if (s.runningTurn === e.turnId) s.runningTurn = undefined
    const u = s.units[MAIN]
    if (!u) return r
    u.lastEnd = now
    await save($, s)
    if (u.budgetMin === undefined) return r
    const head = `⏱ estimate ${u.estimateMin}m → ${statusText(u, now)}`
    const line = u.report ? `${head}\n${reportText(u.report)}` : head
    // A text other than the answer is shown beneath it; another plugin's line stays above ours.
    return { ...r, text: r.text === e.answer ? line : `${r.text}\n${line}` }
  })

  on('agent.spawn', async ($, e, next) => {
    const codex = e.subagentType.startsWith(CODEX)
    const declared = budgetLine(e.prompt)
    if (codex && declared === undefined) {
      return { deny: `Start the prompt with the line "Budget: <N> min", N being your estimate in minutes for this ${e.subagentType} task, then call Agent again. Codex runs its own shell where no estimate gate reaches it, so the spawner's line is its budget.` }
    }
    const r = await next(e)
    if (!r.agentId) return r
    const now = await $.clock.now()
    const u: Unit = { kind: 'sub', agentType: e.subagentType, start: now, fired: 0 }
    if (declared !== undefined) {
      u.estimateMin = declared
      u.budgetMin = budgetFor(declared, calibrationFactor(await loadPairs($, s)))
    }
    s.units[r.agentId] = u
    await save($, s)
    await arm($, s, r.agentId)
    return r
  })

  on('tool.call', async ($, e, next) => {
    const key = e.agentId ?? MAIN
    const now = await $.clock.now()
    // An agent id no spawn of ours named (the engine's own forks) runs ungated.
    if (!s.units[key] && key === MAIN) openMain(s, now)
    const u = s.units[key]
    if (u) await advance($, s, key, now)
    const args = e as unknown as Record<string, unknown>

    if (e.tool === TOOL.estimate) {
      const m = args.minutes
      if (typeof m !== 'number' || !(m > 0)) return { deny: `Call ${TOOL.estimate} with minutes as a positive number, scope as one line and steps as a list.` }
      const unit = s.units[key] ?? (s.units[key] = { kind: 'sub', start: now, fired: 0 })
      const factor = calibrationFactor(await loadPairs($, s))
      unit.estimateMin = m
      unit.budgetMin = budgetFor(m, factor)
      unit.scope = typeof args.scope === 'string' ? args.scope : undefined
      unit.steps = Array.isArray(args.steps) ? args.steps.filter((s): s is string => typeof s === 'string') : undefined
      unit.fired = crossed(now - unit.start, unit.budgetMin)
      unit.reportDue = undefined
      await save($, s)
      await arm($, s, key)
      if (key === MAIN) await showStatus($, s)
      const at = CHECKPOINTS.slice(0, LAST - 1).map((c, i) => `${c.label} at ${mins(dueAt(i, unit.budgetMin!))}m`).join(', ')
      return { result: `Budget ${Math.round(unit.budgetMin)} min (estimate ${m} min × calibration ${factor.toFixed(2)}, floor 15); ${mins(now - unit.start)} min elapsed. Reports are due at ${at}; the budget ends at ${Math.round(unit.budgetMin)}m. State this budget and the steps to the user in your reply as you start.` }
    }

    const denied = gate(u, e.tool, now)
    if (denied) return denied

    if (e.tool === TOOL.report) {
      if (!u) return { deny: `Call ${TOOL.estimate} first; a report measures against its budget.` }
      if (!isReport(args)) return { deny: `Call ${TOOL.report} with done as [{item, check}], open as [{item, next}], and more_min as a number of minutes when the open items need more time.` }
      const report: Report = { done: args.done, open: args.open, ...(args.more_min !== undefined ? { more_min: args.more_min } : {}) }
      u.report = report
      u.reportAt = now
      u.reportDue = undefined
      if (key !== MAIN) u.unread = true
      await advance($, s, key, now)
      await save($, s)
      if (key === MAIN) await showStatus($, s)
      const projected = Math.round(projectedMin(now - u.start, report))
      if (u.halted) {
        const close = key === MAIN
          ? 'End the turn now with this report and the extra minutes you ask for; the user continues by replying "+<N>m".'
          : `End your run now: call SubagentHandback with this report; main reads it and can grant time.`
        return { result: `Report recorded. Stop here: ${u.halted}. ${close}` }
      }
      return { result: `Report recorded: projected ${projected} of ${Math.round(u.budgetMin!)} min. Continue at the same depth; verification stays part of the work.` }
    }

    if (e.tool === TOOL.grant) {
      if (e.agentId) return { deny: `Ask the main thread for time: put more_min in your ${TOOL.report} call.` }
      const id = String(args.agent_id ?? '')
      const extra = args.minutes
      const sub = s.units[id]
      if (!sub || sub.budgetMin === undefined) return { deny: `Call ${TOOL.grant} with the agent_id of a running subagent that has a budget (one of: ${Object.keys(s.units).filter(k => k !== MAIN).join(', ') || 'none'}).` }
      if (typeof extra !== 'number' || !(extra > 0)) return { deny: `Call ${TOOL.grant} with minutes as a positive number.` }
      sub.budgetMin += extra
      sub.halted = undefined
      sub.haltedAt = undefined
      sub.reportDue = undefined
      sub.fired = crossed(now - sub.start, sub.budgetMin)
      await save($, s)
      await arm($, s, id)
      return { result: `Granted +${extra} min to ${id}; its budget is now ${Math.round(sub.budgetMin)} min.` }
    }

    const r = await next(e)
    if (key !== MAIN || 'deny' in r && r.deny !== undefined) return r
    const reports = unreadReports(s, now)
    if (!reports.length) return r
    await save($, s)
    return { ...r, context: [...(r.context ?? []), ...reports] } as typeof r
  })

  // A Claude subagent that keeps stepping GRACE_MS after its stop hands back
  // the harness's report instead of making another request. A codex agent's
  // steps are codex-subagent's to answer, so it is left to the tool gate.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    const u = id ? s.units[id] : undefined
    if (!id || !u?.halted || u.agentType?.startsWith(CODEX)) return yield* next(e)
    const now = await $.clock.now()
    if (now - (u.haltedAt ?? now) < GRACE_MS) return yield* next(e)
    const text = `Stopped by the time budget: ${u.halted} (${mins(now - u.start)}/${Math.round(u.budgetMin ?? 0)} min).\n${u.report ? reportText(u.report) : 'No report was filed.'}`
    if (s.handedBack.get(id)) return yield* endTurn(e, text)
    s.handedBack.set(id, true)
    const toolUseId = `toolu_time_budget_${id.replace(/[^A-Za-z0-9_-]/g, '_')}_${e.index}`
    const input = { message: text }
    yield { kind: 'tool', index: 0, id: toolUseId, name: 'SubagentHandback' }
    yield { kind: 'input', index: 0, json: JSON.stringify(input) }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'SubagentHandback', input }], stopReason: 'tool_use', usage: null } satisfies TurnStepResult
  })
}

async function* endTurn(e: { turnId: string; index: number }, text: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  yield { kind: 'text', index: 0, text }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
}
