// Regenerate the traces: nice -n 15 sh nix/home/configs/claude/mods/clm/spec/fold-job-traces.sh
//
// spec/fold-job.qnt is the source of truth for the fold job's ordering: which job a turn end starts, what a split
// overflow or a failed reply leads to, when a compaction waits or folds mechanically, the persist order inside
// applyFoldPlan, and when a queued message leaves the store or is carried as a folded row. This file replays the
// model's sampled runs (spec/fold-job-traces.ts) against the real fold-job.ts and register.ts through a fake FoldJobIo
// whose model calls, state writes and engine handoff wait on gates the trace opens one step at a time. After every
// step it compares queue membership with inStore, emitted folded rows with carried, the job and pending write with
// phase and swap.pc, and the compaction's fallback with mechanical.
//
// Sizes stay abstract in the model, so the harness picks them: a turn end routes to the split only when the model's
// turnEnd(two, fits) says so (tailTarget huge, else 0), a split overflow is a fold whose tailTokens exceed tailTarget,
// and each plan's cut is chosen so the dropped queued messages and their handled flags are the ones the model's
// consuming swap names. A step the code cannot realize ends that trace's replay (see `unrealizable`).
import { expect, test } from 'claude-code/testing'
import type { SessionCompactResult, SessionMessage } from 'claude-code'
import { clearFoldJob, foldJobDropFps, foldJobIdle, handleSessionCompact, maybeClear, transcriptKey, type FoldJobIo } from './fold-job'
import { captureAppendedRow } from './register'
import { estTokens, foldedRows, headRows, isPrompt, liveRows, planClear, protectedIndex, queuedMessageSourceOf, sum, withQueuedMessages, type QueuedMessage } from './fold'
import { EMPTY_LEDGER, notesOf, SPLIT_MERGE_SYSTEM } from './ledger'
import type { Fold, Meta, Opts } from './fold-runtime'
import type { RewindIo } from './rewind'
import { BIG, LEDGER_FILE, M } from './clm-test-support'
import { traces, type Msg, type State } from '../spec/fold-job-traces'

const STEPS = ['retire', 'ledger', 'snapshot', 'meta', 'done'] // foldJob.steps(FIXED = true)
const DONE = 4
const MSGS = ['1', '2']
const msgText = (m: string) => `queued message ${m}`
const opts = (tailTarget: number): Opts => ({ budget: 2000, tailTarget, queueTarget: 1, ledgerTarget: 300, reserve: 100, model: 'sonnet', reviewModel: 'sonnet' })
const settle = async () => { for (let i = 0; i < 3000; i++) await Promise.resolve() }

type Gate = { kind: string; mustFold?: boolean; prepared?: boolean; rows?: readonly SessionMessage[]; meta?: Meta; resolve(value: unknown): void; reject(error: unknown): void }
class Unrealizable extends Error {}
// Why no cut matches, for the truncation report. The model's swap may drop any subset of the queued messages, a cut
// drops a prefix in row order; when the rows' order differs from typing order, two messages shared an anchor.
function unrealizable(rows: readonly SessionMessage[], need: { dropped: string[]; carried: string[] }, trace: readonly State[], upto: number, where: string) {
  const order = rows.flatMap(row => {
    const source = queuedMessageSourceOf(row)
    return source ? [source.uuid.slice(1)] : []
  })
  const typed = trace.slice(0, upto).flatMap(s => s.a === 'typeMsg' ? [String(s.p.m)] : []).filter(m => order.includes(m))
  const prefix = JSON.stringify(order.slice(0, need.dropped.length).sort()) === JSON.stringify(need.dropped)
  const why = JSON.stringify(order) !== JSON.stringify(typed) ? 'rows hold the queued messages out of typing order'
    : !prefix ? 'the model drops a subset that is not a row-order prefix'
      : 'carry differs from the model\'s handled flag'
  return new Unrealizable(`${why}: ${where} drops ${JSON.stringify(need)}, rows hold ${order.join(',') || 'none'}`)
}
const PERSIST = new Set(['retire', 'ledger', 'snapshot', 'meta'])

