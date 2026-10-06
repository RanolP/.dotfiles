import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { ClmBoard } from '../types'
import { BoardView } from './board'
import {
  buildCleared, fingerprint, isSystemRow, ledgerRowText, liveRows, planClear, protectedIndex, sum, visibleTokens,
  type Boundary, type ClearPlan,
} from './fold'
import {
  composeLedger, EMPTY_LEDGER, fallbackLedger, issueList, legacyItems, MERGE_SYSTEM, notesOf, oversizeLines, parseMerge, rememberOversize,
  renderTurns,
} from './ledger'
import {
  injected, normalizeRemote, parseLog, snapshot, TASK_STATUS, toEvents,
  type Issue, type Origin, type Payload, type TrackerEvent,
} from './tracker'

// clm replaces the engine's compaction for the main conversation. When the
// rows outgrow a token budget, a cheap model folds the turns about to go into a
// ledger (goal, user instructions, work done, work left, open questions, key
// facts), and this plugin's `session.compact` hook rewrites the transcript to
// [first request, ledger row, newest turns]. The engine summarizer never runs:
// every main-session compaction, /compact and the engine's own threshold
// included, is answered here, and the ahead-of-time `precompute` is refused.
//
// 한 일, 할 일 and 미결 질문 are not merged text: they are rendered from the
// tracker (tracker.ts), and the merge model only emits ops against it, so an
// item it forgets to repeat stays where it was.
//
// Interactive sessions fold right after the turn that crossed the budget. A
// headless (-p / SDK) session refuses a plugin-raised compaction, so there the
// plan waits in the store for the next /compact or engine compaction.

const FAILS_BEFORE_FALLBACK = 3

// --- options -------------------------------------------------------------

export type Opts = { budget: number; tailTarget: number; reserve: number }
/** Reads userConfig, naming every value it could not use and the value used instead. */
export function readOpts(o: Record<string, unknown>): { opts: Opts; problems: string[] } {
  const problems: string[] = []
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
  let budget = 32000
  if (o.budget !== undefined) {
    if (isInt(o.budget) && o.budget >= 2000) budget = o.budget
    else {
      budget = typeof o.budget === 'number' && Number.isFinite(o.budget) && o.budget > 0 ? Math.max(2000, Math.round(o.budget)) : 32000
      problems.push(`budget=${JSON.stringify(o.budget)} must be an integer of at least 2000; using ${budget}`)
    }
  }
  const half = Math.floor(budget / 2)
  let tailTarget = half
  if (o.tailTarget !== undefined && o.tailTarget !== 0) {
    if (isInt(o.tailTarget) && o.tailTarget > 0 && o.tailTarget < budget) tailTarget = o.tailTarget
    else problems.push(`tailTarget=${JSON.stringify(o.tailTarget)} must be a positive integer under the budget (${budget}); using ${half}`)
  }
  const defReserve = Math.min(2048, Math.floor(budget / 4))
  let reserve = defReserve
  if (o.reserve !== undefined && o.reserve !== 0) {
    if (isInt(o.reserve) && o.reserve > 0 && o.reserve < budget) reserve = o.reserve
    else problems.push(`reserve=${JSON.stringify(o.reserve)} must be a positive integer under the budget (${budget}); using ${defReserve}`)
  }
  return { opts: { budget, tailTarget, reserve }, problems }
}

// --- session state -------------------------------------------------------

// `ops` reach the tracker only when the fold is applied, so a planned fold
// that never lands cannot leave issues behind for the next one to duplicate.
type Pending = { notes: string; ops: Payload[]; seq: number; keepFp?: string; cuts: Record<string, number>; keptTurns: number; fallback: boolean }
type Meta = { seq: number; lastClear?: string; boundary?: Boundary; lastSkip?: string; fails: number; ratio?: number; probe?: { est: number; real: number } }
const sid = ($: EngineInterface) => $.session.id()
const metaKey = async ($: EngineInterface) => `ledger:${await sid($)}`
const pendingKey = async ($: EngineInterface) => `pending:${await sid($)}`
const readMeta = async ($: EngineInterface): Promise<Meta> => ({ seq: 0, fails: 0, ...((await $.store.get(await metaKey($))) as Partial<Meta> | undefined) })
const writeMeta = async ($: EngineInterface, m: Meta) => $.store.set(await metaKey($), m)

