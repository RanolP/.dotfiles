// Regenerate the traces: nice -n 15 sh nix/home/configs/claude/mods/clm/spec/fold-job-traces.sh
//
// spec/fold-job.qnt is the source of truth for the fold job's ordering: which job a turn end starts, what a split
// overflow or a failed reply leads to, when a compaction waits or folds mechanically, the persist order inside
// applyFoldPlan, and when a queued message leaves the store or is carried as a folded row. This file replays the
// model's sampled runs (spec/fold-job-traces.ts) against the real fold-job.ts and register.ts through a fake FoldJobIo
// whose model calls, state writes and engine handoff wait on gates the trace opens one step at a time. After every
// step it compares queue membership with inStore, emitted folded rows with carried, whether the conversation still
// shows the message with inContext, the job and pending write with phase and swap.pc, the split-merge calls the code
// made with attempt, and the compaction's fallback with mechanical.
//
// Sizes stay abstract in the model, so the harness picks them: a turn end routes to the split only when the model's
// turnEnd(two, fits) says so (tailTarget huge, else 0), a split overflow is a fold whose tailTokens exceed tailTarget,
// and each plan's cut is chosen so the dropped queued messages and their handled flags are the ones the model's
// consuming swap names. Only a cut the rows cannot express ends a trace's replay early, and only for the reasons in
// `unrealizable`; any other disagreement fails the trace.
import { expect, test } from 'claude-code/testing'
import type { SessionCompactResult, SessionMessage } from 'claude-code'
import { clearFoldJob, foldJobDropFps, foldJobIdle, handleSessionCompact, maybeClear, transcriptKey, type FoldJobIo } from './fold-job'
import { captureAppendedRow } from './register'
import { estTokens, foldedRows, headRows, isHarnessText, isPrompt, liveRows, planClear, protectedIndex, queuedMessageSourceOf, sum, withQueuedMessages, type QueuedMessage } from './fold'
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
// queueTurns (fold-job.ts:177-187) over the rows the job reads: prompt starts after the protected row.
const promptStarts = (w: World) => {
  const rows = withQueuedMessages(w.session, w.queued(), w.sentAt)
  return rows.slice(protectedIndex(rows) + 1).filter(row => isPrompt(row) && !isHarnessText(row.text)).length
}
const settle = async () => { for (let i = 0; i < 3000; i++) await Promise.resolve() }

