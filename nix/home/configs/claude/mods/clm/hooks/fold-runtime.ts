import type { SessionMessage } from 'claude-code'
import {
  buildCleared, estTokens, isLedgerRow, isSystemRow, isUserTyped, kst, ledgerRowText, planClear, stripReminders, sum, visibleTokens, TOKEN_ESTIMATOR_VERSION, type Boundary, type ClearPlan,
} from './fold'
import { confirmQuestion, renderRange, type Evidence, type Source } from './evidence'
import {
  EMPTY_LEDGER, fallbackLedger, factLines, instructionKey, instructionValues, issueList,
  MERGE_SYSTEM, legacyItems, mergeableNotes, normalizeLedger, notesOf, oversizeLines, parseMerge,
  preservedLines, carryLegacyInstructions, rememberFacts, rememberOversize, rememberPreserved,
  sectionBody, withheldLines, WITHDRAWN_PREFIX, type Fact,
} from './ledger'
import { archivedDone, injected, isRecord, type FocusState, focusOf, snapshot, toEvents, type Issue, type Origin, type Payload, type TrackerEvent } from './tracker'
import type { Held, HeldClaims, ReviewInput, Reviewed } from './held'
import type { RewindTopic } from './rewind'
import { fnv1a, type SentAt } from './address'
import type { LogEvent } from './events'
import { xmlText } from './intent'
import { applyFoldClauseOps, livePredicates, parseClause, printClause, renderClauses, type ClauseStore, type FoldClauseOp } from './clauses'
import type { AddressRow } from './address'
import { migrateLegacyLedger } from './resident'

export type Opts = { budget: number; tailTarget: number; queueTarget: number; ledgerTarget: number; reserve: number; model: string; reviewModel: string }
export type Meta = { seq: number; lastClear?: string; lastFoldAt?: number; foldDurationsMs?: Record<string, number>; foldTokens?: number; boundary?: Boundary; lastSkip?: string; fails: number; ratio?: number; overhead?: number; lastObserved?: number; firstObserved?: number; estimatorVersion?: number }
export type TopicState = RewindTopic
export type SplitAnswer = { split: number; mergeReply: string }
export type PreparedFold = { plan: ClearPlan; mergeReply: string }
export type TrackerView = { issues: Issue[]; dropped: Issue[]; finished: Issue[]; doneTitles: Set<string> }
export type Fold = { plan: ClearPlan; notes: string; fullNotes: string; ops: Payload[]; asks: Payload[]; seq: number; fallback: boolean; promoted: Payload[]; hold: Held[]; settled: string[]; topics?: TopicState[]; clauses?: ClauseStore; clauseOps?: FoldClauseOp[]; tailTokens: number }
export type FoldPreview = { notes?: string; topics?: TopicState[]; issues?: Issue[]; state?: FocusState; clauses?: ClauseStore }

export type FoldRuntimeIo = {
  readLedger: () => Promise<string | undefined>
  captureOrigin: () => Promise<Origin>
  readAll: () => Promise<TrackerEvent[]>
  trackerView: (origin: Origin, ops?: readonly Payload[]) => Promise<TrackerView>
  readHeld: () => Promise<Held[]>
  heldClaims: (held: readonly Held[], issues: readonly Issue[], session: string) => HeldClaims
  gateMerge: (ops: readonly Payload[], evidence: readonly Evidence[][], facts: readonly Fact[], sources: ReadonlyMap<string, Source>, ratio: number, dropped: ReadonlySet<string>) => Promise<{ ops: Payload[]; evidence: Evidence[][]; facts: Fact[] }>
  reviewFold: (opts: Opts, input: ReviewInput) => Promise<Reviewed>
  residentLedger: (key: string, issues: readonly Issue[], state: FocusState, events: readonly TrackerEvent[], preview?: FoldPreview) => Promise<string>
  clauseStore: (key: string) => Promise<ClauseStore>
  addressRows: (key: string) => Promise<AddressRow[]>
  nowIso: () => Promise<string>
  readLegacyTopics: (notes: string, seq: number, key: string) => Promise<TopicState[]>
  ledgerPath: () => Promise<string>
  topics: (key: string) => Promise<unknown>
  usageReading: () => Promise<number | undefined>
  sentAt: () => Promise<SentAt>
  complete: (request: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }) => Promise<{ isAnswered: boolean; text: string; reason: string }>
  logEvent: (event: LogEvent, fields: { tokensBefore?: number; tokensAfter?: number; keptTurns?: number; ratio?: number; durationMs?: number; summaryMs?: number; reason?: string }) => Promise<void>
  log: (text: string, options?: { to?: 'transcript' | 'debug' }) => void
}