async function basePath($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  return `${home ?? '.'}/.claude-work/plans/clm-${await sid($)}`
}
const ledgerPath = async ($: EngineInterface) => `${await basePath($)}.md`
const logPath = async ($: EngineInterface) => `${await basePath($)}.log.jsonl`
async function readText($: EngineInterface, p: string): Promise<string | undefined> {
  return (await $.fs.exists(p)) ? ((await $.fs.read(p)) as string) : undefined
}

export type LogEvent = 'clear' | 'skip-not-shrinking' | 'merge-invalid' | 'merge-timeout' | 'ops-rejected' | 'fallback' | 'truncation' | 'calibration'
type LogFields = { tokensBefore?: number; tokensAfter?: number; keptTurns?: number; ratio?: number; reason?: string }
const LOG_KEEP = 200
async function logEvent($: EngineInterface, event: LogEvent, f: LogFields) {
  try {
    const p = await logPath($)
    const lines = ((await readText($, p)) ?? '').split('\n').filter(Boolean)
    lines.push(JSON.stringify({ ts: new Date().toISOString(), event, ...f }))
    await $.fs.write(p, `${lines.slice(-LOG_KEEP).join('\n')}\n`)
  } catch { /* the log must never stop a fold */ }
}

// chars/4 undercounts Korean and code; the ratio corrects every estimate. It is
// measured on growth between two turns: SessionUsage.context.tokens also holds
// the system prompt, tools and the context the engine attaches to rows that
// `$.session.messages()` never shows, so a plain quotient reads several times
// too high (live: 11301 real against 413 estimated). Growth cancels that part.
const RATIO_MIN = 0.5, RATIO_MAX = 3
const MIN_GROWTH = 200 // estimated tokens of growth a sample needs
async function calibrate($: EngineInterface, rows: readonly SessionMessage[], meta: Meta): Promise<number> {
  const ratio = meta.ratio ?? 1
  try {
    const real = (await $.session.usage()).context.tokens
    if (real === undefined) return ratio
    const est = sum(rows)
    const prev = meta.probe
    meta.probe = { est, real }
    const grewEst = prev ? est - prev.est : 0
    const grewReal = prev ? real - prev.real : 0
    if (grewEst < MIN_GROWTH || grewReal <= 0) {
      await writeMeta($, meta)
      return ratio
    }
    const sample = Math.min(RATIO_MAX, Math.max(RATIO_MIN, grewReal / grewEst))
    const next = meta.ratio === undefined ? sample : 0.7 * meta.ratio + 0.3 * sample
    meta.ratio = Math.round(Math.min(RATIO_MAX, Math.max(RATIO_MIN, next)) * 1000) / 1000
    await writeMeta($, meta)
    await logEvent($, 'calibration', { tokensBefore: grewEst, tokensAfter: grewReal, ratio: meta.ratio, reason: `growth sample ${sample.toFixed(3)}` })
    return meta.ratio
  } catch {
    return ratio
  }
}

async function skip($: EngineInterface, why: string) {
  $.ui.log(`clm: fold skipped, ${why}`, { to: 'debug' })
  await writeMeta($, { ...(await readMeta($)), lastSkip: why })
}

// --- tracker I/O -----------------------------------------------------------

async function trackerDir($: EngineInterface): Promise<string> {
  return `${(await $.env.get('HOME')) ?? '.'}/.claude-work/tracker/events`
}
const logFile = async ($: EngineInterface, session: string) => `${await trackerDir($)}/${session}.jsonl`

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 5000 })
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** repo is the origin remote, else the worktree's top level, else the cwd. */
async function captureOrigin($: EngineInterface): Promise<Origin> {
  const session = await $.session.id()
  const cwd = await $.session.cwd()
  const remote = await git($, cwd, ['remote', 'get-url', 'origin'])
  const repo = remote ? normalizeRemote(remote) : ((await git($, cwd, ['rev-parse', '--show-toplevel'])) ?? cwd)
  const branch = await git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return { session, repo, ...(branch ? { branch } : {}), cwd }
}

