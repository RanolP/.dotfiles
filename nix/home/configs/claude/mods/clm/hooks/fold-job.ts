import type { SessionMessage, SessionCompactResult } from 'claude-code'
import {
  buildCleared, estTokens, fingerprint, foldedRows, headRows, isHarnessText, isLedgerRow, isPrompt, isSystemRow, keepsHeadGroup, kst, ledgerRowText, liveRows, planClear,
  protectedIndex, sum, type ClearPlan,
} from './fold'
import { CONFIRM_PREFIX, confirmQuestion, renderRange } from './evidence'
import {
  composeLedger, EMPTY_LEDGER, factLines, instructionValues, mergeableNotes, notesOf, parseChanges, parseMerge,
  fallbackLedger, oversizeLines, carryLegacyInstructions, preservedLines, rememberOversize, rememberPreserved, renderTurns,
  LESSON_SYSTEM, SPLIT_MERGE_SYSTEM, withheldLines, withheldPointer,
} from './ledger'
import { focusOf, injected, snapshot, type Issue, type Origin, type Payload, type TrackerEvent } from './tracker'
import type { Held } from './held'
import type { Fold, FoldPreview, Meta, Opts, PreparedFold, TopicState, TrackerView } from './fold-runtime'
import { atFoldPoint, calibrateFirstReading, foldableTokens, parseSplitAnswer } from './fold-runtime'
import { readLedgerSnapshots, saveLedgerSnapshot, transcriptRowsKey, type RewindIo, type RewindPlan } from './rewind'
import { xmlText } from './intent'
import type { LogEvent, LogFields, Payloads } from './events'
import type { SentAt } from './address'
import { clauseStoreKey, emptyClauseStore, readClauseStore, renderClauses, type ClauseStore } from './clauses'

type Pending = {
  notes: string; fullNotes: string; ops: Payload[]; asks?: Payload[]; seq: number; keepFp?: string; keepFrom: number; dropFps: string[]
  cuts: Record<string, number>; keptTurns: number; fallback: boolean; summaryMs?: number; topics?: TopicState[]
  clauses?: ClauseStore
  rewindOnly?: boolean; promoted?: Payload[]; hold?: Held[]; settled?: string[]; coveredRows?: string[]
}
type PendingJob =
  | { state: 'summarizing'; promise: Promise<Pending | undefined>; fingerprints: string[] }
  | { state: 'ready'; plan: Pending; fingerprints: string[] }
// A swap that would not shrink the conversation reports why instead of a result, before it persists anything.
type NotShrunk = { notShrunk: string }
type SwapResult = SessionCompactResult | NotShrunk
type FoldJob = { state: 'idle' } | PendingJob | { state: 'swapping'; promise: Promise<SwapResult> }
type CompactEntryState = 'none' | FoldJob['state']
type SaveMeta = (meta: Meta) => Promise<void>
type QueueTurn = { number: number; start: number; rows: readonly SessionMessage[] }
const TURN_CHANGE_SYSTEM = 'Summarize only concrete non-task context changes from the finished coding turn. Reply with <changes>, at most three short Korean lines, or <changes></changes> when nothing changed.'

export type FoldJobIo = {
  loadedFrom?: string
  sessionId(): Promise<string>
  sessionMessages(): Promise<SessionMessage[]>
  stableAttachments(headKept: boolean): Promise<{ rows: SessionMessage[]; headKept: boolean }>
  markStableAttachmentsCarried(seq: number, rows: readonly SessionMessage[], headKept: boolean): Promise<void>
  sessionCompact(): Promise<SessionCompactResult>
  now(): Promise<number>
  after(ms: number, fn: () => void): { cancel(): void }
  usageReading(): Promise<number | undefined>
  sentAt(): Promise<SentAt>
  readMeta(): Promise<Meta>
  writeMeta(meta: Meta): Promise<void>
  readLedger(): Promise<string | undefined>
  ledgerPath(): Promise<string>
  basePath(): Promise<string>
  readFile(path: string): Promise<string | undefined>
  writeFile(path: string, text: string): Promise<void>
  appendFile(path: string, text: string): Promise<void>
  lessonsPath(): Promise<string>
  fileExists(path: string): Promise<boolean>
  fileList(path: string): Promise<{ name: string; kind: string }[]>
  run(args: string[], options: { timeoutMs: number }): Promise<{ exitCode: number; stderr: string }>
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
  storeDelete(key: string): Promise<void>
  serialize<T>(session: string, run: () => Promise<T>): Promise<T>
  pendingKey(key: string): Promise<string>
  topicsKey(key: string): Promise<string>
  captureOrigin(): Promise<Origin>
  readAll(): Promise<TrackerEvent[]>
  trackerView(origin: Origin, ops?: readonly Payload[]): Promise<TrackerView>
  updateHeld(settled: readonly string[], hold: readonly Held[]): Promise<void>
  backfillClauses(key: string): Promise<void>
  residentLedger(key: string, issues: readonly Issue[], state: { stack: string[]; pending: string[] }, events: readonly TrackerEvent[], preview?: FoldPreview): Promise<string>
  append(payloads: Payloads, origin: Origin, project: boolean, knownTitles: boolean): Promise<TrackerEvent[]>
  projectPanel(origin: Origin, events: readonly TrackerEvent[]): Promise<void>
  readRewindIo(): RewindIo
  observeTranscript(key: string, rows: readonly SessionMessage[]): Promise<void>
  fold(opts: Opts, rows: readonly SessionMessage[], meta: Meta, mustFold: boolean, reading?: number, calibrate?: boolean, prepared?: PreparedFold, transcript?: string): Promise<Fold | string>
  complete(request: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }): Promise<{ isAnswered: boolean; text: string; reason: string }>
  logEvent(event: LogEvent, fields: LogFields): Promise<void>
  log(text: string, options?: { to?: 'transcript' | 'debug' }): void
}