export const isTopic = (value: unknown): value is TopicState => isRecord(value) && typeof value.topic === 'string' && value.topic.trim() !== ''
  && typeof value.summary === 'string' && value.summary.trim() !== '' && typeof value.seq === 'number' && Number.isInteger(value.seq) && value.seq > 0
  && (value.sourceTokens === undefined || (typeof value.sourceTokens === 'number' && Number.isInteger(value.sourceTokens) && value.sourceTokens >= 0))
  && (value.focusIssue === undefined || value.focusIssue === null || typeof value.focusIssue === 'string')
const topicKey = (topic: Pick<TopicState, 'topic' | 'focusIssue'>) => `${instructionKey(topic.topic)}\0${topic.focusIssue ?? ''}`
const ratioMin = 1, ratioMax = 4
const clampRatio = (value: number) => Math.round(Math.min(ratioMax, Math.max(ratioMin, value)) * 1000) / 1000
const freshReal = (reading: number | undefined, meta: Meta) => (reading !== meta.foldTokens ? reading : undefined)
const droppedShown = 5
export function parseSplitAnswer(raw: string): SplitAnswer | string {
  let value: unknown
  try { value = JSON.parse(normalizeLedger(raw)) } catch (err) { return `split reply is not JSON (${String(err).slice(0, 80)})` }
  if (!isRecord(value) || typeof value.split !== 'number' || !Number.isInteger(value.split)) return `split must be an integer turn number (received ${JSON.stringify(isRecord(value) ? value.split : undefined)})`
  if (!Array.isArray(value.ops)) return 'split reply needs ops'
  return { split: value.split, mergeReply: JSON.stringify({ ops: value.ops }) }
}

function isTopicList(value: unknown): value is TopicState[] {
  return Array.isArray(value) && value.every(isTopic) && new Set(value.map(topic => topicKey(topic))).size === value.length
}

export async function readLegacyTopics(io: Pick<FoldRuntimeIo, 'topics'>, notes: string, seq: number, key: string): Promise<TopicState[]> {
  const stored = await io.topics(key)
  if (isTopicList(stored)) return stored
  const goal = sectionBody(notes, '목표')
  if (!goal || goal === '- (none yet)') return []
  return [{ topic: '기존 세션 주제', summary: goal, seq: Math.max(1, seq) }]
}

const usableOverhead = (reading: number, rows: readonly SessionMessage[], meta: Pick<Meta, 'estimatorVersion' | 'overhead'>) => {
  const overhead = meta.estimatorVersion === TOKEN_ESTIMATOR_VERSION ? meta.overhead : undefined
  return overhead === undefined || overhead >= reading || reading - overhead < visibleTokens(rows) * 0.5 ? undefined : overhead
}

export function messageTokens(rows: readonly SessionMessage[], observed: number | undefined, meta: Pick<Meta, 'estimatorVersion' | 'overhead'>): number {
  const estimated = sum(rows)
  const overhead = observed === undefined ? undefined : usableOverhead(observed, rows, meta)
  return observed === undefined || overhead === undefined ? estimated : Math.max(estimated, observed - overhead)
}

export function foldableTokens(rows: readonly SessionMessage[], reading: number | undefined, meta: Pick<Meta, 'estimatorVersion' | 'overhead' | 'ratio'>): number {
  const ratio = meta.estimatorVersion === TOKEN_ESTIMATOR_VERSION ? meta.ratio ?? 1 : 1
  if (reading === undefined) return visibleTokens(rows) * ratio
  const overhead = usableOverhead(reading, rows, meta)
  return overhead === undefined ? visibleTokens(rows) * ratio : Math.max(0, reading - overhead)
}

export const foldClausePromptSeq = (addressPromptSeq: number | undefined, droppedPromptSeq: number, store: ClauseStore): number =>
  addressPromptSeq ?? (droppedPromptSeq || store.clauses.reduce((highest, clause) => Math.max(highest, clause.promptSeq), 0))

// Every fold gate reads this one scale, so the point the background fold
// starts at is the point a ready plan applies at.
export function atFoldPoint(rows: readonly SessionMessage[], reading: number | undefined, meta: Pick<Meta, 'estimatorVersion' | 'overhead' | 'ratio'>, opts: Pick<Opts, 'budget' | 'reserve'>): boolean {
  return foldableTokens(rows, reading, meta) >= opts.budget - opts.reserve
}