function world(id: string) {
  const sid = `conformance-${id}`
  const key = transcriptKey(sid)
  clearFoldJob(key)
  const files: Record<string, string> = {}
  const store = new Map<string, unknown>()
  const events: { event: string; fields: Record<string, unknown> }[] = []
  let meta: Meta = { seq: 0, fails: 0 }
  let queueState: unknown
  let clock = 0
  let rowId = 0
  let gates: Gate[] = []
  let afterFn: (() => void) | undefined
  let retiringForHandOff = false
  const gate = <T>(kind: string, extra: Partial<Gate> = {}) => new Promise<T>((resolve, reject) => {
    gates.push({ kind, ...extra, resolve: resolve as (value: unknown) => void, reject })
  })
  const $ = {
    state: {
      get: async () => ({ value: queueState, version: 0 }),
      set: async (_ref: unknown, value: unknown) => { queueState = value; return { isSet: true } },
    },
    clock: { now: async () => ++clock * 60_000 }, session: { id: async () => sid },
  }
  const queued = (): QueuedMessage[] => [...((queueState as Record<string, QueuedMessage[]> | undefined)?.[sid] ?? [])]
  const writeFile = async (path: string, text: string) => {
    if (path === LEDGER_FILE) await gate('ledger')
    files[path] = text
  }
  const rewind: RewindIo = {
    storeGet: async k => store.get(k),
    storeSet: async (k, value) => {
      if (k.startsWith('ledger-snapshots:')) await gate('snapshot')
      store.set(k, value)
    },
    storeDelete: async k => { store.delete(k) }, writeFile,
    ledgerPath: async () => LEDGER_FILE, topicsKey: async k => `topics:${k}`, pendingKey: async k => `pending:${k}`,
    readMeta: async () => ({ ...meta }), writeMeta: async next => { meta = { ...meta, ...next } },
    readyFoldDropFps: () => undefined, clearReadyFold: async () => undefined, setRewindReady: () => undefined,
    logEvent: async () => undefined, log: () => undefined,
  }
  const io = {
    sessionId: async () => sid, sessionMessages: async () => [...w.session],
    stableAttachments: async (headKept: boolean) => ({ rows: [], headKept }), markStableAttachmentsCarried: async () => undefined,
    queuedMessages: async () => queued(),
    // register.ts markQueuedMessagesFolded, which is not exported: drop the folded uuids from this session's store.
    markQueuedMessagesFolded: async (folded: readonly QueuedMessage[]) => {
      if (!retiringForHandOff) await gate('retire')
      const uuids = new Set(folded.map(message => message.uuid))
      const all = (queueState as Record<string, QueuedMessage[]> | undefined) ?? {}
      queueState = { ...all, [sid]: queued().filter(message => !uuids.has(message.uuid)) }
    },
    sessionCompact: async () => { throw new Error('the harness starts every compaction itself') },
    now: async () => 0,
    after: (_ms: number, fn: () => void) => {
      afterFn = fn
      return { cancel: () => { if (afterFn === fn) afterFn = undefined } }
    },
    usageReading: async () => undefined, sentAt: async () => () => undefined,
    readMeta: async () => ({ ...meta }),
    writeMeta: async (next: Meta) => {
      if (next.seq !== meta.seq) await gate('meta')
      meta = { ...next }
    },
    readLedger: async () => files[LEDGER_FILE], ledgerPath: async () => LEDGER_FILE, basePath: async () => `/state/${sid}`,
    readFile: async (path: string) => files[path], writeFile, appendFile: async () => undefined,
    lessonsPath: async () => `/state/${sid}.lessons`, fileExists: async () => false, fileList: async () => [],
    run: async () => ({ exitCode: 0, stderr: '' }),
    storeGet: rewind.storeGet, storeSet: rewind.storeSet, storeDelete: rewind.storeDelete,
    serialize: async <T>(_session: string, run: () => Promise<T>) => run(),
    pendingKey: async (k: string) => `pending:${k}`, topicsKey: async (k: string) => `topics:${k}`,
    captureOrigin: async () => ({ session: sid, repo: 'example.invalid/repo', cwd: '/work/repo' }),
    readAll: async () => [], trackerView: async () => ({ issues: [], dropped: [], finished: [], doneTitles: new Set<string>() }),
    updateHeld: async () => undefined, backfillClauses: async () => undefined,
    residentLedger: async (_key: string, _issues: unknown, _state: unknown, _events: unknown, preview?: { notes: string }) => preview?.notes ?? '',
    append: async () => [], projectPanel: async () => undefined, readRewindIo: () => rewind, observeTranscript: async () => undefined,
    fold: (_opts: Opts, rows: readonly SessionMessage[], foldMeta: Meta, mustFold: boolean, _reading?: number, _calibrate?: boolean, prepared?: unknown) =>
      gate<Fold | string>('fold', { mustFold, prepared: prepared !== undefined, rows: [...rows], meta: { ...foldMeta } }),
    complete: async (request: { system: string }) => request.system === SPLIT_MERGE_SYSTEM
      ? gate<{ isAnswered: boolean; text: string; reason: string }>('split')
      // Lessons and single-turn steps sit outside the model.
      : { isAnswered: false, text: '', reason: 'not modelled' },
    logEvent: async (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }) },
    log: () => undefined,
  } satisfies FoldJobIo

  const appendRow = async (row: SessionMessage) => {
    w.session.push(row)
    await captureAppendedRow($, `row-${rowId}`, row.role, undefined, [{ type: 'text', text: row.text }])
  }
  const w = {
    key, io, $, files, events,
    session: [] as SessionMessage[],
    get gates() { return gates },
    get meta() { return meta },
    queued,
    take(kind: string): Gate | undefined {
      const found = gates.find(g => g.kind === kind)
      if (found) gates = gates.filter(g => g !== found)
      return found
    },
    // The job a deadline or swap replaced never resolves; its gates leave the board.
    abandonJob() { gates = gates.filter(g => g.kind !== 'split' && g.kind !== 'fold') },
    fireDeadline() {
      const fn = afterFn
      if (!fn) throw new Error('no compaction deadline is armed')
      afterFn = undefined
      fn()
    },
    set retiringForHandOff(value: boolean) { retiringForHandOff = value },
    nextId: () => ++rowId,
    appendRow,
    // Bulk history ahead of every queued message, so each fold shrinks the rows without answering one.
    insertBulk() { w.session.splice(protectedIndex(w.session) + 1, 0, M('assistant', `bulk ${++rowId}\n${BIG}`)) },
  }
  return w
}
type World = ReturnType<typeof world>