async function readAll($: EngineInterface): Promise<TrackerEvent[]> {
  const dir = await trackerDir($)
  if (!(await $.fs.exists(dir))) return []
  const out: TrackerEvent[] = []
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
    try {
      out.push(...parseLog((await $.fs.read(`${dir}/${f.name}`)) as string))
    } catch (err) {
      $.ui.log(`clm tracker: could not read ${f.name} (${String(err).slice(0, 120)})`, { to: 'debug' })
    }
  }
  return out
}

/** Appends to this session's log; only this session ever writes that file. */
async function append($: EngineInterface, payloads: readonly Payload[], origin?: Origin): Promise<TrackerEvent[]> {
  if (payloads.length === 0) return []
  const o = origin ?? (await captureOrigin($))
  const p = await logFile($, o.session)
  const prev = (await $.fs.exists(p)) ? ((await $.fs.read(p)) as string) : ''
  const lastSeq = parseLog(prev).reduce((n, e) => Math.max(n, e.seq), 0)
  const events = toEvents(payloads, o, lastSeq, new Date().toISOString())
  const body = prev && !prev.endsWith('\n') ? `${prev}\n` : prev
  await $.fs.write(p, `${body}${events.map(e => JSON.stringify(e)).join('\n')}\n`)
  return events
}

// The board's drawing reads only `$.state`; the logs are read when it opens,
// on its refresh button, and after this session appends while it is open.
const BOARD = 'clm-board'
const board = atom({ plugin: 'clm', key: 'board' } as const, { issues: [], repo: '', filter: 'repo' } as ClmBoard)

async function refreshBoard($: EngineInterface) {
  const [events, here] = await Promise.all([readAll($), captureOrigin($)])
  const issues = snapshot(events).map(i => ({
    id: i.id, title: i.title, status: i.status, repo: i.origin.repo, ...(i.origin.branch ? { branch: i.origin.branch } : {}), updated: i.updated,
  }))
  await update($, board, b => ({ ...b, issues, repo: here.repo }))
}
async function refreshBoardIfOpen($: EngineInterface) {
  if ((await $.ui.panes()).some(p => p.id === BOARD)) await refreshBoard($)
}

// --- folding -------------------------------------------------------------

type Fold = { plan: ClearPlan; notes: string; ops: Payload[]; seq: number; fallback: boolean }

// The issues one session's ledger shows, with `ops` previewed on top when the
// fold has not appended them yet; ids then match what append assigns.
async function trackerView($: EngineInterface, here: Origin, ops: readonly Payload[] = []): Promise<Issue[]> {
  const events = await readAll($)
  const lastSeq = events.reduce((n, e) => (e.origin.session === here.session ? Math.max(n, e.seq) : n), 0)
  return injected(snapshot([...events, ...toEvents(ops, here, lastSeq, new Date().toISOString())]), here)
}

/**
 * Plans a fold of `rows` and merges the dropped turns into the ledger. Returns
 * the reason instead when there is nothing to fold, the merge failed and
 * `mustFold` is off, or the result would not be smaller. Updates `meta.fails`;
 * the caller writes `meta`.
 */