// The first reading holds the fixed prefix plus a near-empty conversation, so
// an overhead above it is an estimator miss and would push the fold point out
// of reach.
export const boundedOverhead = (overhead: number, meta: Pick<Meta, 'firstObserved'>): number =>
  Math.max(0, Math.min(overhead, meta.firstObserved ?? overhead))

const resetStaleEstimator = (meta: Meta) => {
  if (meta.estimatorVersion === TOKEN_ESTIMATOR_VERSION) return
  meta.overhead = undefined
  meta.ratio = undefined
  meta.estimatorVersion = TOKEN_ESTIMATOR_VERSION
}

// The first reading calibrates the prefix, so the rows-scale fold point holds
// from the first turn instead of only after a first fold has measured it.
export function calibrateFirstReading(meta: Meta, rows: readonly SessionMessage[], reading: number): void {
  resetStaleEstimator(meta)
  meta.firstObserved = reading
  meta.overhead = boundedOverhead(meta.overhead ?? reading - sum(rows), meta)
}

export async function trackerView(io: Pick<FoldRuntimeIo, 'readAll'>, here: Origin, ops: readonly Payload[] = []): Promise<TrackerView> {
  const events = await io.readAll()
  const lastSeq = events.reduce((n, event) => event.origin.session === here.session ? Math.max(n, event.seq) : n, 0)
  const all = snapshot([...events, ...toEvents(ops, here, lastSeq, new Date().toISOString())])
  const archived = archivedDone(all, here.session)
  const done = all.filter(issue => issue.status === 'done' && issue.origin.session === here.session)
  return {
    issues: injected(all, here),
    dropped: all.filter(issue => issue.origin.session === here.session && issue.status === 'dropped').sort((a, b) => a.updated.localeCompare(b.updated)).slice(-droppedShown),
    finished: done.filter(issue => archived.has(issue.id)), doneTitles: new Set(done.map(issue => issue.title.trim())),
  }
}

const modelIssues = (view: TrackerView) => [...view.issues, ...view.dropped]