const foldJobs = new Map<string, FoldJob>()
export const transcriptKey = (session: string, agentId?: string) => `${session}:${agentId ?? 'main'}`
const WITHHELD = '.withheld-'
// The engine kills session.compact at 10 s; the rest leaves room for the swap after the deadline.
const COMPACT_DEADLINE_MS = 7000
const shownChanges = new Map<string, Set<string>>()
const logFoldOutcome = async (io: Pick<FoldJobIo, 'logEvent'>, reason: string) => {
  try { await io.logEvent('fold-job', { reason }) } catch { /* decisions must not block compaction */ }
}
const compactResult = async <T>(
  io: Pick<FoldJobIo, 'now' | 'logEvent' | 'log'>, startedAt: number, trigger: string, state: CompactEntryState, outcome: string, result: T | Promise<T>, decidedWaitMs?: number,
): Promise<T> => {
  let waitMs = decidedWaitMs
  if (waitMs === undefined) {
    try { waitMs = Math.max(0, (await io.now()) - startedAt) }
    catch (err) { try { io.log(`clm: compaction timing failed (${String(err).slice(0, 160)})`, { to: 'debug' }) } catch { /* timing never blocks compaction */ } }
  }
  const settled = Promise.resolve(result)
  const log = async () => {
    let totalMs = waitMs
    try { totalMs = Math.max(waitMs ?? 0, (await io.now()) - startedAt) }
    catch (err) { try { io.log(`clm: compaction timing failed (${String(err).slice(0, 160)})`, { to: 'debug' }) } catch { /* timing never blocks compaction */ } }
    try {
      await io.logEvent('session-compact', { trigger, state, outcome, loadedFrom: io.loadedFrom, ...(waitMs === undefined ? {} : { waitMs }), ...(totalMs === undefined ? {} : { totalMs }) })
    } catch (err) { try { io.log(`clm: compaction event logging failed (${String(err).slice(0, 160)})`, { to: 'debug' }) } catch { /* logging never blocks compaction */ } }
  }
  void settled.then(log, log)
  return result
}
async function logPersistenceFailure(io: FoldJobIo, error: unknown): Promise<void> {
  const reason = String(error).slice(0, 1000)
  try { await io.logEvent('fold-persist-failed', { reason }) } catch { /* compaction must remain fail-open */ }
  try { io.log(`clm: fold result returned after persistence failed (${reason})`, { to: 'debug' }) } catch { /* the result still belongs to the engine */ }
}
async function persistStep<T>(io: FoldJobIo, fallback: T, run: () => Promise<T>): Promise<T> {
  try { return await run() }
  catch (error) { await logPersistenceFailure(io, error); return fallback }
}
async function persistCompactResult(
  io: FoldJobIo, result: SessionCompactResult, persist: () => Promise<void>,
): Promise<SessionCompactResult> {
  try { await persist() }
  catch (error) { await logPersistenceFailure(io, error) }
  return result
}
const changeHash = (line: string): string => {
  let h = 2166136261
  for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16)
}
const isPromptStart = (message: SessionMessage) => isPrompt(message) && !isHarnessText(message.text)

export const foldJobIdle = (key: string): boolean => (foldJobs.get(key)?.state ?? 'idle') === 'idle'

const notShrunk = (before: readonly SessionMessage[], after: readonly SessionMessage[]): NotShrunk | undefined =>
  sum(after) < sum(before) ? undefined : { notShrunk: `the clm fold did not shrink the context (${sum(before)} -> ${sum(after)} est. tokens)` }

/** After the engine summarized, its summary heads the live chain; a fold built on the old rows must never swap in. */
export async function adoptEngineSummary(io: FoldJobIo, key: string, messages: readonly SessionMessage[] | undefined): Promise<void> {
  const head = messages?.[0]
  if (!messages || !head) return
  foldJobs.set(key, { state: 'idle' })
  await persistStep<void>(io, undefined, async () => {
    await io.storeDelete(await io.pendingKey(key))
    await io.writeMeta({ ...await io.readMeta(), boundary: { fp: fingerprint(head), offset: 0 } })
    // Left on the pre-summary rows, the next observation read the clm ledger row as rewound away and rolled the ledger back.
    await io.storeSet(transcriptRowsKey(key), messages.map(fingerprint))
  })
}

export function foldJobDropFps(key: string): string[] | undefined {
  const job = foldJobs.get(key)
  return job?.state === 'ready' ? job.plan.dropFps : undefined
}

export function clearFoldJob(key: string): void {
  foldJobs.set(key, { state: 'idle' })
}

export function setRewindFoldJob(key: string, plan: RewindPlan, fingerprints: string[]): void {
  foldJobs.set(key, { state: 'ready', plan, fingerprints })
}

function queueTurns(rows: readonly SessionMessage[], first: number): QueueTurn[] {
  const start = first + 1
  const queue = rows.slice(start)
  const prompts = queue.flatMap((message, index) => isPromptStart(message) ? [index] : [])
  return prompts.map((prompt, index) => {
    const from = index === 0 ? 0 : prompt
    const to = prompts[index + 1] ?? queue.length
    const orphans = index === 0 ? foldedRows(rows, first, 0) : []
    return { number: index + 1, start: start + prompt, rows: [...orphans, ...queue.slice(from, to)].filter(message => !isLedgerRow(message)) }
  })
}

function splitPrompt(previous: string, turns: readonly QueueTurn[], retryRule: string, sentAt: SentAt): string {
  let refOffset = 0
  const numbered = turns.map(turn => {
    const citable = turn.rows.filter(message => !isSystemRow(message) && !isLedgerRow(message))
    const rendered = renderRange(citable, 120_000, refOffset, sentAt).text
    refOffset += citable.length
    return `<turn number="${turn.number}" tokens="${sum(turn.rows)}">\n${xmlText(rendered)}\n</turn>`
  }).join('\n')
  return [
    `<current_ledger>\n${xmlText(previous)}\n</current_ledger>`,
    `<queue_turns>\n${numbered}\n</queue_turns>`,
    retryRule ? `<retry_rule>\n${xmlText(retryRule)}\n</retry_rule>` : '',
  ].filter(Boolean).join('\n\n')
}

const LESSON_KINDS = new Set(['correction', 'failed-approach', 'fact'])
const LESSON_SENTINEL = 'LESSON-CONFIDENTIAL / 교훈: 외부 채널 반출 금지'

