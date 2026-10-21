import type { EngineInterface, Register, Timer, ToolSpec, ToolCallResult } from 'claude-code'
import type { Report, Unit } from '../types'
import {
  CHECKPOINTS, LAST, TOOL, budgetFor, budgetLine, calibrationFactor, crossed, dueAt,
  extensionSummary, isReport, mins, parseExtensions, parsePairs, projectedMin, reportText, statusText,
  type Extension, type Pair,
} from './budget'
import { AWAKE_DEF, AWAKE_TOOL, MAX_AWAKE_MIN, awakeFile, awakeUntil } from './awake'

// time-budget provides feedback on plans and estimates. Checkpoints and
// overruns add reminders to tool results; the model records added time with
// `extend`, and work continues while those reminders are shown.

const UNITS = { plugin: 'time-budget', key: 'units' } as const
const PARKED = { plugin: 'time-budget', key: 'parked' } as const
const STATUS_REFRESH_MS = 60_000

const GOAL = { plugin: 'time-budget', key: 'goal' } as const
const UNLIMITED_ENV = 'CLAUDE_TIME_BUDGET_UNLIMITED'
const GOAL_COMMAND = 'goal'
// The words `/goal` itself reads as a clear (the binary's set of them).
const GOAL_CLEAR_WORDS = new Set(['clear', 'stop', 'off', 'reset', 'none', 'cancel'])
// The daemon re-reads the deadline each minute, so a 30-minute lease refreshed
// every minute keeps the Mac up while the goal runs and lapses soon after a crash.
const GOAL_AWAKE_MIN = 30
const GOAL_AWAKE_REFRESH_MS = 60_000

const minutes = { type: 'number', exclusiveMinimum: 0 }
const TOOLS = [
  {
    name: 'estimate',
    description: 'Open a clm tracker task and estimate its duration, or pass task with an existing issue id to resume or refine that estimate. The result shows the calibrated budget, checkpoint reminders, and recent extension history.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { ...minutes, description: 'Your estimate for the whole task, in minutes' },
        scope: { type: 'string', description: 'What the task covers, in one line' },
        steps: { type: 'array', items: { type: 'string' }, description: 'The planned steps, in order' },
        task: { type: 'string', description: 'An existing clm issue id to resume' },
      },
      required: ['minutes', 'scope', 'steps'],
    },
  },
  {
    name: 'report',
    description: 'Record verified work, open items, and a finish-time projection. If more time is needed, call extend with the minutes and reason.',
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
    name: 'extend',
    description: 'Record extra time for your own unit and add those minutes to its current budget. Give a reason describing the remaining work or why the estimate was low.',
    inputSchema: {
      type: 'object',
      properties: {
        minutes: { ...minutes, description: 'Additional minutes to add to the current budget' },
        reason: { type: 'string', minLength: 1, description: 'What the extra time is for or why the estimate was low' },
      },
      required: ['minutes', 'reason'],
    },
  },
  {
    name: 'grant',
    description: 'Add minutes to a running subagent’s current budget after reviewing its report.',
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string', description: 'The subagent id its report names' }, minutes },
      required: ['agent_id', 'minutes'],
    },
  },
] satisfies ToolSpec[]

type Ctx = EngineInterface
type S = {
  units: Record<string, Unit>
  parked: Record<string, Unit>
  timers: Map<string, Timer>
  pairs?: Pair[]
  calibrationWrite?: Promise<void>
  extensions?: Extension[]
  extensionWrite?: Promise<void>
  refresh?: Timer
  envUnlimited: boolean
  /** The condition of the user's active `/goal`, null when none runs; it alone turns unlimited on. */
  goal: string | null
  /** Why the last goal ended, shown until the next one starts. */
  goalEnd?: string
  /** A goal_status row came after the main loop's last response: the evaluator let the turn end. */
  goalRowLast: boolean
  awake?: Timer
}

const isUnlimited = (s: S) => s.goal !== null || s.envUnlimited

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function log($: Ctx, text: string) {
  $.ui.log(`[time-budget] ${text}`, { to: 'debug' })
}

function toolError(text: string) {
  return { result: text, isError: true, text }
}

async function save($: Ctx, s: S) {
  try {
    await $.state.set(UNITS, structuredClone(s.units))
    await $.state.set(PARKED, structuredClone(s.parked))
  } catch (err) {
    log($, `state.set failed: ${errText(err)}`)
  }
}