export async function fold(
  io: FoldRuntimeIo, opts: Opts, rows: readonly SessionMessage[], meta: Meta, mustFold: boolean, reading?: number,
  calibrate = true, prepared?: PreparedFold, transcript?: string,
): Promise<Fold | string> {
  resetStaleEstimator(meta)
  const observed = freshReal(reading ?? await io.usageReading(), meta)
  const calib = calibrate ? observed : undefined
  const estimated = sum(rows)
  const overhead = calib === undefined ? undefined : usableOverhead(calib, rows, meta)
  const ratio = calib === undefined || overhead === undefined ? (meta.ratio ?? 1) : clampRatio(calib / Math.max(1, overhead + estimated))
  if (calib !== undefined) {
    if (meta.overhead !== undefined) meta.ratio = ratio
    meta.lastObserved = calib
  }
  const previous = (await io.readLedger()) ?? EMPTY_LEDGER
  const plan = prepared?.plan ?? planClear(rows, Math.max(0, opts.tailTarget / ratio), estTokens({ role: 'user', text: previous, toolUses: [] }) + 60)
  if (!plan) return 'nothing left to fold'
  const here = await io.captureOrigin()
  const clauseKey = transcript ?? `${here.session}:main`
  const legacyTopics = await io.readLegacyTopics(notesOf(previous), meta.seq, clauseKey)
  const baseClauses = migrateLegacyLedger(await io.clauseStore(clauseKey), notesOf(previous), legacyTopics, meta.seq, await io.nowIso())
  const view = await io.trackerView(here)
  let notes = notesOf(previous)
  const kept = [...preservedLines(notes), ...withheldLines(plan.dropped)]
  const storedInstructions = instructionValues(notes)
  const instructions = storedInstructions.filter(item => !item.startsWith(WITHDRAWN_PREFIX))
  const priorFacts = factLines(notes)
  const range = renderRange(plan.dropped, undefined, undefined, await io.sentAt())
  let ops: Payload[] = [], evidence: Evidence[][] = [], facts: Fact[] = [], retracted: string[] = []
  let clauseOps: (import('./ledger').FoldClauseDraft | { retract: string })[] = []
  let fallback = false
  let promoted: Payload[] = [], hold: Held[] = [], claimed: Payload[] = []
  const held = io.heldClaims(await io.readHeld(), view.issues, here.session)
  let settled = held.settled
  let topics: TopicState[] | undefined
  if (plan.dropped.length > 0) {
    const legacy = legacyItems(previous)
    const response = prepared
      ? { isAnswered: true, text: prepared.mergeReply, reason: '' }
      : await io.complete({
        model: opts.model, system: MERGE_SYSTEM,
        prompt: [
          `<notes>\n${mergeableNotes(notes)}\n</notes>`,
          `<instructions>\n${instructions.map(item => JSON.stringify(item)).join('\n') || '(none)'}\n</instructions>`,
          `<facts>\n${priorFacts.join('\n') || '(none)'}\n</facts>`,
          `<predicates>\n${livePredicates(baseClauses, 40).map(xmlText).join('\n') || '(none)'}\n</predicates>`,
          `<live_clauses>\n${renderClauses(baseClauses, () => true, 60).map(xmlText).join('\n') || '(none)'}\n</live_clauses>`,
          `<issues>\n${issueList(modelIssues(view))}\n</issues>`,
          ...(view.finished.length ? [`<finished_earlier>\n${view.finished.map(issue => `- ${issue.title}`).join('\n')}\n</finished_earlier>`] : []),
          ...(legacy.length ? [`<legacy>\n${legacy.join('\n')}\n</legacy>`] : []),
          `<removed_turns>\n${range.text}\n</removed_turns>`,
        ].join('\n\n'), maxTokens: 4096, timeoutMs: 120_000,
      })
    const merged = response.isAnswered ? parseMerge(response.text, new Set(modelIssues(view).map(issue => issue.id)), priorFacts) : `merge model gave no text (${response.reason})`
    const bad = typeof merged === 'string' ? merged : undefined
    if (typeof merged !== 'string') {
      ;({ ops, evidence, facts, retracted, clauseOps } = merged)
      claimed = ops
      meta.fails = 0
      if (merged.rejected) await io.logEvent('ops-rejected', { ratio, reason: `${merged.rejected} op(s) failed validation; ${ops.length} kept` })
      const gated = await io.gateMerge(ops, evidence, facts, range.sources, ratio, new Set(view.dropped.map(issue => issue.id)))
      ;({ ops, evidence, facts } = gated)
    } else {
      meta.fails += 1
      await io.logEvent(!response.isAnswered && response.reason === 'aborted' ? 'merge-timeout' : 'merge-invalid', { ratio, reason: `${bad} (failure ${meta.fails} in a row)` })
      if (!mustFold && meta.fails < 3) return `merged ledger rejected: ${bad}`
      notes = fallbackLedger(notes, plan.dropped)
      ops = []
      evidence = []
      fallback = true
      meta.fails = 0
      io.log(`clm: merge failed (${bad}); folded with a mechanical ledger instead`, { to: 'debug' })
      await io.logEvent('fallback', { ratio, reason: bad })
    }
    const reviewed = await io.reviewFold(opts, {
      ops: fallback ? [] : ops, evidence: fallback ? [] : evidence, facts,
      issues: modelIssues(view), claims: held.claims, heldFacts: held.facts, range, ratio,
    })
    if (!fallback) ops = reviewed.ops
    if (reviewed.failed) { retracted = []; clauseOps = [] }
    facts = reviewed.facts
    const acceptedFacts = new Set(facts.map(fact => fact.text))
    clauseOps = clauseOps.filter(op => 'retract' in op || op.kind === 'goal' || acceptedFacts.has(op.text))
    const draftedFacts = new Set(clauseOps.flatMap(op => 'retract' in op || op.kind !== 'fact' ? [] : [op.text]))
    for (const fact of facts) if (!draftedFacts.has(fact.text)) {
      clauseOps.push({ clause: `legacy_fact('F${fnv1a(fact.text).toString(16)}').`, kind: 'fact', text: fact.text, evidence: fact.evidence })
    }
    promoted = reviewed.promoted
    hold = reviewed.hold
    settled = [...settled, ...reviewed.settled]
  }
  const finishedEarlier = (op: Payload) => op.op === 'create' && op.status === 'done' && view.doneTitles.has(op.title.trim())
  ops = ops.filter(op => !finishedEarlier(op))
  // The confirm ops are recomputed when the fold lands (fold-job), since the user may answer the question while this fold runs.
  const asks = fallback ? [] : claimed.filter(op => !finishedEarlier(op))
  const asking = confirmQuestion(asks, ops, view.issues, view.doneTitles)
  const preserved = carryLegacyInstructions(notes, storedInstructions, plan.dropped, await io.ledgerPath())
  notes = rememberPreserved(rememberOversize(preserved.notes, oversizeLines(plan.tail, plan.cuts)), kept)
  let fullNotes = rememberPreserved(rememberOversize(preserved.fullNotes, oversizeLines(plan.tail, plan.cuts)), kept)
  const seq = meta.seq + 1
  const addressIndex = await io.addressRows(clauseKey)
  const droppedPromptSeq = addressIndex.filter(address => plan.dropped.some(row => isUserTyped(row) && stripReminders(address.text) === stripReminders(row.text)))
    .reduce((highest, address) => Math.max(highest, address.promptSeq ?? 0), 0)
  const currentView = await io.trackerView(here, [...ops, ...asking, ...promoted])
  const currentEvents = await io.readAll()
  const focusState = focusOf(currentEvents, here.session)
  const focusIssue = focusState.stack.at(-1)
  const knownIssues = new Set(currentView.issues.map(issue => issue.id))
  const sourceRow = (ref: string): SessionMessage | undefined => {
    const user = /^m(\d+)$/.exec(ref)
    if (user) return plan.dropped[Number(user[1]) - 1]
    const index = rows.findIndex(row => row.toolResults?.some(result => result.tool_use_id === ref))
    for (let i = index; i >= 0; i--) if (isUserTyped(rows[i]!)) return rows[i]
  }
  const resolvedOps: FoldClauseOp[] = clauseOps.flatMap(op => {
    if ('retract' in op) return [op]
    const proof = op.evidence[0]
    const row = (proof ? sourceRow(proof.ref) : undefined) ?? [...rows].reverse().find(isUserTyped)
    if (!row) return []
    const address = [...addressIndex].reverse().find(item => stripReminders(item.text) === stripReminders(row.text))
    const source = proof ? range.sources.get(proof.ref) : undefined
    let clause = op.clause
    let issue = op.issue
    if (op.kind === 'goal') {
      const parsed = parseClause(clause)
      const first = parsed.head.args[0]
      const named = first && ('atom' in first ? first.atom : 'str' in first ? first.str : undefined)
      issue = issue ?? (named && knownIssues.has(named) ? named : focusIssue)
      if (issue) {
        parsed.head.args[0] = { str: issue }
        clause = printClause(parsed)
      }
    }
    return [{ clause, kind: op.kind, text: op.text, issue, key: op.key,
      promptSeq: foldClausePromptSeq(address?.promptSeq, droppedPromptSeq, baseClauses), address: address?.address ?? '@unknown',
      ...(proof ? { evidence: { ref: proof.ref, quote: proof.quote, ...(source?.tool ? { tool: source.tool } : {}) } } : {}),
    }]
  })
  const clauses = resolvedOps.length ? applyFoldClauseOps(baseClauses, resolvedOps, await io.nowIso()) : baseClauses
  const preview = await io.residentLedger(clauseKey, currentView.issues, focusState, currentEvents, { notes: fullNotes, topics, issues: currentView.issues, state: focusState, clauses })
  const text = ledgerRowText(seq, kst(), await io.ledgerPath(), preview, opts.ledgerTarget)
  const tokensBefore = messageTokens(rows, observed, meta)
  const tokensAfter = sum(buildCleared(plan, { role: 'user', text, toolUses: [] }))
  const tailTokens = sum([{ role: 'user', text, toolUses: [] }, ...plan.tail.filter(message => !isLedgerRow(message) && !isSystemRow(message))])
  if (tokensAfter >= tokensBefore) {
    const why = `the fold would not shrink the context (${tokensBefore} -> ${tokensAfter} est. tokens)`
    io.log(`clm: ${why}`)
    await io.logEvent('skip-not-shrinking', { tokensBefore, tokensAfter, keptTurns: plan.keptTurns, ratio, reason: why })
    return why
  }
  if (Object.keys(plan.cuts).length) await io.logEvent('truncation', { keptTurns: plan.keptTurns, ratio, reason: `cut ${Object.keys(plan.cuts).length} tool result(s) to ~${Object.values(plan.cuts)[0]}t each` })
  if (calib !== undefined) meta.overhead = boundedOverhead(calib - estimated, meta)
  return { plan, notes, fullNotes, ops, asks, seq, fallback, promoted, hold, settled, topics, clauses, clauseOps: resolvedOps, tailTokens }
}