// Fire-and-forget: a lesson never delays or fails the fold that dropped its turns.
function extractLessons(io: FoldJobIo, dropped: readonly SessionMessage[], seq: number): void {
  void (async () => {
    const path = await io.lessonsPath()
    const known = ((await io.readFile(path)) ?? '').split('\n').filter(Boolean).slice(-30).flatMap(line => {
      try { const lesson: unknown = JSON.parse(line).lesson; return typeof lesson === 'string' ? [lesson] : [] } catch { return [] }
    })
    const rendered = renderTurns(dropped, 120_000, await io.sentAt())
    const prompt = `<known_lessons>\n${known.map(line => `- ${line}`).join('\n')}\n</known_lessons>\n<dropped_turns>\n${rendered}\n</dropped_turns>`
    const response = await io.complete({ model: 'haiku', system: LESSON_SYSTEM, prompt, maxTokens: 2048, timeoutMs: 60_000 })
    if (!response.isAnswered) throw new Error(`model gave no text (${response.reason})`)
    const reply: unknown = JSON.parse(response.text.trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/, '$1'))
    const lessons = typeof reply === 'object' && reply !== null && 'lessons' in reply && Array.isArray(reply.lessons) ? reply.lessons as unknown[] : []
    const valid = lessons.flatMap(item => {
      if (typeof item !== 'object' || item === null) return []
      const { kind, lesson, evidence } = item as Record<string, unknown>
      return typeof kind === 'string' && LESSON_KINDS.has(kind) && typeof lesson === 'string' && lesson.trim() && !known.includes(lesson)
        && typeof evidence === 'string' && evidence.trim() && rendered.includes(evidence) ? [{ kind, lesson, evidence }] : []
    })
    if (lessons.length > valid.length) io.log(`clm: lesson extraction dropped ${lessons.length - valid.length} of ${lessons.length} lesson(s) without verbatim evidence or a known kind`, { to: 'debug' })
    if (valid.length === 0) return
    const { session, cwd } = await io.captureOrigin()
    const at = kst()
    await io.appendFile(path, valid.map(lesson => JSON.stringify({ _sentinel: LESSON_SENTINEL, at, session, cwd, seq, ...lesson }) + '\n').join(''))
  })().catch(err => io.log(`clm: lesson extraction failed (${String(err)})`, { to: 'debug' }))
}

async function prepareBackgroundFold(io: FoldJobIo, opts: Opts, rows: readonly SessionMessage[], meta: Meta, first: number, turns: readonly QueueTurn[], key: string, saveMeta: SaveMeta): Promise<Pending | undefined> {
  const session = await io.sessionId()
  const startedAt = await io.now()
  const previous = (await io.readLedger()) ?? EMPTY_LEDGER
  const here = await io.captureOrigin()
  const view = await io.trackerView(here)
  const known = new Set([...view.issues, ...view.dropped].map(issue => issue.id))
  const sentAt = await io.sentAt()
  let retryRule = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await io.complete({ model: opts.model, system: SPLIT_MERGE_SYSTEM, prompt: splitPrompt(previous, turns, retryRule, sentAt), maxTokens: 8192, timeoutMs: 120_000 })
    const answer = response.isAnswered ? parseSplitAnswer(response.text) : `split model gave no text (${response.reason})`
    if (typeof answer === 'string') {
      retryRule = `The previous reply failed: ${answer}. Return the required JSON object and choose a whole-turn split.`
      if (attempt === 1) io.log(`clm: split summary failed (${answer}); the next turn end may retry`, { to: 'debug' })
      continue
    }
    const boundary = turns[answer.split - 1]
    if (answer.split < 2 || !boundary || !turns.slice(0, answer.split - 1).some(turn => turn.rows.length)) {
      retryRule = `The previous split=${answer.split} did not leave a non-empty A and a B starting at a prompt row. Choose split from 2 through ${turns.length}.`
      if (attempt === 1) io.log(`clm: split summary rejected (${retryRule}); the next turn end may retry`, { to: 'debug' })
      continue
    }
    const keepFrom = boundary.start
    const plan: ClearPlan = {
      head: headRows(rows, first),
      dropped: foldedRows(rows, first, keepFrom),
      tail: rows.slice(keepFrom), keptTurns: turns.length - answer.split + 1, cuts: {},
    }
    if (plan.dropped.length === 0) {
      retryRule = `The previous split=${answer.split} left A empty. Choose split from 2 through ${turns.length}.`
      if (attempt === 1) io.log(`clm: split summary rejected (${retryRule}); the next turn end may retry`, { to: 'debug' })
      continue
    }
    const merge = parseMerge(answer.mergeReply, known, Math.max(500, Math.floor(opts.budget / 4)), factLines(notesOf(previous)))
    if (typeof merge === 'string') {
      retryRule = `The previous summary failed validation: ${merge}. Return valid note sections and ops in the required JSON object.`
      if (attempt === 1) io.log(`clm: split summary rejected (${merge}); the next turn end may retry`, { to: 'debug' })
      continue
    }
    const prepared: PreparedFold = { plan, mergeReply: answer.mergeReply, topics: answer.topics.map(({ topic, summary }) => ({ topic, summary })) }
    const folded = await io.fold(opts, rows, meta, false, undefined, true, prepared, key)
    if (typeof folded === 'string') {
      await logFoldOutcome(io, `background fold skipped (${folded})`)
      await saveMeta(meta)
      io.log(`clm: background fold skipped (${folded})`, { to: 'debug' })
      return undefined
    }
    if (folded.tailTokens > opts.tailTarget) {
      retryRule = `The previous split=${answer.split} produced ${folded.tailTokens} tokens for the new ledger plus B, above tailTarget=${opts.tailTarget}; choose an earlier whole-topic boundary or shorter summaries.`
      if (attempt === 1) {
        await logFoldOutcome(io, `background fold dropped (${retryRule})`)
        io.log(`clm: split summary dropped (${retryRule}); the next turn end may retry`, { to: 'debug' })
        return undefined
      }
      continue
    }
    await saveMeta(meta)
    extractLessons(io, folded.plan.dropped, folded.seq)
    const summaryMs = Math.max(0, (await io.now()) - startedAt)
    return {
      notes: folded.notes, fullNotes: folded.fullNotes, ops: folded.ops, asks: folded.asks, seq: folded.seq,
      ...(folded.plan.tail[0] ? { keepFp: fingerprint(folded.plan.tail[0]) } : {}),
      keepFrom: rows.length - folded.plan.tail.length,
      dropFps: folded.plan.dropped.filter(message => !isLedgerRow(message) && !isSystemRow(message)).map(fingerprint),
      cuts: folded.plan.cuts, keptTurns: folded.plan.keptTurns, fallback: folded.fallback, summaryMs, topics: folded.topics, clauses: folded.clauses,
      promoted: folded.promoted, hold: folded.hold, settled: folded.settled,
    }
  }
  await logFoldOutcome(io, `background fold gave up for ${session}`)
  io.log(`clm: background fold gave up for ${session}`, { to: 'debug' })
  return undefined
}

