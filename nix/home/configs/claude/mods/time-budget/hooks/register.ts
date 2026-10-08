import type { EngineInterface, Register, Timer, TurnStepChunk, TurnStepResult } from 'claude-code'
import type { Report, Unit } from '../types'
import {
  CHECKPOINTS, GRACE_MS, LAST, MAX_RESUMES, TOOL, budgetFor, budgetLine, calibrationFactor, crossed, dueAt, gate, haltReason,
  isReport, mins, parsePairs, projectedMin, reportText, statusText, type Pair,
} from './budget'

// time-budget: the user's rule, enforced rather than requested --
// "작업을 시작하기 전에 시간을 추정하고, 보고하라. 추정 시간 기준 1/3, 1/2, 2/3,
// 5/6 지점에 중간 보고하라. 추정 시간을 넘을 것 같다면 즉시 작업을 중단하고 보고하라."
//
// A unit is one clm tracker task on the main thread, or one subagent run. A
// main thread with no doing task is ungated; once a task has a budget, each
// checkpoint marks a report due and every other tool waits on it. A report
// that projects past the budget, or the budget running out, denies every tool
// but the report, and GRACE_MS after 6/6 a main turn still running is aborted.
// The calibration history is time-budget.py's file, read and written in the
// same shape, one pair per unit.

const UNITS = { plugin: 'time-budget', key: 'units' } as const
const PARKED = { plugin: 'time-budget', key: 'parked' } as const
const CODEX = 'codex-subagent:'
const MAIN_ABORT = 'main-abort'
const STATUS_REFRESH_MS = 60_000

// Unlimited mode is the user's unattended run ("맥북 꺼두고 자동사냥하고 싶음"):
// no budget stops the work, and a turn that ends with clm tasks still open is
// resumed by a plugin prompt, up to MAX_RESUMES in a row without the user.
const UNLIMITED = { plugin: 'time-budget', key: 'unlimited' } as const
const RESUMES = { plugin: 'time-budget', key: 'resumes' } as const
const UNLIMITED_ENV = 'CLAUDE_TIME_BUDGET_UNLIMITED'
const UNLIMITED_COMMAND = 'budget-unlimited'
const OPEN_STATUSES = new Set(['todo', 'doing'])