// buildCleared's carry rule over a cut: the queued sources in head plus dropped, and those after its newest assistant row.
function cutEffect(head: readonly SessionMessage[], dropped: readonly SessionMessage[]) {
  const folded = [...head, ...dropped]
  const newestAssistant = folded.findLastIndex(row => row.role === 'assistant')
  const ids = (rows: readonly SessionMessage[]) => rows.flatMap(row => {
    const source = queuedMessageSourceOf(row)
    return source ? [source.uuid.slice(1)] : []
  }).sort()
  return { dropped: ids(folded), carried: ids(folded.slice(newestAssistant + 1)) }
}
// What the model's swap needs: d, and the unhandled members of d it carries.
const want = (d: readonly number[], before: Record<string, Msg>) => ({
  dropped: d.map(String).sort(),
  carried: d.map(String).filter(m => !before[m]!.handled).sort(),
})
const same = (a: { dropped: string[]; carried: string[] }, b: { dropped: string[]; carried: string[] }) =>
  JSON.stringify(a) === JSON.stringify(b)

function plannedFold(rows: readonly SessionMessage[], meta: Meta, keepFrom: number, tailTokens: number, stale = false): Fold {
  const first = protectedIndex(rows)
  return {
    plan: {
      head: headRows(rows, first),
      // A row the transcript no longer holds: compactOrHandOff finds the plan stale and hands off (fold-job.ts:765-770).
      dropped: stale ? [M('assistant', 'conformance: a row the transcript no longer holds')] : foldedRows(rows, first, keepFrom),
      tail: rows.slice(keepFrom), keptTurns: 1, cuts: {},
    },
    notes: '## goal\n- conform', fullNotes: '## goal\n- conform', ops: [], asks: [], seq: meta.seq + 1, fallback: false,
    promoted: [], hold: [], settled: [], tailTokens,
  } as unknown as Fold
}