function pendingFromFold(folded: Fold, rows: readonly SessionMessage[], summaryMs: number): Pending {
  const keepFrom = rows.length - folded.plan.tail.length
  const keptRow = rows[keepFrom]
  return {
    notes: folded.notes, fullNotes: folded.fullNotes, ops: folded.ops, asks: folded.asks, seq: folded.seq,
    ...(keptRow ? { keepFp: fingerprint(keptRow) } : {}), keepFrom,
    dropFps: folded.plan.dropped.filter(message => !isLedgerRow(message) && !isSystemRow(message)).map(fingerprint),
    cuts: folded.plan.cuts, keptTurns: folded.plan.keptTurns, fallback: folded.fallback, summaryMs, topics: folded.topics, clauses: folded.clauses,
    promoted: folded.promoted, hold: folded.hold, settled: folded.settled,
  }
}

async function prepareSingleFold(io: FoldJobIo, opts: Opts, rows: readonly SessionMessage[], meta: Meta, key: string, saveMeta: SaveMeta): Promise<Pending | undefined> {
  const startedAt = await io.now()
  let folded: Fold | string
  try { folded = await io.fold(opts, rows, meta, true, undefined, true, undefined, key) }
  catch (err) { folded = `fold failed: ${String(err)}` }
  if (typeof folded === 'string') {
    await logFoldOutcome(io, `background fold skipped (${folded})`)
    io.log(`clm: background fold skipped (${folded})`, { to: 'debug' })
    return undefined
  }
  await saveMeta(meta)
  extractLessons(io, folded.plan.dropped, folded.seq)
  return pendingFromFold(folded, rows, Math.max(0, (await io.now()) - startedAt))
}

async function prepareEngineFold(io: FoldJobIo, opts: Opts, rows: readonly SessionMessage[], meta: Meta, key: string, saveMeta: SaveMeta): Promise<Pending | undefined> {
  const startedAt = await io.now()
  let working = rows
  let folded: Fold | string
  try { folded = await io.fold(opts, working, meta, false, undefined, true, undefined, key) }
  catch (err) { folded = `fold failed: ${String(err)}` }
  if (typeof folded === 'string') {
    const escaped = await withholdOldestResults(io, working, opts)
    if (escaped) {
      working = escaped
      try { folded = await io.fold(opts, working, meta, true, undefined, false, undefined, key) }
      catch (err) { folded = `escape retry failed: ${String(err)}` }
    }
  }
  if (typeof folded === 'string') {
    await io.logEvent('escape', { reason: folded })
    io.log(`clm: compaction job kept the transcript unchanged (${folded})`, { to: 'debug' })
    return undefined
  }
  await saveMeta(meta)
  extractLessons(io, folded.plan.dropped, folded.seq)
  return pendingFromFold(folded, working, Math.max(0, (await io.now()) - startedAt))
}

async function prepareMechanicalFold(io: FoldJobIo, opts: Opts, rows: readonly SessionMessage[], meta: Meta, key: string): Promise<Pending | undefined> {
  const previous = (await io.readLedger()) ?? EMPTY_LEDGER
  const notes = notesOf(previous)
  const plan = planClear(rows, Math.max(0, opts.tailTarget / (meta.ratio ?? 1)), estTokens({ role: 'user', text: notes, toolUses: [] }) + 60)
  if (!plan) return undefined
  const kept = [...preservedLines(notes), ...withheldLines(plan.dropped)]
  const preserved = carryLegacyInstructions(fallbackLedger(notes, plan.dropped), instructionValues(notes), plan.dropped, await io.ledgerPath())
  const notesAfterFold = rememberPreserved(rememberOversize(preserved.notes, oversizeLines(plan.tail, plan.cuts)), kept)
  const fullNotes = rememberPreserved(rememberOversize(preserved.fullNotes, oversizeLines(plan.tail, plan.cuts)), kept)
  const keepFrom = rows.length - plan.tail.length
  const topicSnapshot = (await readLedgerSnapshots(io.readRewindIo(), key)).at(-1)
  return {
    notes: notesAfterFold, fullNotes, ops: [], seq: meta.seq + 1,
    ...(plan.tail[0] ? { keepFp: fingerprint(plan.tail[0]) } : {}), keepFrom,
    dropFps: plan.dropped.filter(message => !isLedgerRow(message) && !isSystemRow(message)).map(fingerprint),
    cuts: plan.cuts, keptTurns: plan.keptTurns, fallback: true, ...(topicSnapshot?.topics ? { topics: topicSnapshot.topics } : {}),
  }
}

