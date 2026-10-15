import type { SessionMessage, SessionCompactResult } from 'claude-code'
import {
  buildCleared, fingerprint, isHarnessText, isLedgerRow, isPrompt, isSystemRow, kst, ledgerRowText, liveRows, planClear,
  protectedIndex, sum, visibleTokens, type ClearPlan,
} from './fold'
import { renderRange } from './evidence'
import {
  composeLedger, EMPTY_LEDGER, factLines, instructionValues, mergeableNotes, notesOf, parseChanges, parseMerge,
  preserveInstructions, renderTurns, SPLIT_MERGE_SYSTEM, withheldPointer,
} from './ledger'
import { focusOf, snapshot, type Issue, type Origin, type Payload, type TrackerEvent } from './tracker'
import type { Held } from './held'
import type { Fold, FoldPreview, Meta, Opts, PreparedFold, TopicState, TrackerView } from './fold-runtime'
import { parseSplitAnswer } from './fold-runtime'
import { readLedgerSnapshots, saveLedgerSnapshot, type RewindIo, type RewindPlan } from './rewind'
import type { LogEvent, LogFields } from './events'

type Pending = {
  notes: string; fullNotes: string; ops: Payload[]; seq: number; keepFp?: string; keepFrom: number; dropFps: string[]
  cuts: Record<string, number>; keptTurns: number; fallback: boolean; summaryMs?: number; topics?: TopicState[]
  rewindOnly?: boolean; promoted?: Payload[]; hold?: Held[]; settled?: string[]; coveredRows?: string[]
}
type FoldJob =
  | { state: 'idle' }
  | { state: 'summarizing'; promise: Promise<Pending | undefined>; fingerprints: string[]; turnEnd: boolean }
  | { state: 'ready'; plan: Pending; fingerprints: string[]; turnEnd: boolean }
  | { state: 'swapping'; promise: Promise<SessionCompactResult> }
type QueueTurn = { number: number; start: number; rows: readonly SessionMessage[] }
const TURN_CHANGE_SYSTEM = 'Summarize only concrete non-task context changes from the finished coding turn. Reply with <changes>, at most three short Korean lines, or <changes></changes> when nothing changed.'

export type FoldJobIo = {
  sessionId(): Promise<string>
  sessionMessages(): Promise<SessionMessage[]>
  sessionCompact(): Promise<SessionCompactResult>
  now(): Promise<number>
  usageReading(): Promise<number | undefined>
  readMeta(): Promise<Meta>
  writeMeta(meta: Meta): Promise<void>
  readLedger(): Promise<string | undefined>
  ledgerPath(): Promise<string>
  logPath(): Promise<string>
  basePath(): Promise<string>
  readFile(path: string): Promise<string | undefined>
  writeFile(path: string, text: string): Promise<void>
  fileExists(path: string): Promise<boolean>
  fileList(path: string): Promise<{ name: string; kind: string }[]>
  run(args: string[], options: { timeoutMs: number }): Promise<{ exitCode: number; stderr: string }>
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
  storeDelete(key: string): Promise<void>
  pendingKey(key: string): Promise<string>
  topicsKey(key: string): Promise<string>
  captureOrigin(): Promise<Origin>
  readAll(): Promise<TrackerEvent[]>
  trackerView(origin: Origin, ops?: readonly Payload[]): Promise<TrackerView>
  readHeld(): Promise<Held[]>
  updateHeld(settled: readonly string[], hold: readonly Held[]): Promise<void>
  ensureInstructionIndex(key: string, notes: string): Promise<void>
  residentLedger(key: string, issues: readonly Issue[], state: { stack: string[]; pending: string[] }, events: readonly TrackerEvent[], preview?: FoldPreview): Promise<string>
  append(payloads: readonly Payload[], origin: Origin, project: boolean, knownTitles: boolean): Promise<TrackerEvent[]>
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
const transcriptRowsKey = (key: string) => `transcript-rows:${key}`
const WITHHELD = '.withheld-'
const shownChanges = new Map<string, Set<string>>()
const changeHash = (line: string): string => {
  let h = 2166136261
  for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16)
}
const xmlText = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const isPromptStart = (message: SessionMessage) => isPrompt(message) && !isHarnessText(message.text)