// The job plan for the model state at step k: its cut realizes the swap that later consumes the ready job.
function planFor(trace: readonly State[], k: number, g: Gate): Fold {
  const rows = g.rows!
  const meta = g.meta!
  let j = k + 1
  while (j < trace.length && trace[j]!.j.phase === 'ready') j++
  const consumer = trace[j]
  if (consumer?.a === 'handOff') return plannedFold(rows, meta, rows.length - 1, 0, true)
  const first = protectedIndex(rows)
  if (consumer?.a !== 'swapReady') return plannedFold(rows, meta, rows.length - 1, 0)
  const need = want(consumer.s.dropped, trace[j - 1]!.m)
  for (let keepFrom = first + 2; keepFrom < rows.length; keepFrom++) {
    if (same(cutEffect(headRows(rows, first), foldedRows(rows, first, keepFrom)), need)) return plannedFold(rows, meta, keepFrom, 0)
  }
  throw unrealizable(rows, need, trace, j, `no cut of the job's rows for step ${j}`)
}

type Compaction = { promise: Promise<SessionCompactResult>; settled: boolean; result?: SessionCompactResult; error?: unknown; startLen: number; all: SessionMessage[]; meta: Meta; queued: QueuedMessage[]; opts: Opts }
// Pending gates and the job map, as one of the model's phases (with swap.pc as the pending write).
function codePhase(w: World): string {
  const kinds = w.gates.map(g => g.kind === 'fold' ? (g.prepared ? 'prepared-fold' : g.mustFold ? 'single' : 'engine') : g.kind === 'split' ? 'bg' : g.kind)
  if (kinds.length) return kinds.join('+')
  if (foldJobDropFps(w.key) !== undefined) return 'ready'
  return foldJobIdle(w.key) ? 'idle' : 'busy'
}
function modelPhase(s: State): string[] {
  if (s.s.active) return s.s.pc < DONE ? [STEPS[s.s.pc]!] : ['idle']
  if (s.j.phase === 'ready') return s.w ? ['retire', 'handoff'] : ['ready']
  if (s.j.phase === 'idle') return s.w ? ['handoff'] : ['idle']
  return [s.j.phase]
}

export const coverage = new Map<string, number>()
const truncated: string[] = []
const cover = (label: string) => coverage.set(label, (coverage.get(label) ?? 0) + 1)