async function startFoldJob(io: FoldJobIo, opts: Opts, rows: readonly SessionMessage[], meta: Meta, key: string, turnEnd: boolean): Promise<FoldJob> {
  const current = foldJobs.get(key)
  if (current && current.state !== 'idle') return current
  const first = protectedIndex(rows)
  const turns = queueTurns(rows, first)
  const self: { job?: FoldJob } = {}
  // A job outliving a swap holds pre-swap meta; only calibration may land, and only while the job is current.
  const saveMeta: SaveMeta = async ({ fails, ratio, overhead, lastObserved }) => {
    if (foldJobs.get(key) !== self.job) return
    await io.writeMeta({
      ...(await io.readMeta()), fails,
      ...(ratio === undefined ? {} : { ratio }), ...(overhead === undefined ? {} : { overhead }), ...(lastObserved === undefined ? {} : { lastObserved }),
    })
  }
  const work = !turnEnd
    ? prepareEngineFold(io, opts, rows, meta, key, saveMeta)
    : turns.length >= 2
      ? prepareBackgroundFold(io, opts, rows, meta, first, turns, key, saveMeta)
      : prepareSingleFold(io, opts, rows, meta, key, saveMeta)
  const job: Extract<FoldJob, { state: 'summarizing' }> = { state: 'summarizing', promise: work, fingerprints: rows.map(fingerprint) }
  self.job = job
  foldJobs.set(key, job)
  void job.promise.then(plan => {
    if (foldJobs.get(key) !== job) {
      void logFoldOutcome(io, `background fold plan dropped after its job was replaced for ${key}`)
      io.log('clm: background fold finished after its job was replaced; plan discarded', { to: 'debug' })
      return
    }
    foldJobs.set(key, plan ? { state: 'ready', plan, fingerprints: job.fingerprints } : { state: 'idle' })
    void (async () => {
      const pending = await io.pendingKey(key)
      if (plan) await io.storeSet(pending, plan)
      else await io.storeDelete(pending)
    })().catch(async err => { await logPersistenceFailure(io, err) })
  }, err => {
    if (foldJobs.get(key) !== job) return
    foldJobs.delete(key)
    void io.pendingKey(key).then(pending => io.storeDelete(pending)).catch(storeError => logPersistenceFailure(io, storeError))
    void logFoldOutcome(io, `background fold failed (${String(err).slice(0, 1000)})`)
    io.log(`clm: background fold failed (${String(err)})`, { to: 'debug' })
  })
  return job
}

type ReadyFoldIo = Pick<FoldJobIo, 'sessionId' | 'sessionMessages' | 'readMeta' | 'usageReading' | 'sessionCompact' | 'logEvent' | 'log'>

export async function applyReadyIfAtThreshold(io: ReadyFoldIo, opts: Opts, key: string): Promise<boolean> {
  const job = foldJobs.get(key)
  if (job?.state !== 'ready') return false
  if (!job.plan.rewindOnly) {
    const meta = await io.readMeta()
    const rows = liveRows(await io.sessionMessages(), meta.boundary)
    if (!atFoldPoint(rows, await io.usageReading(), meta, opts)) return false
  }
  try { await io.sessionCompact() }
  catch (err) {
    await logFoldOutcome(io, `ready fold swap deferred (${String(err).slice(0, 1000)})`)
    io.log(`clm: ready fold swap deferred (${String(err)})`, { to: 'debug' })
  }
  return true
}

// The host refuses session.compact from a tool.call hook, so mid-turn callers
// pass canSwap=false and leave a ready plan to the engine's own compaction.
export async function maybeClear(io: FoldJobIo, opts: Opts, canSwap = true): Promise<void> {
  const key = transcriptKey(await io.sessionId())
  const current = foldJobs.get(key)
  if (current?.state === 'ready') {
    if (canSwap) await applyReadyIfAtThreshold(io, opts, key)
    return
  }
  if (current && current.state !== 'idle') return
  const meta = await io.readMeta()
  const rows = liveRows(await io.sessionMessages(), meta.boundary)
  const used = await io.usageReading()
  if (used !== undefined && meta.firstObserved === undefined) {
    calibrateFirstReading(meta, rows, used)
    await io.writeMeta(meta)
  }
  const first = protectedIndex(rows)
  const queue = rows.slice(first + 1)
  if (sum(queue) < opts.queueTarget) return
  if (used !== undefined && !atFoldPoint(rows, used, meta, opts)) return
  void startFoldJob(io, opts, rows, meta, key, true).catch(async err => {
    await logFoldOutcome(io, `background fold failed (${String(err).slice(0, 1000)})`)
    io.log(`clm: background fold failed (${String(err)})`, { to: 'debug' })
  })
}

// The confirm question is asked against the tracker as it stands when the fold
// lands, not when it started: the user may have answered or closed the
// question while the merge ran. Closed confirm questions stay in view so their
// stored denials keep holding.
function landedAsks(asks: readonly Payload[], landing: readonly Payload[], before: readonly Issue[], here: Origin): Payload[] {
  const session = before.filter(issue => issue.origin.session === here.session)
  const shown = injected(before, here)
  const issues = [...shown, ...session.filter(issue => issue.title.startsWith(CONFIRM_PREFIX) && !shown.includes(issue))]
  const doneTitles = new Set(session.filter(issue => issue.status === 'done').map(issue => issue.title.trim()))
  return confirmQuestion(asks, landing, issues, doneTitles)
}