async function fold($: EngineInterface, opts: Opts, rows: readonly SessionMessage[], meta: Meta, mustFold: boolean): Promise<Fold | string> {
  const ratio = meta.ratio ?? 1
  const prev = (await readText($, await ledgerPath($))) ?? EMPTY_LEDGER
  // Estimates are raw chars/4 and limits real tokens, so limits are divided by the ratio.
  const plan = planClear(rows, opts.tailTarget / ratio, Math.ceil(prev.length / 4) + 60)
  if (!plan) return 'nothing left to fold'

  const here = await captureOrigin($)
  const issues = await trackerView($, here)
  let notes = notesOf(prev)
  let ops: Payload[] = []
  let fallback = false
  if (plan.dropped.length > 0) {
    const legacy = legacyItems(prev)
    const r = await $.model.complete({
      model: 'haiku',
      system: MERGE_SYSTEM,
      prompt: [
        `<notes>\n${notes}\n</notes>`,
        `<issues>\n${issueList(issues)}\n</issues>`,
        ...(legacy.length ? [`<legacy>\n${legacy.join('\n')}\n</legacy>`] : []),
        `<removed_turns>\n${renderTurns(plan.dropped)}\n</removed_turns>`,
      ].join('\n\n'),
      maxTokens: 4096,
      timeoutMs: 120_000,
    })
    const merged = r.isAnswered ? parseMerge(r.text, new Set(issues.map(i => i.id)), Math.max(500, Math.floor(opts.budget / 4))) : `merge model gave no text (${r.reason})`
    const bad = typeof merged === 'string' ? merged : undefined
    if (typeof merged !== 'string') {
      notes = merged.notes
      ops = merged.ops
      meta.fails = 0
      if (merged.rejected) await logEvent($, 'ops-rejected', { ratio, reason: `${merged.rejected} op(s) failed validation; ${ops.length} kept` })
    } else {
      meta.fails += 1
      await logEvent($, !r.isAnswered && r.reason === 'aborted' ? 'merge-timeout' : 'merge-invalid', { ratio, reason: `${bad} (failure ${meta.fails} in a row)` })
      if (!mustFold && meta.fails < FAILS_BEFORE_FALLBACK) return `merged ledger rejected: ${bad}`
      // A merge that never succeeds must not block folding forever.
      ;({ notes, ops } = fallbackLedger(notes, plan.dropped))
      fallback = true
      meta.fails = 0
      $.ui.log(`clm: merge failed (${bad}); folded with a mechanical ledger instead`, { to: 'debug' })
      await logEvent($, 'fallback', { ratio, reason: bad })
    }
  }
  notes = rememberOversize(notes, oversizeLines(plan.tail, plan.cuts))

  const seq = meta.seq + 1
  const text = ledgerRowText(seq, new Date().toISOString(), await ledgerPath($), composeLedger(notes, await trackerView($, here, ops)))
  const tokensBefore = sum(rows)
  const tokensAfter = sum(buildCleared(plan, { role: 'user', text, toolUses: [] }))
  if (tokensAfter >= tokensBefore) {
    const why = `the fold would not shrink the context (${tokensBefore} -> ${tokensAfter} est. tokens)`
    $.ui.log(`clm: ${why}`)
    await logEvent($, 'skip-not-shrinking', { tokensBefore, tokensAfter, keptTurns: plan.keptTurns, ratio, reason: why })
    return why
  }
  if (Object.keys(plan.cuts).length)
    await logEvent($, 'truncation', { keptTurns: plan.keptTurns, ratio, reason: `cut ${Object.keys(plan.cuts).length} tool result(s) to ~${Object.values(plan.cuts)[0]}t each` })
  return { plan, notes, ops, seq, fallback }
}