type Gate = { kind: string; mustFold?: boolean; prepared?: boolean; rows?: readonly SessionMessage[]; meta?: Meta; resolve(value: unknown): void; reject(error: unknown): void }
class Unrealizable extends Error {}
// The model drops a typing-order prefix of the queued messages and carries by buildCleared's rule, so a cut matches
// whenever the rows hold them in typing order. Two reasons may still end a replay early: the rows hold them out of
// typing order (withQueuedMessages splices two messages that share an anchor in reverse), or, should that order
// differ only in the dropped part, the model's prefix is not one in row order. Anything else is a disagreement.
const TRUNCATION_REASONS = ['rows hold the queued messages out of typing order', 'the model drops a subset that is not a row-order prefix']
// Ceiling on early stops at SEED=0x2a TRACES=80; a regeneration that raises it is a new disagreement to look at.
const MAX_TRUNCATED = 4
function unrealizable(rows: readonly SessionMessage[], need: { dropped: string[]; carried: string[] }, trace: readonly State[], upto: number, where: string): Error {
  const order = rows.flatMap(row => {
    const source = queuedMessageSourceOf(row)
    return source ? [source.uuid.slice(1)] : []
  })
  const typed = trace.slice(0, upto).flatMap(s => s.a === 'typeMsg' ? [String(s.p.m)] : []).filter(m => order.includes(m))
  const prefix = JSON.stringify(order.slice(0, need.dropped.length).sort()) === JSON.stringify(need.dropped)
  const detail = `${where} drops ${JSON.stringify(need)}, rows hold ${order.join(',') || 'none'}`
  if (JSON.stringify(order) !== JSON.stringify(typed)) return new Unrealizable(`${TRUNCATION_REASONS[0]}: ${detail}`)
  if (!prefix) return new Unrealizable(`${TRUNCATION_REASONS[1]}: ${detail}`)
  return new Error(`the code's carry differs from the model's: ${detail}`)
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
  let splitCalls = 0
  // Appended rows carry send times on the clock queued messages read, so withQueuedMessages can place a message
  // whose anchor row a compaction removed (fold.ts:107-115). Keyed by text: a swap rebuilds the row objects.
  const stamps = new Map<string, string>()
  const sentAt = (row: SessionMessage) => stamps.get(row.text)
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
    usageReading: async () => undefined, sentAt: async () => sentAt,
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
      ? (splitCalls++, gate<{ isAnswered: boolean; text: string; reason: string }>('split'))
      // Lessons and single-turn steps sit outside the model.
      : { isAnswered: false, text: '', reason: 'not modelled' },
    logEvent: async (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }) },
    log: () => undefined,
  } satisfies FoldJobIo

  const appendRow = async (row: SessionMessage) => {
    stamps.set(row.text, new Date(++clock * 60_000).toISOString())
    w.session.push(row)
    await captureAppendedRow($, `row-${rowId}`, row.role, undefined, [{ type: 'text', text: row.text }])
  }
  const w = {
    key, io, $, files, events,
    session: [] as SessionMessage[],
    get gates() { return gates },
    get meta() { return meta },
    sentAt,
    // Split-merge calls prepareBackgroundFold made since the last reset.
    get splitCalls() { return splitCalls },
    resetSplitCalls() { splitCalls = 0 },
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
    // Bulk history ahead of every queued message, so each fold shrinks the rows without answering one. Its send time
    // is the epoch, so withQueuedMessages places a message typed before the insert after it, not ahead of it.
    insertBulk() {
      const row = M('assistant', `bulk ${++rowId}\n${BIG}`)
      stamps.set(row.text, new Date(0).toISOString())
      w.session.splice(protectedIndex(w.session) + 1, 0, row)
    },
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
// What the model's swap needs: d, and the members of d whose carried count it raised.
const want = (d: readonly number[], before: Record<string, Msg>, after: Record<string, Msg>) => ({
  dropped: d.map(String).sort(),
  carried: d.map(String).filter(m => after[m]!.carried > before[m]!.carried).sort(),
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
  const need = want(consumer.s.dropped, trace[j - 1]!.m, consumer.m)
  for (let keepFrom = first + 2; keepFrom < rows.length; keepFrom++) {
    if (same(cutEffect(headRows(rows, first), foldedRows(rows, first, keepFrom)), need)) return plannedFold(rows, meta, keepFrom, 0)
  }
  throw unrealizable(rows, need, trace, j, `no cut of the job's rows for step ${j}`)
}

type Compaction = { promise: Promise<SessionCompactResult>; settled: boolean; result?: SessionCompactResult; error?: unknown; startLen: number; all: SessionMessage[]; meta: Meta; queued: QueuedMessage[]; opts: Opts; attached: string[] }
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
  // The host's queued_command attachment stays in the conversation until a compaction that started after it replaces it.
  const attached = new Set<string>()
  const inContext = (m: string) => attached.has(m) || w.session.some(row => row.text.includes(msgText(m)))
  let compaction: Compaction | undefined
  w.session.push(M('user', 'start'))
  await captureAppendedRow(w.$, 'row-start', 'user', undefined, [{ type: 'text', text: 'start' }])
  await w.appendRow(M('assistant', 'hello'))
  const startCompaction = (tailTarget: number) => {
    const c: Compaction = {
      promise: Promise.resolve(), settled: false, startLen: w.session.length, all: [...w.session], meta: { ...w.meta }, queued: w.queued(), opts: opts(tailTarget),
      attached: [...attached],
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
    for (const m of c.attached) attached.delete(m)
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
          attached.add(m)
          cover(before.j.phase !== 'idle' ? 'typeMsg during a fold' : 'typeMsg')
          break
        }
        case 'assistantReply':
          await w.appendRow(M('assistant', `reply ${w.nextId()}`))
          cover('assistantReply')
          break
        case 'turnEnd': {
          // fits picks tailTarget; two picks how many turns (prompt starts after the protected row) the code reads.
          let tailTarget = after.p.fits ? 1e9 : 0
          w.insertBulk()
          if (after.p.two) {
            await w.appendRow(M('user', `prompt ${w.nextId()}`))
            await w.appendRow(M('user', `prompt ${w.nextId()}`))
          } else {
            if (promptStarts(w) === 0) await w.appendRow(M('user', `prompt ${w.nextId()}`))
            // Rows that already hold two turns cannot be one; fits then only matters for a split, which this is not.
            if (promptStarts(w) > 1) tailTarget = 0
            else cover(`turnEnd(two=false, fits=${after.p.fits}) on one turn`)
          }
          w.resetSplitCalls()
          await maybeClear(w.io, opts(tailTarget), false)
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
          const rows = withQueuedMessages(liveRows(c.all, c.meta.boundary), c.queued, w.sentAt)
          const first = protectedIndex(rows)
          const ledgerTokens = estTokens({ role: 'user', text: notesOf(w.files[LEDGER_FILE] ?? EMPTY_LEDGER), toolUses: [] }) + 60
          const need = want(after.s.dropped, before.m, after.m)
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
          cover(`swapReady ${before.w ? 'awaited by a compaction' : 'at a new compaction'}${MSGS.some(m => after.m[m]!.carried > before.m[m]!.carried) ? ', carrying' : ''}`)
          break
        case 'handOff': {
          if (!before.w) {
            startCompaction(1e9)
            await settle()
          }
          const g = w.take('handoff')
          expect(g, `${at}: the engine handoff is pending`).toBeDefined()
          w.retiringForHandOff = true
          // Stand-in for the host summarizer, which reads the whole conversation: it keeps every queued message there.
          const summarized = MSGS.filter(m => inContext(m) || w.queued().some(message => message.uuid === `q${m}`)).map(msgText)
          g!.resolve({ messages: [M('user', [`engine summary ${w.nextId()}`, ...summarized].join('\n'))] })
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
      if (!after.s.active) {
        expect(carried[m], `${at}: folded rows emitted for message ${m}`).toBe(after.m[m]!.carried)
        // P3's concern: an unhandled message the engine summary did not cover. Where a handled one's text survives (a
        // mechanical ledger quote, the engine summary) is outside the model.
        if (after.m[m]!.typed && !after.m[m]!.handled && !after.m[m]!.engine) expect(inContext(m), `${at}: message ${m} in the conversation`).toBe(after.m[m]!.inContext)
      }
    }
    expect(modelPhase(after), `${at}: code phase vs model ${after.j.phase} (waiting=${after.w}, swap pc=${after.s.active ? after.s.pc : '-'})`).toContain(codePhase(w))
    // Attempt n of the split is the code's (n + 1)th split-merge call; the job that leaves bg makes no further one.
    if (after.j.phase === 'bg') expect(w.splitCalls, `${at}: split-merge calls for attempt ${after.j.attempt}`).toBe(after.j.attempt + 1)
    else if (after.a === 'bgAttempt') expect(w.splitCalls, `${at}: split-merge calls after the job left bg`).toBe(before.j.attempt + 1)
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
    'finishSwap carrying an unhandled message', 'turnEnd(two=false, fits=true) on one turn',
  ]
  const report = [...coverage].sort().map(([label, n]) => `${label}: ${n}`).join('\n')
  console.log(`replayed steps per action:\n${report}\ntruncated:\n${truncated.join('\n') || '(none)'}`)
  expect(required.filter(label => !coverage.has(label))).toEqual([])
  expect(truncated.length, 'traces stopped early').toBeLessThanOrEqual(MAX_TRUNCATED)
})

// P3 context clause, red on the model: a message carried as a folded row is removed by the next swap before any reply
// (fold.ts:270-271). Counterexample: typeMsg 1, typeMsg 2, requestCompact, deadline dropping {1} (carried), persist
// to finishSwap, requestCompact, deadline dropping {2}: message 1 is typed, unhandled, out of the store and out of
// context. Whether the next fold keeps carried rows is the user's decision, so no test checks it until then (the
// claude-code/testing kit has no test.todo). Reproduce: quint run spec/fold-job.qnt --main current --invariant unhandledStaysInContext --max-steps 40 --max-samples 5000 --seed 0x1