async function applyFoldPlan(
  io: FoldJobIo, workingRows: readonly SessionMessage[], meta: Meta, first: number, use: Pending, escaped: boolean,
  startedAt: number, key: string, opts: Opts,
): Promise<SwapResult> {
  const rewind = io.readRewindIo()
  const here = await io.captureOrigin()
  const landing = [...use.ops, ...(use.promoted ?? [])]
  const appended = await persistStep<TrackerEvent[]>(io, [], () => io.append(use.asks ? before => [...landing, ...landedAsks(use.asks ?? [], landing, before, here)] : landing, here, false, true))
  await persistStep<void>(io, undefined, () => io.updateHeld(use.settled ?? [], use.hold ?? []))
  const stateEvents = await io.readAll()
  const currentView = await io.trackerView(here)
  const liveIssues = snapshot(stateEvents).filter(issue => issue.origin.session === here.session)
  const liveFocus = focusOf(stateEvents, here.session)
  const fileLedger = composeLedger(use.fullNotes, currentView.issues)
  const ledger = await persistStep(io, fileLedger, () => io.residentLedger(key, liveIssues, liveFocus, stateEvents, { notes: use.fullNotes, topics: use.topics, issues: liveIssues, state: liveFocus, clauses: use.clauses }))
  const text = ledgerRowText(use.seq, kst(), await io.ledgerPath(), ledger, opts.ledgerTarget)
  const ledgerRow: SessionMessage = { role: 'user', text, toolUses: [] }
  const headGroup = keepsHeadGroup(workingRows, first)
  const { rows: attachments, headKept } = await persistStep(io, { rows: [], headKept: headGroup }, () => io.stableAttachments(headGroup))
  const messages = buildCleared({ head: headRows(workingRows, first), tail: workingRows.slice(use.keepFrom), cuts: use.cuts }, ledgerRow, attachments, headKept)
  const declined = notShrunk(workingRows, messages)
  if (declined) return declined
  const tokensBefore = sum(workingRows)
  const tokensAfter = sum(messages)
  const offset = messages.findIndex(message => message.text === text)
  const result = { messages, tokensBefore, tokensAfter }
  return persistCompactResult(io, result, async () => {
    await io.writeFile(await io.ledgerPath(), fileLedger + '\n')
    if (use.clauses) await io.serialize(here.session, () => io.storeSet(clauseStoreKey(key), use.clauses))
    const topicKey = await io.topicsKey(key)
    if (use.topics) await io.storeSet(topicKey, use.topics)
    else await io.storeDelete(topicKey)
    const previousSnapshot = (await readLedgerSnapshots(rewind, key)).at(-1)
    await saveLedgerSnapshot(rewind, key, use.seq, fingerprint(ledgerRow), fileLedger, use.topics, [
      ...(use.coveredRows ?? previousSnapshot?.coveredRows ?? []), ...use.dropFps,
    ])
    await io.storeSet(transcriptRowsKey(key), messages.map(fingerprint))
    await pruneWithheld(io, escaped ? workingRows : messages, fileLedger)
    const foldedAt = await io.now()
    const swapMs = Math.max(0, foldedAt - startedAt)
    await io.writeMeta({
      ...meta, seq: use.seq, lastClear: kst(), lastFoldAt: foldedAt,
      foldDurationsMs: { ...meta.foldDurationsMs, [String(use.seq)]: swapMs }, foldTokens: await io.usageReading(),
      lastSkip: undefined, boundary: { fp: fingerprint(ledgerRow), offset },
    })
    await io.markStableAttachmentsCarried(use.seq, attachments, headKept)
    await io.logEvent('clear', {
      tokensBefore, tokensAfter, keptTurns: use.keptTurns, ratio: meta.ratio ?? 1,
      durationMs: swapMs, ...(use.summaryMs === undefined ? {} : { summaryMs: use.summaryMs }),
      reason: `${escaped ? 'escape' : 'clm'}${use.fallback ? ', fallback ledger' : ''}`,
    })
    await io.projectPanel(here, appended)
  })
}

async function applyRewindPlan(io: FoldJobIo, rows: readonly SessionMessage[], meta: Meta, first: number, use: Pending, key: string, opts: Opts, mayGrow: boolean): Promise<SwapResult> {
  const rewind = io.readRewindIo()
  const here = await io.captureOrigin()
  const stateEvents = await io.readAll()
  const view = await io.trackerView(here)
  const liveIssues = snapshot(stateEvents).filter(issue => issue.origin.session === here.session)
  const liveFocus = focusOf(stateEvents, here.session)
  const fullLedger = composeLedger(use.fullNotes, view.issues)
  const ledger = await persistStep(io, fullLedger, () => io.residentLedger(key, liveIssues, liveFocus, stateEvents, { notes: use.fullNotes, topics: use.topics, issues: liveIssues, state: liveFocus, clauses: use.clauses }))
  const text = ledgerRowText(use.seq, kst(), await io.ledgerPath(), ledger, opts.ledgerTarget)
  const row: SessionMessage = { role: 'user', text, toolUses: [] }
  const plan: ClearPlan = {
    head: rows.slice(0, first + 1).filter(message => !isLedgerRow(message)), dropped: [],
    tail: rows.slice(first + 1).filter(message => !isLedgerRow(message)), keptTurns: 0, cuts: {},
  }
  const headGroup = keepsHeadGroup(rows, first)
  const { rows: attachments, headKept } = await persistStep(io, { rows: [], headKept: headGroup }, () => io.stableAttachments(headGroup))
  const messages = buildCleared(plan, row, attachments, headKept)
  const declined = mayGrow ? undefined : notShrunk(rows, messages)
  if (declined) return declined
  const result = { messages, tokensBefore: sum(rows), tokensAfter: sum(messages) }
  const offset = messages.findIndex(message => message.text === text)
  return persistCompactResult(io, result, async () => {
    await io.writeFile(await io.ledgerPath(), fullLedger + '\n')
    if (use.clauses) await io.serialize(here.session, () => io.storeSet(clauseStoreKey(key), use.clauses))
    const topicKey = await io.topicsKey(key)
    if (use.topics) await io.storeSet(topicKey, use.topics)
    await saveLedgerSnapshot(rewind, key, use.seq, fingerprint(row), fullLedger, use.topics, use.coveredRows ?? [])
    await io.writeMeta({ ...meta, seq: use.seq, lastClear: kst(), boundary: { fp: fingerprint(row), offset } })
    await io.markStableAttachmentsCarried(use.seq, attachments, headKept)
    await io.storeSet(transcriptRowsKey(key), messages.map(fingerprint))
  })
}

export async function showTurnChanges(io: FoldJobIo, answer: string): Promise<void> {
  if (!answer.trim()) return
  const session = await io.sessionId()
  const meta = await io.readMeta()
  const rows = liveRows(await io.sessionMessages(), meta.boundary)
  const hasToolUse = rows.slice(-8).some(message => message.toolUses.length > 0 || (message.toolResults?.length ?? 0) > 0)
  if (!hasToolUse && answer.trim().length < 200) return
  try {
    const stored = notesOf((await io.readLedger()) ?? EMPTY_LEDGER)
    const ledger = `${mergeableNotes(stored)}\n\n## 핵심 사실·경로\n${factLines(stored).map(line => `- ${line}`).join('\n') || '- (none yet)'}`
    const prompt = `<ledger_goal_and_key_facts>\n${ledger}\n</ledger_goal_and_key_facts>\n<finished_turn>\n${renderTurns(rows.slice(-8), 20000, await io.sentAt())}\n</finished_turn>`
    const response = await io.complete({ model: 'haiku', system: TURN_CHANGE_SYSTEM, prompt, maxTokens: 300, timeoutMs: 15000 })
    if (!response.isAnswered) return
    const seen = shownChanges.get(session) ?? new Set<string>()
    shownChanges.set(session, seen)
    for (const line of parseChanges(response.text)) {
      const key = changeHash(line)
      if (seen.has(key)) continue
      seen.add(key)
      io.log('맥락 갱신: ' + line)
    }
  } catch (err) {
    io.log(`clm: turn context refresh failed (${String(err)})`, { to: 'debug' })
  }
}