export function foldJobDropFps(key: string): string[] | undefined {
  const job = foldJobs.get(key)
  return job?.state === 'ready' ? job.plan.dropFps : undefined
}

export function clearFoldJob(key: string): void {
  foldJobs.set(key, { state: 'idle' })
}

export function setRewindFoldJob(key: string, plan: RewindPlan, fingerprints: string[]): void {
  foldJobs.set(key, { state: 'ready', plan, fingerprints, turnEnd: false })
}

function queueTurns(rows: readonly SessionMessage[], first: number): QueueTurn[] {
  const start = first + 1
  const queue = rows.slice(start)
  const prompts = queue.flatMap((message, index) => isPromptStart(message) ? [index] : [])
  return prompts.map((prompt, index) => {
    const from = index === 0 ? 0 : prompt
    const to = prompts[index + 1] ?? queue.length
    return { number: index + 1, start: start + prompt, rows: queue.slice(from, to).filter(message => !isLedgerRow(message)) }
  })
}

function splitPrompt(previous: string, turns: readonly QueueTurn[], retryRule: string): string {
  let refOffset = 0
  const numbered = turns.map(turn => {
    const citable = turn.rows.filter(message => !isSystemRow(message) && !isLedgerRow(message))
    const rendered = renderRange(citable, 120_000, refOffset).text
    refOffset += citable.length
    return `<turn number="${turn.number}" tokens="${sum(turn.rows)}">\n${xmlText(rendered)}\n</turn>`
  }).join('\n')
  return [
    `<current_ledger>\n${xmlText(previous)}\n</current_ledger>`,
    `<queue_turns>\n${numbered}\n</queue_turns>`,
    retryRule ? `<retry_rule>\n${xmlText(retryRule)}\n</retry_rule>` : '',
  ].filter(Boolean).join('\n\n')
}

async function prepareBackgroundFold(io: FoldJobIo, opts: Opts, rows: readonly SessionMessage[], meta: Meta, first: number, turns: readonly QueueTurn[], key: string): Promise<Pending | undefined> {
  const session = await io.sessionId()
  const startedAt = await io.now()
  const previous = (await io.readLedger()) ?? EMPTY_LEDGER
  const here = await io.captureOrigin()
  const view = await io.trackerView(here)
  const known = new Set([...view.issues, ...view.dropped].map(issue => issue.id))
  let retryRule = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await io.complete({ model: opts.model, system: SPLIT_MERGE_SYSTEM, prompt: splitPrompt(previous, turns, retryRule), maxTokens: 8192, timeoutMs: 120_000 })
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
      head: rows.slice(0, first + 1),
      dropped: rows.slice(first + 1, keepFrom).filter(message => !isLedgerRow(message) && !isSystemRow(message)),
      tail: rows.slice(keepFrom), keptTurns: turns.length - answer.split + 1, cuts: {},
    }
    if (plan.dropped.length === 0) {
      retryRule = `The previous split=${answer.split} left A empty. Choose split from 2 through ${turns.length}.`
      if (attempt === 1) io.log(`clm: split summary rejected (${retryRule}); the next turn end may retry`, { to: 'debug' })
      continue
    }
    const merge = parseMerge(answer.mergeReply, known, Math.max(500, Math.floor(opts.budget / 4)), instructionValues(notesOf(previous)), factLines(notesOf(previous)))
    if (typeof merge === 'string') {
      retryRule = `The previous summary failed validation: ${merge}. Return valid note sections and ops in the required JSON object.`
      if (attempt === 1) io.log(`clm: split summary rejected (${merge}); the next turn end may retry`, { to: 'debug' })
      continue
    }
    const prepared: PreparedFold = { plan, mergeReply: answer.mergeReply, topics: answer.topics.map(({ topic, summary }) => ({ topic, summary })) }
    const folded = await io.fold(opts, rows, meta, false, undefined, true, prepared, key)
    if (typeof folded === 'string') {
      await io.writeMeta(meta)
      io.log(`clm: background fold skipped (${folded})`, { to: 'debug' })
      return undefined
    }
    if (folded.tailTokens > opts.tailTarget) {
      retryRule = `The previous split=${answer.split} produced ${folded.tailTokens} tokens for the new ledger plus B, above tailTarget=${opts.tailTarget}; choose an earlier whole-topic boundary or shorter summaries.`
      if (attempt === 1) {
        io.log(`clm: split summary dropped (${retryRule}); the next turn end may retry`, { to: 'debug' })
        return undefined
      }
      continue
    }
    await io.writeMeta(meta)
    const summaryMs = Math.max(0, (await io.now()) - startedAt)
    return {
      notes: folded.notes, fullNotes: folded.fullNotes, ops: folded.ops, seq: folded.seq,
      ...(folded.plan.tail[0] ? { keepFp: fingerprint(folded.plan.tail[0]) } : {}),
      keepFrom: rows.length - folded.plan.tail.length,
      dropFps: folded.plan.dropped.filter(message => !isLedgerRow(message) && !isSystemRow(message)).map(fingerprint),
      cuts: folded.plan.cuts, keptTurns: folded.plan.keptTurns, fallback: folded.fallback, summaryMs, topics: folded.topics,
      promoted: folded.promoted, hold: folded.hold, settled: folded.settled,
    }
  }
  io.log(`clm: background fold gave up for ${session}`, { to: 'debug' })
  return undefined
}