async function replay(id: string, trace: readonly State[]): Promise<void> {
  const w = world(id)
  const carried: Record<string, number> = { 1: 0, 2: 0 }
  let compaction: Compaction | undefined
  let splitCalls = 0
  w.session.push(M('user', 'start'))
  await captureAppendedRow(w.$, 'row-start', 'user', undefined, [{ type: 'text', text: 'start' }])
  await w.appendRow(M('assistant', 'hello'))
  const startCompaction = (tailTarget: number) => {
    const c: Compaction = {
      promise: Promise.resolve(), settled: false, startLen: w.session.length, all: [...w.session], meta: { ...w.meta }, queued: w.queued(), opts: opts(tailTarget),
    } as Compaction
    c.promise = handleSessionCompact(w.io, c.opts, c.all, 'auto', () => new Promise<SessionCompactResult>((resolve, reject) => {
      w.gates.push({ kind: 'handoff', resolve: resolve as (value: unknown) => void, reject })
    }))
    c.promise.then(result => { c.settled = true; c.result = result }, error => { c.settled = true; c.error = error })
    compaction = c
  }
  const adopt = () => {
    const c = compaction!
    if (c.error !== undefined) throw c.error
    w.session = [...(c.result!.messages ?? []), ...w.session.slice(c.startLen)]
    compaction = undefined
  }

  for (let k = 1; k < trace.length; k++) {
    const before = trace[k - 1]!
    const after = trace[k]!
    const at = `trace ${id} step ${k} ${after.a}${JSON.stringify(after.p)}`
    try {
      switch (after.a) {
        case 'typeMsg': {
          const m = String(after.p.m)
          await captureAppendedRow(w.$, `q${m}`, 'attachment', 'queued_command', [{ type: 'text', text: msgText(m) }], { origin: { kind: 'composer' } })
          cover(before.j.phase !== 'idle' ? 'typeMsg during a fold' : 'typeMsg')
          break
        }
        case 'assistantReply':
          await w.appendRow(M('assistant', `reply ${w.nextId()}`))
          cover('assistantReply')
          break
        case 'turnEnd': {
          const split = after.j.phase === 'bg'
          w.insertBulk()
          await w.appendRow(M('user', `prompt ${w.nextId()}`))
          await w.appendRow(M('user', `prompt ${w.nextId()}`))
          splitCalls = 0
          await maybeClear(w.io, opts(split ? 1e9 : 0), false)
          cover(`turnEnd -> ${after.j.phase}`)
          break
        }
        case 'bgAttempt': {
          const o = String(after.p.o)
          const g = w.take('split')
          expect(g, `${at}: the split call is pending`).toBeDefined()
          if (o === 'noReply') g!.resolve({ isAnswered: false, text: '', reason: 'conformance noReply' })
          else {
            g!.resolve({ isAnswered: true, text: JSON.stringify({ split: 2, ops: [] }), reason: '' })
            await settle()
            const fold = w.take('fold')
            expect(fold?.prepared, `${at}: the prepared split fold is pending`).toBe(true)
            if (o === 'skip') fold!.resolve('conformance skip')
            else if (o === 'overflow') fold!.resolve(plannedFold(fold!.rows!, fold!.meta!, fold!.rows!.length - 1, 1e9 + 1))
            else fold!.resolve(planFor(trace, k, fold!))
          }
          cover(`bgAttempt(${o}) at attempt ${before.j.attempt}`)
          break
        }
        case 'finishFold': {
          const g = w.take('fold')
          expect(g && !g.prepared, `${at}: a ${before.j.phase} fold is pending`).toBe(true)
          g!.resolve(after.p.ok ? planFor(trace, k, g!) : `conformance finishFold(false)`)
          cover(`finishFold(${after.p.ok}) in ${before.j.phase}`)
          break
        }
        case 'requestCompact':
          if (before.j.phase === 'idle') w.insertBulk()
          await w.appendRow(M('user', `prompt ${w.nextId()}`))
          startCompaction(1e9)
          cover(`requestCompact in ${before.j.phase}`)
          break
        case 'deadline': {
          // prepareMechanicalFold plans with planClear over the rows the compaction read; choose tailTarget so its cut
          // drops exactly the model's d with the model's handled flags.
          const c = compaction!
          const rows = withQueuedMessages(liveRows(c.all, c.meta.boundary), c.queued, () => undefined)
          const first = protectedIndex(rows)
          const ledgerTokens = estTokens({ role: 'user', text: notesOf(w.files[LEDGER_FILE] ?? EMPTY_LEDGER), toolUses: [] }) + 60
          const need = want(after.s.dropped, before.m)
          const target = rows.flatMap((row, i) => i > first && isPrompt(row) ? [i] : []).map(start => {
            const t = sum(headRows(rows, first)) + ledgerTokens + sum(rows.slice(start))
            const plan = planClear(rows, t, ledgerTokens)
            return plan && rows.length - plan.tail.length === start && same(cutEffect(plan.head, plan.dropped), need) ? t : undefined
          }).find(t => t !== undefined)
          if (target === undefined) throw unrealizable(rows, need, trace, k, 'no planClear cut')
          c.opts.tailTarget = target
          w.abandonJob()
          w.fireDeadline()
          cover(`deadline in ${before.j.phase}`)
          break
        }
        case 'swapReady':
          if (!before.w) startCompaction(1e9)
          cover(`swapReady ${before.w ? 'awaited by a compaction' : 'at a new compaction'}${after.s.dropped.some(m => !before.m[String(m)]!.handled) ? ', carrying' : ''}`)
          break
        case 'handOff': {
          if (!before.w) {
            startCompaction(1e9)
            await settle()
          }
          const g = w.take('handoff')
          expect(g, `${at}: the engine handoff is pending`).toBeDefined()
          w.retiringForHandOff = true
          g!.resolve({ messages: [M('user', `engine summary ${w.nextId()}`)] })
          await settle()
          w.retiringForHandOff = false
          expect(compaction?.settled, `${at}: the handed-off compaction returned`).toBe(true)
          adopt()
          cover(`handOff from ${before.j.phase}${before.w ? ' awaited' : ''}`)
          break
        }
        case 'persist': {
          const expected = STEPS[before.s.pc]!
          const g = w.gates.find(gate => PERSIST.has(gate.kind))
          expect(g?.kind, `${at}: the pending applyFoldPlan write`).toBe(expected)
          w.take(g!.kind)
          if (after.p.w) g!.resolve(undefined)
          else g!.reject(new Error('conformance: state store write refused'))
          cover(`persist(${after.p.w}) at ${expected}`)
          break
        }
        case 'finishSwap': {
          expect(compaction?.settled, `${at}: the swap returned`).toBe(true)
          const messages = compaction!.result?.messages ?? []
          for (const m of MSGS) {
            const emitted = messages.filter(row => row.text.includes(' folded>') && row.text.includes(msgText(m))).length
            carried[m]! += emitted
            if (emitted > 0) cover('finishSwap carrying an unhandled message')
          }
          const outcome = w.events.findLast(e => e.event === 'session-compact')?.fields.outcome
          expect(outcome, `${at}: compaction outcome for mechanical=${before.j.mechanical}`).toBe(before.j.mechanical ? 'swap-mechanical' : 'swap')
          adopt()
          cover(`finishSwap${before.j.mechanical ? ' mechanical' : ''}`)
          break
        }
        default:
          throw new Error(`${at}: unknown action`)
      }
    } catch (error) {
      if (!(error instanceof Unrealizable)) throw error
      truncated.push(`trace ${id} stops before step ${k} ${after.a}: ${error.message}`)
      return
    }
    await settle()
    // The comparison.
    for (const m of MSGS) {
      expect(w.queued().some(message => message.uuid === `q${m}`), `${at}: message ${m} in the queued store`).toBe(after.m[m]!.inStore)
      if (!after.s.active) expect(carried[m], `${at}: folded rows emitted for message ${m}`).toBe(after.m[m]!.carried)
    }
    expect(modelPhase(after), `${at}: code phase vs model ${after.j.phase} (waiting=${after.w}, swap pc=${after.s.active ? after.s.pc : '-'})`).toContain(codePhase(w))
    if (after.j.phase === 'bg') {
      if (after.a === 'turnEnd' || after.a === 'bgAttempt') splitCalls++
      expect(splitCalls - 1, `${at}: split attempt`).toBe(after.j.attempt)
    }
    expect(compaction !== undefined && !compaction.settled, `${at}: a compaction is waiting`).toBe(after.w || (after.s.active && after.s.pc < DONE))
  }
}