async function maybeClear($: EngineInterface, opts: Opts) {
  const meta = await readMeta($)
  const rows = liveRows(await $.session.messages(), meta.boundary)
  const ratio = await calibrate($, rows, meta)
  if (visibleTokens(rows) * ratio <= opts.budget - opts.reserve) return
  const f = await fold($, opts, rows, meta, false)
  await writeMeta($, meta)
  if (typeof f === 'string') return skip($, f)
  const pending: Pending = {
    notes: f.notes, ops: f.ops, seq: f.seq, keepFp: f.plan.tail[0] && fingerprint(f.plan.tail[0]),
    cuts: f.plan.cuts, keptTurns: f.plan.keptTurns, fallback: f.fallback,
  }
  await $.store.set(await pendingKey($), pending)
  try {
    // Answered by this plugin's own session.compact hook below, which applies
    // the pending plan; the engine summarizer is never reached.
    await $.session.compact({})
  } catch (err) {
    $.ui.log(`clm: fold deferred to the next compaction (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}

export function report(ledger: string | undefined, rows: readonly SessionMessage[], opts: Opts, meta: Meta, logTail: readonly string[]): string {
  const used = Math.round(visibleTokens(rows) * (meta.ratio ?? 1))
  return [
    `clm budget: ${used}/${opts.budget} tokens (${Math.round((used / opts.budget) * 100)}%); folds above ${opts.budget - opts.reserve}, tail target ${opts.tailTarget}, ratio ${meta.ratio ?? 1}`,
    `rows: ${rows.filter(m => !isSystemRow(m)).length} kept, ${rows.filter(isSystemRow).length} hidden system rows`,
    `last fold: ${meta.lastClear ?? 'never'} (ledger #${meta.seq})${meta.lastSkip ? `; last skip: ${meta.lastSkip}` : ''}`,
    '',
    ledger ?? '(no ledger yet)',
    '',
    'recent decisions:',
    ...(logTail.length ? logTail : ['(none)']),
  ].join('\n')
}

const GUIDE = [
  'Memory ledger (clm): when this conversation outgrows its budget, the harness folds the older turns into one row that starts with "[clm ledger".',
  'That row records the goal, the user\'s instructions verbatim, what was done with its evidence, what is left, open questions and key facts; the turns it replaced are gone.',
  'Rely on it as your own memory of that work.',
].join('\n')

export const register: Register = (on, options) => {
  const { opts, problems } = readOpts(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    for (const p of problems) $.ui.log(`clm: option ${p}`)
    await $.command.register({
      name: 'clm',
      description: 'Show the clm ledger, budget use and recent decisions; `board` opens the issue board, `link <id>` brings another repo\'s issue into this session (shown to you only).',
      immediate: true,
    })
    return next(e)
  })

  // Printed through ui.log, which the engine draws as a notice and never sends
  // to the model; a command's `text` is a transcript row and may be.
  on('command.run', { command: 'clm' }, async ($, e) => {
    // `$.command.run` documents a left-out args as "", yet the test kit hands it over undefined.
    const [sub, arg] = (e.args ?? '').trim().split(/\s+/)
    if (sub === 'board') {
      await refreshBoard($)
      const opened = await $.ui.open({ id: BOARD, title: 'clm board' })
      if (!opened.isPlaced) $.ui.log(`clm: the board is not shown (${opened.reason})`)
      return {}
    }
    if (sub === 'link') {
      const issue = arg ? snapshot(await readAll($)).find(i => i.id === arg) : undefined
      if (!issue) {
        $.ui.log(arg ? `clm: no issue ${arg}; /clm board lists them` : 'clm: usage /clm link <issue id>')
        return {}
      }
      await append($, [{ op: 'link', issue: issue.id }])
      await refreshBoardIfOpen($)
      $.ui.log(`clm: ${issue.id} "${issue.title}" (${issue.origin.repo}) is linked to this session and shows in its ledger from the next fold`)
      return {}
    }
    if (sub) {
      $.ui.log('clm: usage /clm, /clm board, /clm link <issue id>')
      return {}
    }
    const meta = await readMeta($)
    const rows = liveRows(await $.session.messages(), meta.boundary)
    const log = ((await readText($, await logPath($))) ?? '').split('\n').filter(Boolean).slice(-5)
    $.ui.log(report(await readText($, await ledgerPath($)), rows, opts, meta, log))
    return {}
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined) return res
    try {
      await maybeClear($, opts)
    } catch (err) {
      $.ui.log(`clm: fold failed, ${String(err).slice(0, 200)}`, { to: 'debug' })
    }
    return res
  })

  // The main conversation's every compaction ends here and never reaches
  // next(e), the engine summarizer: a pending plan is applied, otherwise the
  // fold is planned and merged on the spot. Subagents keep the engine's.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.trigger === 'precompute') return { skip: 'clm replaces compaction' }
    // Without a transcript there is nothing to rewrite; a pending plan waits.
    if (!Array.isArray(e.messages)) return { skip: 'clm: the compaction carried no transcript' }
    const all = e.messages
    const meta = await readMeta($)
    const rows = liveRows(all, meta.boundary)
    const first = protectedIndex(rows)
    const key = await pendingKey($)
    const pending = (await $.store.get(key)) as Pending | undefined
    if (pending) await $.store.delete(key)

    let use: (Omit<Pending, 'keepFp'> & { keepFrom: number }) | undefined
    if (pending) {
      let keepFrom = pending.keepFp === undefined ? rows.length : -1
      for (let i = rows.length - 1; i > first && keepFrom < 0; i--) if (fingerprint(rows[i]!) === pending.keepFp) keepFrom = i
      if (keepFrom >= 0) use = { ...pending, keepFrom }
    }
    if (!use) {
      const f = await fold($, opts, rows, meta, true)
      await writeMeta($, meta)
      if (typeof f === 'string') {
        $.ui.log(`clm: ${e.trigger} compaction left the conversation as it is: ${f}`)
        return { messages: all }
      }
      use = { notes: f.notes, ops: f.ops, seq: f.seq, cuts: f.plan.cuts, keptTurns: f.plan.keptTurns, fallback: f.fallback, keepFrom: rows.length - f.plan.tail.length }
    }

    const here = await captureOrigin($)
    await append($, use.ops, here)
    const ledger = composeLedger(use.notes, await trackerView($, here))
    const text = ledgerRowText(use.seq, new Date().toISOString(), await ledgerPath($), ledger)
    const ledgerRow: SessionMessage = { role: 'user', text, toolUses: [] }
    const messages = buildCleared({ head: rows.slice(0, first + 1), tail: rows.slice(use.keepFrom), cuts: use.cuts }, ledgerRow)
    const tokensBefore = sum(rows)
    const tokensAfter = sum(messages)
    await $.fs.write(await ledgerPath($), `${ledger}\n`)
    if (use.ops.length) await refreshBoardIfOpen($)
    const offset = messages.findIndex(m => m.text === text)
    await writeMeta($, { ...meta, seq: use.seq, lastClear: new Date().toISOString(), lastSkip: undefined, boundary: { fp: fingerprint(ledgerRow), offset } })
    await logEvent($, 'clear', { tokensBefore, tokensAfter, keptTurns: use.keptTurns, ratio: meta.ratio ?? 1, reason: `${e.trigger}${use.fallback ? ', fallback ledger' : ''}` })
    return { messages, tokensBefore, tokensAfter }
  })

  // The main loop's task list mirrored into the tracker. Task ids are numbered
  // per session, so an update finds its issue among this session's own.
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || r.deny !== undefined || r.isError) return r
    try {
      const taskId = (r.result as { task?: { id?: unknown } } | undefined)?.task?.id
      await append($, [{ op: 'create', title: e.subject, status: 'todo', ...(typeof taskId === 'string' ? { taskId } : {}) }])
      await refreshBoardIfOpen($)
    } catch (err) {
      $.ui.log(`clm tracker: TaskCreate not mirrored (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
    return r
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const r = await next(e)
    const status = e.status && TASK_STATUS[e.status]
    if (e.agentId !== undefined || r.deny !== undefined || r.isError || !status) return r
    try {
      const session = await $.session.id()
      const issue = snapshot(await readAll($)).find(i => i.origin.session === session && i.taskId === e.taskId)
      if (issue && issue.status !== status) {
        await append($, [{ op: 'status', issue: issue.id, status }])
        await refreshBoardIfOpen($)
      }
    } catch (err) {
      $.ui.log(`clm tracker: TaskUpdate not mirrored (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: BOARD }, async ($, e) =>
    BoardView($.ui.resolve(e), await read($, board), e.props.bodyColumns, {
      filter: f => update($, board, b => ({ ...b, filter: f })),
      refresh: () => refreshBoard($),
    }))

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.includes('bare')) return r
    return { ...r, sections: [...r.sections, { id: 'clm:guide', text: GUIDE, scope: 'session' as const }] }
  })
}