async function awaitOrFallback(
  io: FoldJobIo, opts: Opts, job: Extract<FoldJob, { state: 'summarizing' }>, rows: readonly SessionMessage[], meta: Meta, key: string, compactStartedAt: number,
): Promise<Pending | undefined> {
  const remaining = Math.max(0, COMPACT_DEADLINE_MS - ((await io.now()) - compactStartedAt))
  const late = Symbol('late')
  let timer: { cancel(): void } | undefined
  const raced = await Promise.race([
    job.promise.catch(() => late),
    new Promise<typeof late>(resolve => { timer = io.after(remaining, () => resolve(late)) }),
  ]).finally(() => timer?.cancel())
  if (raced !== late) return raced
  io.log(`clm: compaction summary not ready ${COMPACT_DEADLINE_MS}ms after compact began; folding mechanically`, { to: 'debug' })
  return prepareMechanicalFold(io, opts, rows, meta, key)
}

// The engine records any returned list as a finished compaction, so a decline
// that handed the rows back unchanged left autocompact firing on every turn
// until it reported thrashing. Every decline goes to the engine summarizer.
export async function handOff(io: FoldJobIo, key: string, handoff: () => Promise<SessionCompactResult>, why: string): Promise<SessionCompactResult> {
  try { io.log(`clm: ${why}; the engine summarizer compacts instead`, { to: 'debug' }) } catch { /* logging never blocks compaction */ }
  await persistStep<void>(io, undefined, () => io.backfillClauses(key))
  const result = await handoff()
  const store = readClauseStore(await persistStep(io, undefined, () => io.storeGet(clauseStoreKey(key)))) ?? emptyClauseStore()
  const clauses = renderClauses(store, () => true, 40)
  const messages = result.messages?.length
    ? [result.messages[0]!, { role: 'user' as const, text: `[clm clauses]\n${clauses.join('\n') || '- (none)'}`, toolUses: [] }, ...result.messages.slice(1).filter(row => !row.text.startsWith('[clm clauses]'))]
    : result.messages
  const kept = messages ? { ...result, messages } : result
  await adoptEngineSummary(io, key, messages)
  return kept
}

export async function handleSessionCompact(
  io: FoldJobIo, opts: Opts, all: readonly SessionMessage[], trigger: string, handoff: () => Promise<SessionCompactResult>,
): Promise<SessionCompactResult> {
  // The engine's compactor runs at most once per event, however many paths decline.
  let handed: Promise<SessionCompactResult> | undefined
  // Set before the call, so even a synchronous throw from it leaves no path to a second call.
  const once = () => handed ??= Promise.resolve().then(handoff)
  try { return await compactOrHandOff(io, opts, all, trigger, once) }
  catch (err) {
    if (handed) return handed
    const key = await Promise.resolve().then(() => io.sessionId()).then(transcriptKey, () => undefined)
    const why = `the clm compaction failed (${String(err).slice(0, 160)})`
    return key === undefined ? once() : handOff(io, key, once, why)
  }
}

async function compactOrHandOff(
  io: FoldJobIo, opts: Opts, all: readonly SessionMessage[], trigger: string, handoff: () => Promise<SessionCompactResult>,
): Promise<SessionCompactResult> {
  const compactStartedAt = await io.now()
  const key = transcriptKey(await io.sessionId())
  const entryState: CompactEntryState = foldJobs.get(key)?.state ?? 'none'
  const meta = await persistStep(io, { seq: 0, fails: 0 }, () => io.readMeta())
  const workingRows = liveRows(all, meta.boundary)
  const first = protectedIndex(workingRows)
  const decline = (outcome: string, why: string) => compactResult(io, compactStartedAt, trigger, entryState, outcome, handOff(io, key, handoff, why))
  const ensureShrunk = (result: Promise<SwapResult>) => result.then(done => 'notShrunk' in done ? handOff(io, key, handoff, done.notShrunk) : done)
  // The swap may belong to a plugin rewind that was allowed to grow; an engine event joining it still has to shrink.
  const joined = (result: Promise<SwapResult>) => compactResult(io, compactStartedAt, trigger, entryState, 'joined-swap', ensureShrunk(result).then(done => {
    const declined = trigger === 'plugin' || done.skip !== undefined ? undefined : notShrunk(workingRows, done.messages ?? [])
    return declined ? handOff(io, key, handoff, declined.notShrunk) : done
  }))
  await persistStep<void>(io, undefined, () => io.observeTranscript(key, all))
  const existing = foldJobs.get(key)
  if (existing?.state === 'swapping') return joined(existing.promise)
  if (trigger === 'plugin' && (!existing || existing.state === 'idle')) return decline('plugin-handoff', 'a plugin compaction found no clm plan')
  const job = !existing || existing.state === 'idle' ? await startFoldJob(io, opts, workingRows, meta, key, false) : existing
  if (job.state === 'swapping') return joined(job.promise)
  let plan = job.state === 'ready' ? job.plan
    : job.state === 'summarizing' ? await awaitOrFallback(io, opts, job, workingRows, meta, key, compactStartedAt) : undefined
  if (!plan) return decline('handoff-no-plan', 'clm had no fold plan')
  const current = foldJobs.get(key)
  if (current?.state === 'swapping') return joined(current.promise)
  if (current?.state === 'ready' && current !== existing) plan = current.plan
  const keepFrom = plan.keepFrom
  const row = keepFrom < workingRows.length ? workingRows[keepFrom] : undefined
  const expectedDropped = foldedRows(workingRows, first, keepFrom).map(fingerprint)
  const sameDropped = expectedDropped.length === plan.dropFps.length && expectedDropped.every((fp, index) => fp === plan.dropFps[index])
  const sameKept = plan.keepFp === undefined ? keepFrom === workingRows.length : row !== undefined && fingerprint(row) === plan.keepFp
  if (keepFrom < first + 1 || keepFrom > workingRows.length || !sameKept || !sameDropped) {
    await logFoldOutcome(io, 'background fold plan dropped because the transcript changed before swap')
    foldJobs.set(key, { state: 'idle' })
    try { await io.storeDelete(await io.pendingKey(key)) }
    catch (err) { await logPersistenceFailure(io, err) }
    return decline('handoff-changed', 'the transcript changed before the clm swap')
  }
  const use = { ...plan, keepFrom }
  let waitMs: number | undefined
  try { waitMs = Math.max(0, (await io.now()) - compactStartedAt) }
  catch (err) { try { io.log(`clm: compaction timing failed (${String(err).slice(0, 160)})`, { to: 'debug' }) } catch { /* timing never blocks compaction */ } }
  const swap = Promise.resolve().then(async (): Promise<SwapResult> => {
    try {
      // A rewind restore clm itself asked for may grow the rows; every other swap must shrink them.
      return use.rewindOnly
        ? await applyRewindPlan(io, workingRows, meta, first, use, key, opts, trigger === 'plugin')
        : await applyFoldPlan(io, workingRows, meta, first, use, false, compactStartedAt, key, opts)
    } finally {
      foldJobs.set(key, { state: 'idle' })
      try { await io.storeDelete(await io.pendingKey(key)) }
      catch (err) { await logPersistenceFailure(io, err) }
    }
  })
  foldJobs.set(key, { state: 'swapping', promise: swap })
  return compactResult(io, compactStartedAt, trigger, entryState, use.fallback ? 'swap-mechanical' : 'swap', ensureShrunk(swap), waitMs)
}