function pendingFromFold(folded: Fold, rows: readonly SessionMessage[], summaryMs: number): Pending {
  const keepFrom = rows.length - folded.plan.tail.length
  const keptRow = rows[keepFrom]
  return {
    notes: folded.notes, fullNotes: folded.fullNotes, ops: folded.ops, seq: folded.seq,
    ...(keptRow ? { keepFp: fingerprint(keptRow) } : {}), keepFrom,
    dropFps: folded.plan.dropped.filter(message => !isLedgerRow(message) && !isSystemRow(message)).map(fingerprint),
    cuts: folded.plan.cuts, keptTurns: folded.plan.keptTurns, fallback: folded.fallback, summaryMs, topics: folded.topics,
    promoted: folded.promoted, hold: folded.hold, settled: folded.settled,
  }
}

async function prepareEngineFold(io: FoldJobIo, opts: Opts, rows: readonly SessionMessage[], meta: Meta, key: string): Promise<Pending | undefined> {
  const startedAt = await io.now()
  let working = rows
  let folded: Fold | string
  try { folded = await io.fold(opts, working, meta, false, undefined, true, undefined, key) }
  catch (err) { folded = `fold failed: ${String(err).slice(0, 160)}` }
  if (typeof folded === 'string') {
    const escaped = await withholdOldestResults(io, working, opts)
    if (escaped) {
      working = escaped
      try { folded = await io.fold(opts, working, meta, true, undefined, false, undefined, key) }
      catch (err) { folded = `escape retry failed: ${String(err).slice(0, 160)}` }
    }
  }
  if (typeof folded === 'string') {
    await io.logEvent('escape', { reason: folded })
    io.log(`clm: compaction job kept the transcript unchanged (${folded})`, { to: 'debug' })
    return undefined
  }
  await io.writeMeta(meta)
  return pendingFromFold(folded, working, Math.max(0, (await io.now()) - startedAt))
}