traces.forEach((trace, index) => {
  test(`fold job conformance: model trace ${index} replays against fold-job.ts`, () => replay(String(index), trace))
})

// Every action and branch of the model must have replayed somewhere, or a trace set that skips one would pass silently.
test('fold job conformance: the replayed traces cover every model action', () => {
  const required = [
    'typeMsg', 'typeMsg during a fold', 'assistantReply', 'turnEnd -> bg', 'turnEnd -> single',
    'bgAttempt(noReply) at attempt 0', 'bgAttempt(noReply) at attempt 1', 'bgAttempt(skip) at attempt 0', 'bgAttempt(overflow) at attempt 0',
    'bgAttempt(overflow) at attempt 1', 'bgAttempt(ok) at attempt 0',
    'finishFold(true) in single', 'finishFold(false) in single', 'finishFold(true) in engine', 'finishFold(false) in engine',
    'requestCompact in idle', 'deadline in engine',
    'swapReady at a new compaction', 'swapReady awaited by a compaction', 'handOff from idle awaited', 'handOff from ready',
    'persist(true) at retire', 'persist(true) at ledger', 'persist(true) at snapshot', 'persist(true) at meta',
    'persist(false) at ledger', 'persist(false) at snapshot', 'persist(false) at meta', 'finishSwap', 'finishSwap mechanical',
    'finishSwap carrying an unhandled message',
  ]
  const report = [...coverage].sort().map(([label, n]) => `${label}: ${n}`).join('\n')
  console.log(`replayed steps per action:\n${report}\ntruncated:\n${truncated.join('\n') || '(none)'}`)
  expect(required.filter(label => !coverage.has(label))).toEqual([])
})