const minutes = { type: 'number', exclusiveMinimum: 0 }
const TOOLS = [
  {
    name: 'estimate',
    description: 'Open a new clm tracker task and declare how long it will take, or pass task with an existing issue id to resume or re-estimate that task. The harness scales the estimate by how far past estimates ran, shows the budget to the user, and asks for a report at 1/3, 1/2, 2/3 and 5/6 of it.',
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
    description: 'Give a running subagent more minutes from now on its time budget, after reading its report.',
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
  parked: Record<string, Unit>
  timers: Map<string, Timer>
  handedBack: Map<string, boolean>
  extending: Set<string>
  runningTurn?: string
  pairs?: Pair[]
  calibrationWrite?: Promise<void>
  refresh?: Timer
  unlimited: boolean
  envUnlimited: boolean
  resumes: number
}

const isUnlimited = (s: S) => s.unlimited || s.envUnlimited

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

function log($: Ctx, text: string) {
  $.ui.log(`[time-budget] ${text}`, { to: 'debug' })
}

async function save($: Ctx, s: S) {
  try {
    await $.state.set(UNITS, structuredClone(s.units))
    await $.state.set(PARKED, structuredClone(s.parked))
  } catch (err) {
    log($, `state.set failed: ${errText(err)}`)
  }
}

async function showStatus($: Ctx, s: S) {
  const u = mainEntry(s)?.[1]
  try {
    $.ui.status(u ? statusText(u, await $.clock.now()) : undefined)
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
    actual_min: Math.round(((end - u.start - (u.pausedMs ?? 0)) / 60_000) * 100) / 100, at: Math.floor(end / 1000),
  }
  const write = async () => {
    const path = await calibrationFile($)
    try {
      const prev = (await $.fs.exists(path)) ? ((await $.fs.read(path)) as string) : ''
      const existing = parsePairs(prev)
      const next = [...existing, pair]
      const text = `${next.map(p => JSON.stringify(p)).join('\n')}\n`
      // A random temp avoids same-second collisions; separate sessions can still lose an update between read and rename.
      const temp = `${path}.tmp-${pair.at}-${Math.random().toString(36).slice(2)}`
      await $.fs.write(temp, text)
      const moved = await $.process.run(['mv', temp, path], { timeoutMs: 5_000 })
      if (moved.exitCode !== 0) throw new Error(`mv ${temp} ${path} failed (${moved.exitCode}): ${moved.stderr}`)
      s.pairs = next
    } catch (err) {
      log($, `cannot append ${JSON.stringify(pair)} to ${path}: ${errText(err)}`)
    }
  }
  const pending = s.calibrationWrite ?? Promise.resolve()
  s.calibrationWrite = pending.catch(() => undefined).then(write)
  await s.calibrationWrite
}

function disarm(s: S, key: string) {
  s.timers.get(key)?.cancel()
  s.timers.delete(key)
}

function resume(s: S, key: string, u: Unit) {
  disarm(s, key)
  if (u.kind === 'main') disarm(s, MAIN_ABORT)
  s.handedBack.delete(key)
  u.halted = undefined
  u.haltedAt = undefined
  u.reportDue = undefined
  u.report = undefined
  u.reportAt = undefined
  u.unread = undefined
}

// A main turn still running GRACE_MS after the stop has had its chance to report.
function armAbort($: Ctx, s: S, key: string) {
  disarm(s, MAIN_ABORT)
  if (isUnlimited(s)) return
  s.timers.set(MAIN_ABORT, $.clock.after(GRACE_MS, () => {
    const turnId = s.runningTurn
    if (isUnlimited(s) || !s.units[key]?.halted || !turnId) return
    $.turn.abort({ turnId }).catch(err => log($, `turn.abort(${turnId}) failed: ${errText(err)}`))
  }))
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
  const reason = haltReason(u, now, isUnlimited(s))
  if (reason) {
    u.halted = reason
    u.haltedAt = now
    u.reportDue = undefined
    if (u.kind === 'main') armAbort($, s, key)
    changed = true
  }
  if (!changed) return
  await save($, s)
  if (u.kind === 'main') await showStatus($, s)
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

async function closeMain($: Ctx, s: S, now: number, key = mainEntry(s)?.[0]) {
  if (!key) return
  const u = s.units[key]
  if (!u) return
  disarm(s, key)
  if (u.kind === 'main') disarm(s, MAIN_ABORT)
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

function extend(s: S, key: string, u: Unit, extra: number, now: number): boolean {
  if (u.budgetMin === undefined) return false
  u.pausedMs = (u.pausedMs ?? 0) + Math.max(0, now - (u.lastEnd ?? now))
  const fromNow = (now - u.start) / 60_000 + extra
  // A halted unit restarts from now; a running one is never shortened by a grant.
  u.budgetMin = u.halted ? fromNow : Math.max(u.budgetMin, fromNow)
  resume(s, key, u)
  u.fired = crossed(now - u.start, u.budgetMin)
  return true
}

async function extendMain($: Ctx, s: S, extra: number): Promise<boolean> {
  const entry = mainEntry(s)
  if (!entry) return false
  const [key, u] = entry
  if (!u.halted || u.budgetMin === undefined || s.extending.has(key)) return false
  s.extending.add(key)
  const halted = u.halted
  u.halted = 'extension in progress'
  try {
    const now = await $.clock.now()
    const extended = extend(s, key, u, extra, now)
    if (!extended) {
      u.halted = halted
      return false
    }
    await save($, s)
    await arm($, s, key)
    await showStatus($, s)
    return true
  } catch (err) {
    u.halted = halted
    throw err
  } finally {
    s.extending.delete(key)
  }
}

function extensionMinutes(u: Unit): number[] {
  const asked = u.report?.more_min
  return [...new Set([10, 20, 30, ...(asked && asked > 0 ? [asked] : [])])]
}

function unreadReports(s: S, now: number): string[] {
  const out: string[] = []
  for (const [id, u] of Object.entries(s.units)) {
    if (!u.unread || !u.report) continue
    u.unread = false
    out.push(`Subagent report (${u.agentType ?? 'subagent'} ${id}, ${mins(now - u.start)}/${Math.round(u.budgetMin ?? 0)} min${u.halted ? `, stopped: ${u.halted}` : ''}):\n${reportText(u.report)}\nGrant it time with ${TOOL.grant} {agent_id: "${id}", minutes}, or narrow its scope with SendMessage.`)
  }
  return out
}

async function saveLoop($: Ctx, s: S) {
  try {
    await $.state.set(UNLIMITED, s.unlimited)
    await $.state.set(RESUMES, s.resumes)
  } catch (err) {
    log($, `state.set (unlimited) failed: ${errText(err)}`)
  }
}

// Turning unlimited on lifts every stop already in force, and the abort waiting on it.
async function liftHalts($: Ctx, s: S) {
  const now = await $.clock.now()
  for (const [key, u] of Object.entries(s.units)) {
    if (!u.halted || u.budgetMin === undefined) continue
    resume(s, key, u)
    u.fired = crossed(now - u.start, u.budgetMin)
    await arm($, s, key)
  }
  disarm(s, MAIN_ABORT)
  await save($, s)
  await showStatus($, s)
}

// At a main turn's end in unlimited mode: queue a resume prompt while clm work is open.
async function autoResume($: Ctx, s: S) {
  if (!isUnlimited(s) || s.resumes >= MAX_RESUMES) return
  let open
  try {
    open = (await $.clm.issues()).filter(i => OPEN_STATUSES.has(i.status))
  } catch (err) {
    log($, `clm.issues failed, no auto-resume: ${errText(err)}`)
    return
  }
  if (!open.length) return
  s.resumes++
  await saveLoop($, s)
  const list = open.map(i => `- ${i.id} [${i.status}] ${i.title}`).join('\n')
  const text = `Unlimited mode, auto-resume ${s.resumes}/${MAX_RESUMES}: the user is away and these clm tasks are still open. Continue them now, verify each before marking it done, and mark a task dropped if it cannot be finished without the user.\n${list}`
  // The prompt starts its own turn once the session is idle, so awaiting it here would hold this turn's end.
  void $.prompt.submit({ text }).catch(err => log($, `auto-resume submit failed: ${errText(err)}`))
}

export const register: Register = (on) => {
  const s: S = { units: {}, parked: {}, timers: new Map(), handedBack: new Map(), extending: new Set(), unlimited: false, envUnlimited: false, resumes: 0 }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      const read = await $.state.get(UNITS)
      s.units = read.value ? { ...read.value } : {}
      const parked = await $.state.get(PARKED)
      s.parked = parked.value ? { ...parked.value } : {}
      s.unlimited = (await $.state.get(UNLIMITED)).value === true
      s.resumes = (await $.state.get(RESUMES)).value ?? 0
    } catch (err) {
      log($, `state.get failed: ${errText(err)}`)
    }
    s.envUnlimited = /^(1|true|on|yes)$/i.test((await $.env.get('CLAUDE_TIME_BUDGET_UNLIMITED')) ?? '')
    try {
      await $.command.register({
        name: UNLIMITED_COMMAND,
        description: `on|off: unattended mode. No time budget stops the work, and a turn that ends with clm tasks open is resumed automatically, up to ${MAX_RESUMES} times in a row until you type a prompt. ${UNLIMITED_ENV}=1 in the environment turns it on too.`,
        immediate: true,
      })
    } catch (err) {
      log($, `command.register(${UNLIMITED_COMMAND}) failed: ${errText(err)}`)
    }
    // The old prompt-scoped state used the literal key `main`; it cannot be tied to a clm issue.
    if (s.units.main?.kind === 'main') {
      disarm(s, 'main')
      disarm(s, MAIN_ABORT)
      delete s.units.main
      await save($, s)
    }
    for (const t of TOOLS) {
      try {
        await $.tool.register({ ...t, inputSchema: t.inputSchema as unknown as Record<string, unknown> })
      } catch (err) {
        log($, `tool.register(${t.name}) failed: ${errText(err)}`)
      }
    }
    for (const key of Object.keys(s.units)) await arm($, s, key)
    if (isUnlimited(s)) await liftHalts($, s)
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

  on('turn.start', async ($, e, next) => {
    s.runningTurn = e.turnId
    return next(e)
  })

  on('command.run', { command: UNLIMITED_COMMAND }, async ($, e) => {
    const arg = (e.args ?? '').trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      s.unlimited = arg === 'on'
      s.resumes = 0
      await saveLoop($, s)
      if (isUnlimited(s)) await liftHalts($, s)
    } else if (arg) {
      return { text: `Usage: /${UNLIMITED_COMMAND} on|off (or ${UNLIMITED_ENV}=1 in the environment)` }
    }
    const env = s.envUnlimited ? ` ${UNLIMITED_ENV} is set, so it stays on until that is unset.` : ''
    return { text: isUnlimited(s)
      ? `Unlimited mode is on: no time budget stops the work, and a turn ending with clm tasks open is resumed automatically (${s.resumes}/${MAX_RESUMES} in a row so far).${env}`
      : 'Unlimited mode is off: the time budget stops the work as usual.' }
  })

  // The user's own prompt ends a run of auto-resumes; a plugin's (ours included) does not.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'plugin' && e.origin.kind !== 'unclassified' && s.resumes !== 0) {
      s.resumes = 0
      await saveLoop($, s)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const entry = mainEntry(s)
    const u = entry?.[1]
    if (!u?.halted || isUnlimited(s) || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const buttons = extensionMinutes(u).map(extra => Button({
      key: `time-budget:+${extra}m`,
      label: `+${extra}m`,
      onPress: () => {
        void (async () => {
          if (await extendMain($, s, extra)) await $.prompt.submit({ text: 'Continue this task.', asUser: true })
        })().catch(err => log($, `extension +${extra}m failed: ${errText(err)}`))
      },
    }))
    return Box({
      gap: 1,
      children: [Text({ children: `Time budget stopped: ${u.halted}` }), ...buttons],
    })
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
    await syncMainTask($, s, now)
    // An aborted turn is the user's Esc, which the loop leaves alone.
    if (!e.isAborted) await autoResume($, s)
    const u = mainEntry(s)?.[1]
    if (!u) return r
    u.lastEnd = now
    await save($, s)
    // The status line already shows the budget; a line under every answer becomes a focus-view notice row.
    if (u.budgetMin === undefined || !(u.halted || u.reportDue)) return r
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
      if (typeof m !== 'number' || !(m > 0)) return { deny: `Call ${TOOL.estimate} with minutes as a positive number, scope as one line and steps as a list.` }
      const factor = calibrationFactor(await loadPairs($, s))
      const budget = budgetFor(m, factor)
      const scope = typeof args.scope === 'string' ? args.scope : ''
      if (main) {
        const requested = args.task
        if (requested !== undefined && (typeof requested !== 'string' || !requested.trim()))
          return { deny: `Call ${TOOL.estimate} with task as an existing clm issue id when resuming one.` }
        const targetKey = typeof requested === 'string' ? requested : undefined
        // Opening, switching or raising a task would bypass the stop, the due report, or the user's extension buttons.
        if (u?.halted) return { deny: `Stop here: ${u.halted}. Call ${TOOL.report}, then end the turn; the user extends with a button above the prompt.` }
        if (u?.reportDue && targetKey !== unitKey) return { deny: `Checkpoint ${u.reportDue}: call ${TOOL.report} before opening or re-estimating a task.` }
        const prior = targetKey === undefined ? undefined : targetKey === unitKey ? u : s.parked[targetKey]
        if (prior?.budgetMin !== undefined && budget > prior.budgetMin)
          return { deny: `The budget of ${Math.round(prior.budgetMin)} min only grows by the user's extension button; put more_min in your ${TOOL.report} call and the button appears when it projects past the budget.` }
        let issue
        try {
          issue = await $.clm.track({ title: scope, status: 'doing', ...(targetKey ? { issue: targetKey } : {}) })
        } catch (err) {
          return { deny: `${TOOL.estimate}: ${errText(err)}` }
        }
        if (unitKey && unitKey !== issue.id) await closeMain($, s, now, unitKey)
        unitKey = issue.id
        u = s.units[unitKey]
        const parked = s.parked[unitKey]
        delete s.parked[unitKey]
        // A resumed task keeps its first start and budget; a lower estimate applies below.
        if (!u || u.kind !== 'main') u = s.units[unitKey] = parked
          ? { ...parked, lastEnd: undefined }
          : { kind: 'main', start: now, fired: 0 }
      } else {
        unitKey = key
        u = s.units[unitKey] ?? (s.units[unitKey] = { kind: 'sub', start: now, fired: 0 })
        if (u.budgetMin !== undefined && budget > u.budgetMin)
          return { deny: `Put more_min in your ${TOOL.report} call; main can grant time.` }
      }
      if (!u || !unitKey) return { deny: `Could not open a time-budget unit for ${TOOL.estimate}.` }
      const unit = u
      const first = unit.budgetMin === undefined
      if (first) unit.estimateMin = m
      unit.budgetMin = budget
      unit.scope = scope || undefined
      unit.steps = Array.isArray(args.steps) ? args.steps.filter((s): s is string => typeof s === 'string') : undefined
      if (first) {
        unit.fired = crossed(now - unit.start, unit.budgetMin)
        unit.reportDue = undefined
      } else {
        await advance($, s, unitKey, now)
      }
      await save($, s)
      await arm($, s, unitKey)
      if (main) await showStatus($, s)
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
      if (!main) u.unread = true
      if (unitKey) await advance($, s, unitKey, now)
      await save($, s)
      if (main) await showStatus($, s)
      const projected = Math.round(projectedMin(now - u.start, report))
      if (u.halted) {
        const close = main
          ? 'End the turn now with this report; use an extension button above the prompt to continue.'
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
      if (!sub || sub.kind === 'main' || sub.budgetMin === undefined) return { deny: `Call ${TOOL.grant} with the agent_id of a running subagent that has a budget (one of: ${Object.entries(s.units).filter(([, candidate]) => candidate.kind === 'sub').map(([candidateId]) => candidateId).join(', ') || 'none'}).` }
      if (typeof extra !== 'number' || !(extra > 0)) return { deny: `Call ${TOOL.grant} with minutes as a positive number.` }
      const before = sub.budgetMin
      const wasHalted = Boolean(sub.halted)
      extend(s, id, sub, extra, now)
      await save($, s)
      await arm($, s, id)
      const after = Math.round(sub.budgetMin)
      return { result: wasHalted || sub.budgetMin > before
        ? `Granted +${extra} min from now to ${id}; its budget is now ${after} min.`
        : `${id} already has more than +${extra} min left; its budget stays ${after} min.` }
    }

    const r = await next(e)
    if (!main || 'deny' in r && r.deny !== undefined) return r
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