async function startFoldJob(io: FoldJobIo, opts: Opts, rows: readonly SessionMessage[], meta: Meta, key: string, turnEnd: boolean): Promise<FoldJob> {
  const current = foldJobs.get(key)
  if (current && current.state !== 'idle') return current
  const first = protectedIndex(rows)
  const turns = queueTurns(rows, first)
  const work = turnEnd
    ? prepareBackgroundFold(io, opts, rows, meta, first, turns, key)
    : prepareEngineFold(io, opts, rows, meta, key)
  const job: Extract<FoldJob, { state: 'summarizing' }> = { state: 'summarizing', promise: work, fingerprints: rows.map(fingerprint), turnEnd }
  foldJobs.set(key, job)
  void job.promise.then(plan => {
    if (foldJobs.get(key) === job) {
      foldJobs.set(key, plan ? { state: 'ready', plan, fingerprints: job.fingerprints, turnEnd: job.turnEnd } : { state: 'idle' })
      void (async () => {
        const pending = await io.pendingKey(key)
        if (plan) await io.storeSet(pending, plan)
        else await io.storeDelete(pending)
      })()
    }
  }, err => {
    if (foldJobs.get(key) === job) {
      foldJobs.delete(key)
      void io.pendingKey(key).then(pending => io.storeDelete(pending))
    }
    io.log(`clm: background fold failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  })
  return job
}

async function applyReadyIfAtThreshold(io: FoldJobIo, opts: Opts, key: string): Promise<boolean> {
  const job = foldJobs.get(key)
  if (job?.state !== 'ready') return false
  if (!job.plan.rewindOnly && (await io.usageReading() ?? 0) < opts.budget - opts.reserve) return false
  try { await io.sessionCompact() }
  catch (err) { io.log(`clm: ready fold swap deferred (${String(err).slice(0, 160)})`, { to: 'debug' }) }
  return true
}

export async function maybeClear(io: FoldJobIo, opts: Opts): Promise<void> {
  const key = transcriptKey(await io.sessionId())
  const current = foldJobs.get(key)
  if (current?.state === 'ready') {
    await applyReadyIfAtThreshold(io, opts, key)
    return
  }
  if (current && current.state !== 'idle') return
  const meta = await io.readMeta()
  const rows = liveRows(await io.sessionMessages(), meta.boundary)
  const first = protectedIndex(rows)
  const queue = rows.slice(first + 1)
  if (sum(queue) < opts.queueTarget) return
  const turns = queueTurns(rows, first)
  if (turns.length < 2) return
  void startFoldJob(io, opts, rows, meta, key, true).catch(err => io.log(`clm: background fold failed (${String(err).slice(0, 160)})`, { to: 'debug' }))
}

async function applyFoldPlan(
  io: FoldJobIo, workingRows: readonly SessionMessage[], meta: Meta, first: number, use: Pending, escaped: boolean,
  startedAt: number, key: string,
): Promise<SessionCompactResult> {
  const rewind = io.readRewindIo()
  const here = await io.captureOrigin()
  const appended = await io.append([...use.ops, ...(use.promoted ?? [])], here, false, true)
  await io.updateHeld(use.settled ?? [], use.hold ?? [])
  await io.ensureInstructionIndex(key, use.fullNotes)
  const stateEvents = await io.readAll()
  const currentView = await io.trackerView(here)
  const liveIssues = snapshot(stateEvents).filter(issue => issue.origin.session === here.session)
  const liveFocus = focusOf(stateEvents, here.session)
  const ledger = await io.residentLedger(key, liveIssues, liveFocus, stateEvents, { notes: use.fullNotes, topics: use.topics, issues: liveIssues, state: liveFocus })
  const fileLedger = composeLedger(use.fullNotes, currentView.issues)
  const text = ledgerRowText(use.seq, kst(), await io.ledgerPath(), ledger)
  const ledgerRow: SessionMessage = { role: 'user', text, toolUses: [] }
  const messages = buildCleared({ head: workingRows.slice(0, first + 1), tail: workingRows.slice(use.keepFrom), cuts: use.cuts }, ledgerRow)
  const tokensBefore = sum(workingRows)
  const tokensAfter = sum(messages)
  await io.writeFile(await io.ledgerPath(), fileLedger + '\n')
  const topicKey = await io.topicsKey(key)
  if (use.topics) await io.storeSet(topicKey, use.topics)
  else await io.storeDelete(topicKey)
  const previousSnapshot = (await readLedgerSnapshots(rewind, key)).at(-1)
  await saveLedgerSnapshot(rewind, key, use.seq, fingerprint(ledgerRow), fileLedger, use.topics, [
    ...(use.coveredRows ?? previousSnapshot?.coveredRows ?? []), ...use.dropFps,
  ])
  await io.storeSet(transcriptRowsKey(key), messages.map(fingerprint))
  await pruneWithheld(io, escaped ? workingRows : messages, fileLedger)
  const offset = messages.findIndex(message => message.text === text)
  const foldedAt = await io.now()
  const swapMs = Math.max(0, foldedAt - startedAt)
  await io.writeMeta({
    ...meta, seq: use.seq, lastClear: kst(), lastFoldAt: foldedAt,
    foldDurationsMs: { ...meta.foldDurationsMs, [String(use.seq)]: swapMs }, foldTokens: await io.usageReading(),
    lastSkip: undefined, boundary: { fp: fingerprint(ledgerRow), offset },
  })
  await io.logEvent('clear', {
    tokensBefore, tokensAfter, keptTurns: use.keptTurns, ratio: meta.ratio ?? 1,
    durationMs: swapMs, ...(use.summaryMs === undefined ? {} : { summaryMs: use.summaryMs }),
    reason: `${escaped ? 'escape' : 'clm'}${use.fallback ? ', fallback ledger' : ''}`,
  })
  await io.projectPanel(here, appended)
  return { messages, tokensBefore, tokensAfter }
}

async function applyRewindPlan(io: FoldJobIo, rows: readonly SessionMessage[], meta: Meta, first: number, use: Pending, key: string): Promise<SessionCompactResult> {
  const rewind = io.readRewindIo()
  const here = await io.captureOrigin()
  const stateEvents = await io.readAll()
  const view = await io.trackerView(here)
  const liveIssues = snapshot(stateEvents).filter(issue => issue.origin.session === here.session)
  const liveFocus = focusOf(stateEvents, here.session)
  const ledger = await io.residentLedger(key, liveIssues, liveFocus, stateEvents, { notes: use.fullNotes, topics: use.topics, issues: liveIssues, state: liveFocus })
  const fullLedger = composeLedger(use.fullNotes, view.issues)
  const text = ledgerRowText(use.seq, kst(), await io.ledgerPath(), ledger)
  const row: SessionMessage = { role: 'user', text, toolUses: [] }
  const plan: ClearPlan = {
    head: rows.slice(0, first + 1).filter(message => !isLedgerRow(message)), dropped: [],
    tail: rows.slice(first + 1).filter(message => !isLedgerRow(message)), keptTurns: 0, cuts: {},
  }
  const messages = buildCleared(plan, row)
  await io.writeFile(await io.ledgerPath(), fullLedger + '\n')
  const topicKey = await io.topicsKey(key)
  if (use.topics) await io.storeSet(topicKey, use.topics)
  await saveLedgerSnapshot(rewind, key, use.seq, fingerprint(row), fullLedger, use.topics, use.coveredRows ?? [])
  const offset = messages.findIndex(message => message.text === text)
  await io.writeMeta({ ...meta, seq: use.seq, lastClear: kst(), boundary: { fp: fingerprint(row), offset } })
  await io.storeSet(transcriptRowsKey(key), messages.map(fingerprint))
  return { messages, tokensBefore: sum(rows), tokensAfter: sum(messages) }
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
    const prompt = `<ledger_goal_and_key_facts>\n${ledger}\n</ledger_goal_and_key_facts>\n<finished_turn>\n${renderTurns(rows.slice(-8), 20000)}\n</finished_turn>`
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
    io.log(`clm: turn context refresh failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}

export async function handleSessionCompact(
  io: FoldJobIo, opts: Opts, all: readonly SessionMessage[], trigger: string,
): Promise<SessionCompactResult | { skip: string }> {
  if (trigger === 'precompute') return { skip: 'clm replaces compaction' }
  const compactStartedAt = await io.now()
  const meta = await io.readMeta()
  const workingRows = liveRows(all, meta.boundary)
  const first = protectedIndex(workingRows)
  const key = transcriptKey(await io.sessionId())
  await io.observeTranscript(key, all)
  const existing = foldJobs.get(key)
  if (existing?.state === 'summarizing') await existing.promise
  if (trigger === 'plugin' && (!existing || existing.state === 'idle')) return { messages: [...all] }
  let job = existing
  if (!job || job.state === 'idle') job = await startFoldJob(io, opts, workingRows, meta, key, false)
  if (job.state === 'swapping') return job.promise
  const plan = job.state === 'summarizing' ? await job.promise : job.state === 'ready' ? job.plan : undefined
  if (!plan) {
    foldJobs.set(key, { state: 'idle' })
    await io.storeDelete(await io.pendingKey(key))
    return { messages: [...all] }
  }
  if (!plan.rewindOnly && (await io.usageReading() ?? 0) < opts.budget - opts.reserve) return { messages: [...all] }
  const keepFrom = plan.keepFrom
  const row = keepFrom < workingRows.length ? workingRows[keepFrom] : undefined
  const expectedDropped = workingRows.slice(first + 1, keepFrom).filter(message => !isLedgerRow(message) && !isSystemRow(message)).map(fingerprint)
  const sameDropped = expectedDropped.length === plan.dropFps.length && expectedDropped.every((fp, index) => fp === plan.dropFps[index])
  const sameKept = plan.keepFp === undefined ? keepFrom === workingRows.length : row !== undefined && fingerprint(row) === plan.keepFp
  if (keepFrom < first + 1 || keepFrom > workingRows.length || !sameKept || !sameDropped) {
    io.log('clm: compaction job input changed before swap; transcript left untouched', { to: 'debug' })
    foldJobs.set(key, { state: 'idle' })
    await io.storeDelete(await io.pendingKey(key))
    return { messages: [...all] }
  }
  const use = { ...plan, keepFrom }
  const swap = (async (): Promise<SessionCompactResult> => {
    try {
      return use.rewindOnly
        ? await applyRewindPlan(io, workingRows, meta, first, use, key)
        : await applyFoldPlan(io, workingRows, meta, first, use, false, compactStartedAt, key)
    } finally {
      foldJobs.set(key, { state: 'idle' })
      await io.storeDelete(await io.pendingKey(key))
    }
  })()
  foldJobs.set(key, { state: 'swapping', promise: swap })
  return swap
}

export function report(ledger: string | undefined, rows: readonly SessionMessage[], opts: Opts, meta: Meta, logTail: readonly string[]): string {
  const used = Math.round(visibleTokens(rows) * (meta.ratio ?? 1))
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
    const preserved = preserveInstructions(notes, instructionValues(notes), rows.slice(protectedIndex(rows)), path)
    const view = await io.trackerView(await io.captureOrigin())
    await io.writeFile(path, composeLedger(preserved.fullNotes, view.issues) + '\n')
  } catch (err) {
    await io.logEvent('escape-instructions-lost', { reason: String(err).slice(0, 160) })
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
    if (result.exitCode !== 0) io.log(`clm escape: could not remove ${stale.length} withheld file(s) (exit ${result.exitCode}: ${result.stderr.slice(0, 160)})`, { to: 'debug' })
  } catch (err) {
    io.log(`clm escape: withheld-file cleanup failed (${String(err).slice(0, 160)})`, { to: 'debug' })
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
        io.log(`clm escape: could not preserve tool result at ${path} (${String(err).slice(0, 160)})`, { to: 'debug' })
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