function goalText(s: S): string | undefined {
  if (s.goal !== null) return `unlimited until goal: ${s.goal.length > 40 ? `${s.goal.slice(0, 39)}…` : s.goal}`
  if (s.goalEnd) return `${s.goalEnd}; ${s.envUnlimited ? `unlimited stays on (${UNLIMITED_ENV})` : 'unlimited off'}`
  return undefined
}

async function showStatus($: Ctx, s: S) {
  const u = mainEntry(s)?.[1]
  try {
    const parts = [u ? statusText(u, await $.clock.now()) : undefined, goalText(s)].filter(Boolean)
    $.ui.status(parts.length ? parts.join(' · ') : undefined)
  } catch (err) {
    log($, `ui.status failed: ${errText(err)}`)
  }
}

function mainEntry(s: S): [string, Unit] | undefined {
  return Object.entries(s.units).find(([, unit]) => unit.kind === 'main')
}

async function calibrationFile($: Ctx) {
  const dir = (await $.env.get('TIME_BUDGET_DIR')) ?? `${(await $.env.get('HOME')) ?? '.'}/.local/share/claude-time-budget`
  return `${dir}/calibration.jsonl`
}

async function extensionsFile($: Ctx) {
  const path = await calibrationFile($)
  return path.replace(/calibration\.jsonl$/, 'extensions.jsonl')
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

async function loadExtensions($: Ctx, s: S): Promise<Extension[]> {
  if (s.extensions) return s.extensions
  const path = await extensionsFile($)
  try {
    s.extensions = (await $.fs.exists(path)) ? parseExtensions((await $.fs.read(path)) as string) : []
  } catch (err) {
    log($, `cannot read ${path}: ${errText(err)}; extension history starts empty`)
    s.extensions = []
  }
  return s.extensions
}

async function appendJsonLine($: Ctx, path: string, value: unknown) {
  const line = JSON.stringify(value)
  const result = await $.process.run([
    'sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s\\n" "$1" >> "$2"', 'sh', line, path,
  ], { timeoutMs: 5_000 })
  if (result.exitCode !== 0) throw new Error(`append ${path} failed (${result.exitCode}): ${result.stderr}`)
}

// One pair per unit, logged when the unit closes; `end` is when its last turn ended.
async function logPair($: Ctx, s: S, u: Unit, end: number) {
  if (u.estimateMin === undefined || u.budgetMin === undefined) return
  const pair: Pair = {
    kind: u.kind, agent_type: u.agentType ?? null, estimate_min: u.estimateMin, budget_min: u.budgetMin,
    actual_min: Math.round(((end - u.start) / 60_000) * 100) / 100, at: Math.floor(end / 1000),
    extended_min: u.extendedMin ?? 0, extensions: u.extensions ?? 0,
  }
  const write = async () => {
    const path = await calibrationFile($)
    try {
      const existing = await loadPairs($, s)
      await appendJsonLine($, path, pair)
      s.pairs = [...existing, pair]
    } catch (err) {
      log($, `cannot append ${JSON.stringify(pair)} to ${path}: ${errText(err)}`)
    }
  }
  const pending = s.calibrationWrite ?? Promise.resolve()
  s.calibrationWrite = pending.catch(() => undefined).then(write)
  await s.calibrationWrite
}

async function appendExtension($: Ctx, s: S, record: Extension) {
  const write = async () => {
    const path = await extensionsFile($)
    try {
      const existing = await loadExtensions($, s)
      await appendJsonLine($, path, record)
      s.extensions = [...existing, record]
    } catch (err) {
      log($, `cannot append ${JSON.stringify(record)} to ${path}: ${errText(err)}`)
    }
  }
  const pending = s.extensionWrite ?? Promise.resolve()
  s.extensionWrite = pending.catch(() => undefined).then(write)
  await s.extensionWrite
}

function disarm(s: S, key: string) {
  s.timers.get(key)?.cancel()
  s.timers.delete(key)
}

// Moves the unit to the checkpoint the clock has reached; the timer and every tool call run it.
async function advance($: Ctx, s: S, key: string, now: number) {
  const u = s.units[key]
  if (!u || u.budgetMin === undefined) return
  const c = crossed(now - u.start, u.budgetMin)
  let changed = false
  if (c > u.fired) {
    u.fired = c
    if (c < LAST) u.reportDue = CHECKPOINTS[c - 1]!.label
    changed = true
  }
  if (!changed) return
  await save($, s)
  if (u.kind === 'main') await showStatus($, s)
}

async function arm($: Ctx, s: S, key: string) {
  disarm(s, key)
  const u = s.units[key]
  if (!u || u.budgetMin === undefined || u.fired >= LAST) return
  const delay = Math.max(0, u.start + dueAt(u.fired, u.budgetMin) - (await $.clock.now()))
  s.timers.set(key, $.clock.after(delay, () => {
    void (async () => {
      await advance($, s, key, await $.clock.now())
      await arm($, s, key)
    })().catch(err => log($, `checkpoint for ${key} failed: ${errText(err)}`))
  }))
}

async function closeMain($: Ctx, s: S, now: number, key = mainEntry(s)?.[0]) {
  if (!key) return
  const u = s.units[key]
  if (!u) return
  disarm(s, key)
  delete s.units[key]
  // Its clm issue can be resumed by id, so the start and budget it ran under are kept for that.
  if (u.kind === 'main') s.parked[key] = { ...u, calibrated: true }
  if (!u.calibrated) await logPair($, s, u, u.lastEnd ?? now)
}

async function syncMainTask($: Ctx, s: S, now: number) {
  const entry = mainEntry(s)
  if (!entry) return
  const [key] = entry
  try {
    const issue = (await $.clm.issues({ issue: key }))[0]
    if (issue?.status === 'done' || issue?.status === 'dropped') {
      await closeMain($, s, now, key)
      await save($, s)
    }
  } catch (err) {
    log($, `clm task status failed for ${key}: ${errText(err)}`)
  }
}

function unreadReports(s: S, now: number): string[] {
  const out: string[] = []
  for (const [id, u] of Object.entries(s.units)) {
    if (!u.unread || !u.report) continue
    u.unread = false
    out.push(`Subagent report (${u.agentType ?? 'subagent'} ${id}, ${mins(now - u.start)}/${Math.round(u.budgetMin ?? 0)} min):\n${reportText(u.report)}\nReview the remaining work and use ${TOOL.grant} {agent_id: "${id}", minutes} to add time when needed.`)
  }
  return out
}

function withFeedback<T extends ToolCallResult>(result: T, feedback: string[]): T {
  if (!feedback.length) return result
  if ('result' in result && typeof result.result === 'string')
    return { ...result, result: `${result.result}\n${feedback.join('\n')}` } as T
  return { ...result, context: [...(result.context ?? []), ...feedback] } as T
}

function withContext<T extends ToolCallResult>(result: T, context: string[]): T {
  if (!context.length) return result
  return { ...result, context: [...('context' in result ? result.context ?? [] : []), ...context] } as T
}

function overrunReason(unit: Unit, now: number): string | undefined {
  if (unit.budgetMin === undefined) return undefined
  const budget = unit.budgetMin
  if (now - unit.start >= budget * 60_000) return `${mins(now - unit.start)} min elapsed is beyond the ${Math.round(budget)} min budget`
  if (unit.report && unit.reportAt !== undefined) {
    const projected = projectedMin(unit.reportAt - unit.start, unit.report)
    if (projected > budget) return `the latest report projects ${Math.round(projected)} min against the ${Math.round(budget)} min budget`
  }
  return undefined
}

async function unitFeedback($: Ctx, s: S, unit: Unit | undefined, now: number, reportFiled = false): Promise<string[]> {
  if (!unit) return []
  let changed = false
  const through = Math.min(unit.fired, LAST - 1)
  const notes: string[] = []
  if (reportFiled) {
    if ((unit.lastNudge ?? 0) < through) {
      unit.lastNudge = through
      changed = true
    }
  } else if ((unit.lastNudge ?? 0) < through) {
    for (let index = unit.lastNudge ?? 0; index < through; index++) {
      const label = CHECKPOINTS[index]?.label
      if (label) notes.push(`Checkpoint ${label} is due. Record verified work and open items with ${TOOL.report}, then continue.`)
    }
    unit.lastNudge = through
    changed = true
  }

  const reason = isUnlimited(s) ? undefined : overrunReason(unit, now)
  const interval = (unit.budgetMin ?? 0) * 60_000 / 6
  if (reason && (unit.lastOverrunNudgeAt === undefined || now - unit.lastOverrunNudgeAt >= interval)) {
    notes.push(`Budget feedback: ${reason}. Record extra time with ${TOOL.extend} {minutes, reason} if more time is needed, then continue.`)
    unit.lastOverrunNudgeAt = now
    changed = true
  }
  if (changed) await save($, s)
  return notes
}

async function recordExtension(
  $: Ctx,
  s: S,
  unit: Unit,
  task: string,
  now: number,
  minutes: number,
  reason: string,
  source: Extension['source'],
  budgetBefore: number,
  budgetAfter: number,
  estimateMin = unit.estimateMin ?? 0,
) {
  const record: Extension = {
    at: Math.floor(now / 1000), kind: unit.kind, agent_type: unit.agentType ?? null, task,
    scope: unit.scope ?? '', estimate_min: estimateMin, budget_before: budgetBefore, budget_after: budgetAfter,
    minutes, elapsed_min: Math.round(((now - unit.start) / 60_000) * 100) / 100, reason, source,
  }
  if (source === 'extend' || source === 'grant') {
    unit.extendedMin = (unit.extendedMin ?? 0) + minutes
    unit.extensions = (unit.extensions ?? 0) + 1
  }
  await appendExtension($, s, record)
}

async function saveGoal($: Ctx, s: S) {
  try {
    await $.state.set(GOAL, s.goal)
  } catch (err) {
    log($, `state.set (goal) failed: ${errText(err)}`)
  }
}

function stopAwakeRefresh(s: S) {
  s.awake?.cancel()
  s.awake = undefined
}

/** Writes the deadline `minutes` from now, or removes it at 0; the stay_awake tool and the goal's refresh share it. Throws on failure. */
async function setAwake($: Ctx, minutes: number): Promise<number | undefined> {
  const until = awakeUntil(await $.clock.now(), minutes)
  const { dir, path } = awakeFile((await $.env.get('HOME')) ?? '.')
  try {
    if (until === undefined) {
      const rm = await $.process.run(['rm', '-f', path], { timeoutMs: 5_000 })
      if (rm.exitCode !== 0) throw new Error(`rm -f ${path} failed (${rm.exitCode}): ${rm.stderr}`)
      return undefined
    }
    const mk = await $.process.run(['mkdir', '-p', dir], { timeoutMs: 5_000 })
    if (mk.exitCode !== 0) throw new Error(`mkdir -p ${dir} failed (${mk.exitCode}): ${mk.stderr}`)
    await $.fs.write(path, `${until}\n`)
    return until
  } catch (err) {
    throw new Error(`could not update ${path}: ${errText(err)}`)
  }
}

async function refreshAwake($: Ctx) {
  try {
    await setAwake($, GOAL_AWAKE_MIN)
  } catch (err) {
    log($, `stay-awake refresh failed: ${errText(err)}`)
  }
}

async function startAwakeRefresh($: Ctx, s: S) {
  stopAwakeRefresh(s)
  await refreshAwake($)
  s.awake = $.clock.every(GOAL_AWAKE_REFRESH_MS, () => { void refreshAwake($) })
}

// The goal is over however it ended: nothing keeps the run going, so neither the mode nor the Mac stays up for it.
async function endGoal($: Ctx, s: S, reason: string) {
  if (s.goal === null) return
  s.goal = null
  s.goalEnd = reason
  s.goalRowLast = false
  stopAwakeRefresh(s)
  try {
    await setAwake($, 0)
  } catch (err) {
    log($, `stay-awake clear failed: ${errText(err)}`)
  }
  await saveGoal($, s)
  await showStatus($, s)
  try {
    $.ui.toast(`time-budget: ${goalText(s)}`)
  } catch (err) {
    log($, `ui.toast failed: ${errText(err)}`)
  }
}

export const register: Register = (on) => {
  const s: S = { units: {}, parked: {}, timers: new Map(), envUnlimited: false, goal: null, goalRowLast: false }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      const read = await $.state.get(UNITS)
      s.units = read.value ? { ...read.value } : {}
      const parked = await $.state.get(PARKED)
      s.parked = parked.value ? { ...parked.value } : {}
      s.goal = (await $.state.get(GOAL)).value ?? null
    } catch (err) {
      log($, `state.get failed: ${errText(err)}`)
    }
    s.envUnlimited = /^(1|true|on|yes)$/i.test((await $.env.get('CLAUDE_TIME_BUDGET_UNLIMITED')) ?? '')
    // The old prompt-scoped state used the literal key `main`; it cannot be tied to a clm issue.
    if (s.units.main?.kind === 'main') {
      disarm(s, 'main')
      delete s.units.main
      await save($, s)
    }
    for (const t of [...TOOLS, AWAKE_DEF]) {
      try {
        await $.tool.register(t)
      } catch (err) {
        log($, `tool.register(${t.name}) failed: ${errText(err)}`)
      }
    }
    for (const key of Object.keys(s.units)) await arm($, s, key)
    if (s.goal !== null) await startAwakeRefresh($, s)
    s.refresh?.cancel()
    s.refresh = $.clock.every(STATUS_REFRESH_MS, () => { void showStatus($, s) })
    await showStatus($, s)
    return started
  })

  on('session.end', async ($, e, next) => {
    stopAwakeRefresh(s)
    await closeMain($, s, await $.clock.now())
    await save($, s)
    return next(e)
  })

  on('command.run', { command: GOAL_COMMAND }, async ($, e, next) => {
    const args = e.args.trim()
    const clearWord = GOAL_CLEAR_WORDS.has(args.toLowerCase())
    const r = await next(e)
    const out = r.text ?? ''
    const cleared = clearWord || out.startsWith('Goal cleared') || out.startsWith('No goal set')
    if (cleared) {
      await endGoal($, s, `goal cleared by /${GOAL_COMMAND} ${args}`)
    } else if (out.startsWith('Goal set: ') || (!out && args)) {
      s.goal = out.startsWith('Goal set: ') ? out.slice('Goal set: '.length) : args
      s.goalEnd = undefined
      s.goalRowLast = false
      await saveGoal($, s)
      await startAwakeRefresh($, s)
    }
    return r
  })

  // The goal's evaluator writes a goal_status row after every check: one the
  // model answers was "not met", one the turn ends on was met, failed, or a
  // clear after an unrecoverable error. The row's payload is not on the event.
  on('session.append', ($, e, next) => {
    if (e.agentId === undefined && s.goal !== null) {
      if (e.message.type === 'attachment' && e.message.name === 'goal_status') s.goalRowLast = true
      else if (e.door === 'response') s.goalRowLast = false
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !e.isAborted && s.goal !== null && s.goalRowLast) await endGoal($, s, 'goal ended (met, failed, or cleared after an error)')
    const r = await next(e)
    const now = await $.clock.now()
    if (e.agentId) {
      const u = s.units[e.agentId]
      if (u) {
        disarm(s, e.agentId)
        delete s.units[e.agentId]
        await logPair($, s, u, now)
        await save($, s)
      }
      return r
    }
    await syncMainTask($, s, now)
    const u = mainEntry(s)?.[1]
    if (!u) return r
    u.lastEnd = now
    await save($, s)
    // The status line already shows the budget; a line under every answer becomes a focus-view notice row.
    if (u.budgetMin === undefined || (!u.reportDue && now - u.start < u.budgetMin * 60_000 && !overrunReason(u, now))) return r
    const head = `⏱ estimate ${u.estimateMin}m → ${statusText(u, now)}`
    const line = u.report ? `${head}\n${reportText(u.report)}` : head
    // A text other than the answer is shown beneath it; another plugin's line stays above ours.
    return { ...r, text: r.text === e.answer ? line : `${r.text}\n${line}` }
  })

  on('agent.spawn', async ($, e, next) => {
    const declared = budgetLine(e.prompt)
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

  on('tool.call', { tool: AWAKE_TOOL }, async ($, e) => {
    const key = e.agentId
    const main = key === undefined
    const now = await $.clock.now()
    if (main) await syncMainTask($, s, now)
    const unitKey = key ?? mainEntry(s)?.[0]
    const unit = unitKey ? s.units[unitKey] : undefined
    if (unit && unitKey) await advance($, s, unitKey, now)
    const feedback = async (result: ToolCallResult) => {
      const notes = await unitFeedback($, s, unit, now)
      const reports = main ? unreadReports(s, now) : []
      if (reports.length) await save($, s)
      return withContext(withFeedback(result, notes), reports)
    }
    const m = (e as unknown as Record<string, unknown>).minutes
    if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) return feedback(toolError(`Call ${AWAKE_TOOL} with minutes as a number from 0 to ${MAX_AWAKE_MIN}.`))
    let until
    try {
      until = await setAwake($, m)
    } catch (err) {
      return feedback(toolError(`stay_awake ${errText(err)}`))
    }
    if (until === undefined) return feedback({ result: 'Stay-awake cleared; the Mac may sleep with the lid closed again within a minute.' })
    const clamped = m > MAX_AWAKE_MIN ? ` (clamped from ${m} to ${MAX_AWAKE_MIN} min)` : ''
    return feedback({ result: `Staying awake until ${new Date(until * 1000).toISOString()} (epoch ${until})${clamped}; call again before then to extend.` })
  })

  on('tool.call', async ($, e, next) => {
    const key = e.agentId
    const main = key === undefined
    const now = await $.clock.now()
    // An agent id no spawn of ours named (the engine's own forks) runs ungated.
    if (main) await syncMainTask($, s, now)
    let unitKey = key ?? mainEntry(s)?.[0]
    let u = unitKey ? s.units[unitKey] : undefined
    if (u && unitKey) await advance($, s, unitKey, now)
    const args = e as unknown as Record<string, unknown>

    if (e.tool === TOOL.estimate) {
      const m = args.minutes
      if (typeof m !== 'number' || !Number.isFinite(m) || !(m > 0)) return toolError(`Call ${TOOL.estimate} with minutes as a positive number, scope as one line and steps as a list.`)
      const factor = calibrationFactor(await loadPairs($, s))
      const baseBudget = budgetFor(m, factor)
      const scope = typeof args.scope === 'string' ? args.scope : ''
      if (main) {
        const requested = args.task
        if (requested !== undefined && (typeof requested !== 'string' || !requested.trim()))
          return toolError(`Call ${TOOL.estimate} with task as an existing clm issue id when resuming one.`)
        const targetKey = typeof requested === 'string' ? requested : undefined
        let issue
        try {
          issue = await $.clm.track({ title: scope, status: 'doing', ...(targetKey ? { issue: targetKey } : {}) })
        } catch (err) {
          return toolError(`${TOOL.estimate}: ${errText(err)}`)
        }
        if (unitKey && unitKey !== issue.id) await closeMain($, s, now, unitKey)
        unitKey = issue.id
        u = s.units[unitKey]
        const parked = s.parked[unitKey]
        delete s.parked[unitKey]
        // A resumed task keeps its first start and calibration estimate.
        if (!u || u.kind !== 'main') u = s.units[unitKey] = parked
          ? { ...parked, lastEnd: undefined }
          : { kind: 'main', start: now, fired: 0 }
      } else {
        unitKey = key
        u = s.units[unitKey] ?? (s.units[unitKey] = { kind: 'sub', start: now, fired: 0 })
      }
      if (!u || !unitKey) return toolError(`Could not open a time-budget unit for ${TOOL.estimate}.`)
      const unit = u
      const first = unit.budgetMin === undefined
      const before = unit.budgetMin
      const extended = unit.extendedMin ?? 0
      const beforeBase = before === undefined ? undefined : before - extended
      const budget = baseBudget + extended
      if (first) unit.estimateMin = m
      unit.budgetMin = budget
      unit.scope = scope || undefined
      unit.steps = Array.isArray(args.steps) ? args.steps.filter((step): step is string => typeof step === 'string') : undefined
      if (before !== undefined && beforeBase !== undefined && baseBudget > beforeBase) {
        await recordExtension($, s, unit, unitKey, now, budget - before,
          `Estimate refined for ${scope || unit.scope || 'the task'}.`, 'reestimate', before, budget, m)
      }
      if (first) {
        unit.fired = crossed(now - unit.start, unit.budgetMin)
        unit.reportDue = undefined
        unit.lastNudge = 0
      } else {
        await advance($, s, unitKey, now)
      }
      await save($, s)
      await arm($, s, unitKey)
      if (main) await showStatus($, s)
      const at = CHECKPOINTS.slice(0, LAST - 1).map((c, i) => `${c.label} at ${mins(dueAt(i, unit.budgetMin!))}m`).join(', ')
      const history = extensionSummary(await loadPairs($, s), await loadExtensions($, s))
      const planFeedback = (unit.steps?.length ?? 0) <= 1 && m > 30 ? ' Plan feedback: split this estimate into smaller steps.' : ''
      const result = { result: `Budget ${Math.round(unit.budgetMin)} min (estimate ${m} min × calibration ${factor.toFixed(2)}, floor 15); ${mins(now - unit.start)} min elapsed. Reports are due at ${at}; the budget ends at ${Math.round(unit.budgetMin)}m. ${history}${planFeedback} Use this budget and the planned steps to guide the work.` }
      return withFeedback(result, await unitFeedback($, s, unit, now))
    }

    if (e.tool === TOOL.report) {
      if (!u || !unitKey) return toolError(`Call ${TOOL.estimate} to associate a report with a unit.`)
      if (!isReport(args)) return toolError(`Call ${TOOL.report} with done as [{item, check}], open as [{item, next}], and more_min as a number when open items need extra time.`)
      const report: Report = { done: args.done, open: args.open, ...(args.more_min !== undefined ? { more_min: args.more_min } : {}) }
      u.report = report
      u.reportAt = now
      u.reportDue = undefined
      if (!main) u.unread = true
      await advance($, s, unitKey, now)
      await save($, s)
      if (main) await showStatus($, s)
      const projection = projectedMin(now - u.start, report)
      const projected = Math.round(projection)
      const budgetNow = u.budgetMin
      const needsMore = budgetNow !== undefined && projection > budgetNow && (report.more_min ?? 0) > 0
      if (needsMore) {
        const reason = `Report projects ${projected} min for the remaining work: ${report.open.map(item => item.item).join(', ') || 'no open items listed'}.`
        await recordExtension($, s, u, unitKey, now, report.more_min!, reason, 'report', budgetNow!, budgetNow!)
      }
      const budgetText = budgetNow === undefined ? 'no estimate yet' : `${Math.round(budgetNow)} min`
      const extra = needsMore ? ` If you still need the requested extra time, call ${TOOL.extend} with minutes ${report.more_min} and a reason.` : ''
      const result = { result: `Report recorded: projected ${projected} min against ${budgetText}. Continue at the same depth; verification stays part of the work.${extra}` }
      return withFeedback(result, await unitFeedback($, s, u, now, true))
    }

    if (e.tool === TOOL.extend) {
      const extra = args.minutes
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (typeof extra !== 'number' || !Number.isFinite(extra) || !(extra > 0) || !reason)
        return toolError(`Call ${TOOL.extend} with positive minutes and a reason for the additional time.`)
      if (!u || !unitKey || u.budgetMin === undefined)
        return toolError(`Call ${TOOL.estimate} first so ${TOOL.extend} can add time to your unit's budget.`)
      const before = u.budgetMin
      const after = before + extra
      u.budgetMin = after
      u.lastOverrunNudgeAt = now
      u.fired = Math.max(u.fired, crossed(now - u.start, after))
      await recordExtension($, s, u, unitKey, now, extra, reason, 'extend', before, after)
      await save($, s)
      await arm($, s, unitKey)
      if (main) await showStatus($, s)
      const result = { result: `Added ${extra} min to this unit's budget; it is now ${Math.round(after)} min. Continue the task and report at the next checkpoint.` }
      return withFeedback(result, await unitFeedback($, s, u, now))
    }

    if (e.tool === TOOL.grant) {
      if (e.agentId) return toolError(`Use ${TOOL.extend} to add time to your own unit.`)
      const id = String(args.agent_id ?? '')
      const extra = args.minutes
      const sub = s.units[id]
      if (!sub || sub.kind === 'main' || sub.budgetMin === undefined) return toolError(`Call ${TOOL.grant} with the id of a running subagent that has a budget.`)
      if (typeof extra !== 'number' || !Number.isFinite(extra) || !(extra > 0)) return toolError(`Call ${TOOL.grant} with minutes as a positive number.`)
      const before = sub.budgetMin
      const after = before + extra
      sub.budgetMin = after
      sub.lastOverrunNudgeAt = now
      sub.fired = Math.max(sub.fired, crossed(now - sub.start, after))
      await recordExtension($, s, sub, id, now, extra, 'Main added time after reviewing the subagent report.', 'grant', before, after)
      await save($, s)
      await arm($, s, id)
      const result = { result: `Added ${extra} min to ${id}'s budget; it is now ${Math.round(after)} min.` }
      return withFeedback(result, await unitFeedback($, s, u, now))
    }

    const result = await next(e)
    if ('deny' in result && result.deny !== undefined) return result
    const feedback = await unitFeedback($, s, u, now)
    const reports = main ? unreadReports(s, now) : []
    if (reports.length) await save($, s)
    return withContext(result, [...feedback, ...reports])
  })
}