export function report(ledger: string | undefined, rows: readonly SessionMessage[], opts: Opts, meta: Meta, logTail: readonly string[]): string {
  const used = Math.round(foldableTokens(rows, undefined, meta))
  return [
    `clm budget: ${used}/${opts.budget} tokens (${Math.round((used / opts.budget) * 100)}%); escape at ${opts.budget - opts.reserve}, queue target ${opts.queueTarget}, tail target ${opts.tailTarget}, ledger target ${opts.ledgerTarget}, ratio ${meta.ratio ?? 1}`,
    `rows: ${rows.filter(message => !isSystemRow(message)).length} kept, ${rows.filter(isSystemRow).length} hidden system rows`,
    `last fold: ${meta.lastClear ?? 'never'} (ledger #${meta.seq})${meta.lastSkip ? `; last skip: ${meta.lastSkip}` : ''}`,
    '', ledger ?? '(no ledger yet)', '', 'recent decisions:', ...(logTail.length ? logTail : ['(none)']),
  ].join('\n')
}

async function keepEscapedInstructions(io: FoldJobIo, rows: readonly SessionMessage[]): Promise<void> {
  try {
    const path = await io.ledgerPath()
    const notes = notesOf((await io.readFile(path)) ?? EMPTY_LEDGER)
    const preserved = carryLegacyInstructions(notes, instructionValues(notes), rows.slice(protectedIndex(rows)), path)
    const view = await io.trackerView(await io.captureOrigin())
    await io.writeFile(path, composeLedger(preserved.fullNotes, view.issues) + '\n')
  } catch (err) {
    await io.logEvent('escape-instructions-lost', { reason: String(err) })
  }
}

async function pruneWithheld(io: FoldJobIo, live: readonly SessionMessage[], ledger = ''): Promise<void> {
  try {
    const base = await io.basePath()
    const dir = base.slice(0, base.lastIndexOf('/'))
    const prefix = base.slice(dir.length + 1) + WITHHELD
    if (!(await io.fileExists(dir))) return
    const pointed = [ledger, ...live.flatMap(message => (message.toolResults ?? []).map(result => result.text))].join('\n')
    const stale = (await io.fileList(dir)).filter(file => file.kind === 'file' && file.name.startsWith(prefix) && !pointed.includes(`${dir}/${file.name}`)).map(file => `${dir}/${file.name}`)
    if (stale.length === 0) return
    const result = await io.run(['rm', '-f', '--', ...stale], { timeoutMs: 5000 })
    if (result.exitCode !== 0) io.log(`clm escape: could not remove ${stale.length} withheld file(s) (exit ${result.exitCode}: ${result.stderr})`, { to: 'debug' })
  } catch (err) {
    io.log(`clm escape: withheld-file cleanup failed (${String(err)})`, { to: 'debug' })
  }
}

async function withholdOldestResults(io: FoldJobIo, rows: readonly SessionMessage[], opts: Opts): Promise<readonly SessionMessage[] | undefined> {
  if (!rows.some(message => message.toolResults?.length)) return undefined
  await pruneWithheld(io, rows, (await io.readLedger()) ?? '')
  const current = [...rows]
  const limit = opts.budget - opts.reserve
  const base = await io.basePath()
  let n = 0
  for (const [rowIndex, row] of rows.entries()) {
    let updated = row
    for (const result of row.toolResults ?? []) {
      const index = n++
      if (result.text.startsWith('[clm escape:')) continue
      const path = `${base}${WITHHELD}${index}-${result.tool_use_id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.txt`
      try { await io.writeFile(path, result.text) }
      catch (err) {
        io.log(`clm escape: could not preserve tool result at ${path} (${String(err)})`, { to: 'debug' })
        continue
      }
      updated = {
        role: updated.role, text: updated.text, toolUses: updated.toolUses,
        toolResults: (updated.toolResults ?? []).map(item => item.tool_use_id === result.tool_use_id ? { ...item, text: withheldPointer(path) } : item),
      }
      current[rowIndex] = updated
      if (sum(current) <= limit) return current
    }
  }
  return current
}

export type { Pending }
