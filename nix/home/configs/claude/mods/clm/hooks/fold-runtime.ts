import type { SessionMessage } from 'claude-code'
import {
  buildCleared, estTokens, isLedgerRow, isSystemRow, isUserTyped, kst, ledgerRowText, planClear, stripReminders, sum, visibleTokens, TOKEN_ESTIMATOR_VERSION, type Boundary, type ClearPlan,
} from './fold'
import { confirmQuestion, renderRange, type Evidence, type Source } from './evidence'
import {
  EMPTY_LEDGER, ageDecayPlan, fallbackLedger, factLines, instructionKey, instructionValues, issueList,
  LEDGER_COMPACT_SYSTEM, MERGE_SYSTEM, legacyItems, mergeableNotes, normalizeLedger, notesOf, oversizeLines, parseMerge,
  preservedLines, preserveInstructions, rememberFacts, rememberOversize, rememberPreserved,
  withheldLines, WITHDRAWN_PREFIX, withNotes, type Fact,
} from './ledger'
import { archivedDone, injected, isRecord, type FocusState, focusOf, snapshot, toEvents, type Issue, type Origin, type Payload, type TrackerEvent } from './tracker'
import type { Held, HeldClaims, ReviewInput, Reviewed } from './held'
import type { RewindTopic } from './rewind'
import type { SentAt } from './address'
import type { LogEvent } from './events'
import { xmlText } from './intent'

export type Opts = { budget: number; tailTarget: number; queueTarget: number; ledgerTarget: number; reserve: number; model: string; reviewModel: string }
export type Meta = { seq: number; lastClear?: string; lastFoldAt?: number; foldDurationsMs?: Record<string, number>; foldTokens?: number; boundary?: Boundary; lastSkip?: string; fails: number; ratio?: number; overhead?: number; lastObserved?: number; estimatorVersion?: number }
export type TopicState = RewindTopic
export type TopicDraft = { topic: string; summary: string }
export type SplitAnswer = { split: number; mergeReply: string; topics: TopicDraft[] }
export type PreparedFold = { plan: ClearPlan; mergeReply: string; topics: TopicDraft[] }
export type TrackerView = { issues: Issue[]; dropped: Issue[]; finished: Issue[]; doneTitles: Set<string> }
export type Fold = { plan: ClearPlan; notes: string; fullNotes: string; ops: Payload[]; asks: Payload[]; seq: number; fallback: boolean; promoted: Payload[]; hold: Held[]; settled: string[]; topics?: TopicState[]; tailTokens: number }
export type FoldPreview = { notes?: string; topics?: TopicState[]; issues?: Issue[]; state?: FocusState }

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
  storedTopics: (notes: string, seq: number, key: string) => Promise<TopicState[]>
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
const isTopicDraft = (value: unknown): value is TopicDraft => isRecord(value) && typeof value.topic === 'string' && value.topic.trim() !== '' && typeof value.summary === 'string' && value.summary.trim() !== ''
const topicKey = (topic: Pick<TopicState, 'topic' | 'focusIssue'>) => `${instructionKey(topic.topic)}\0${topic.focusIssue ?? ''}`
const topicTokens = (topic: Pick<TopicState, 'topic' | 'summary'>) => Math.ceil((topic.topic.length + topic.summary.length) / 4)
const topicFloorTokens = (topic: Pick<TopicState, 'topic'>) => Math.ceil((topic.topic.length + 10) / 4)
const ratioMin = 1, ratioMax = 4
const clampRatio = (value: number) => Math.round(Math.min(ratioMax, Math.max(ratioMin, value)) * 1000) / 1000
const freshReal = (reading: number | undefined, meta: Meta) => (reading !== meta.foldTokens ? reading : undefined)
const droppedShown = 5
export function parseSplitAnswer(raw: string): SplitAnswer | string {
  let value: unknown
  try { value = JSON.parse(normalizeLedger(raw)) } catch (err) { return `split reply is not JSON (${String(err).slice(0, 80)})` }
  if (!isRecord(value) || typeof value.split !== 'number' || !Number.isInteger(value.split)) return `split must be an integer turn number (received ${JSON.stringify(isRecord(value) ? value.split : undefined)})`
  if (typeof value.notes !== 'string' || !Array.isArray(value.ops)) return 'split reply needs notes and ops'
  const drafts = value.topics
  if (!Array.isArray(drafts) || !drafts.every(isTopicDraft)) return 'split reply needs topic summaries'
  return { split: value.split, mergeReply: `${normalizeLedger(value.notes)}\n<ops>${JSON.stringify(value.ops)}</ops>`, topics: drafts.map(topic => ({ topic: topic.topic.trim(), summary: topic.summary.trim() })) }
}

function isTopicList(value: unknown): value is TopicState[] {
  return Array.isArray(value) && value.every(isTopic) && new Set(value.map(topic => topicKey(topic))).size === value.length
}

export function notesWithTopics(notes: string, topics: readonly TopicState[]): string {
  const goal = topics.length ? topics.map(topic => `- ${topic.topic}: ${topic.summary}`).join('\n') : '- (none yet)'
  return withNotes(notes, `## 목표\n${goal}`)
}

function parseTopics(raw: string): TopicState[] | string {
  let value: unknown
  try { value = JSON.parse(normalizeLedger(raw)) } catch (err) { return `topic merge is not JSON (${String(err).slice(0, 80)})` }
  if (!isRecord(value) || !isTopicList(value.topics)) return 'topic merge needs distinct {topic, summary, seq} records'
  return value.topics
}

export async function storedTopics(io: Pick<FoldRuntimeIo, 'topics'>, notes: string, seq: number, key: string): Promise<TopicState[]> {
  const stored = await io.topics(key)
  if (isTopicList(stored)) return stored
  const goal = /^## 목표\s*\n([\s\S]*?)(?=\n## |$)/m.exec(notes)?.[1]?.trim() ?? ''
  if (!goal || goal === '- (none yet)') return []
  return [{ topic: '기존 세션 주제', summary: goal, seq: Math.max(1, seq) }]
}

export async function compressTopics(
  io: FoldRuntimeIo, opts: Opts, input: readonly TopicState[], seq: number, notes: string, issues: readonly Issue[], key: string,
): Promise<{ topics: TopicState[]; ledgerTokens: number }> {
  const normalized: (TopicState & { sourceTokens: number })[] = input.map(topic => ({ ...topic, sourceTokens: topic.sourceTokens ?? topicTokens(topic) }))
  const old = new Map(normalized.map(topic => [topicKey(topic), topic]))
  const fixedNotes = notes.replace(/^## 목표\n[\s\S]*?(?=\n## |$)/m, '## 목표\n')
  const origin = await io.captureOrigin()
  const events = await io.readAll()
  const state = focusOf(events, origin.session)
  const pointer = await io.ledgerPath()
  const renderRow = async (topicList: readonly TopicState[], ledgerNotes: string): Promise<SessionMessage> => {
    const text = await io.residentLedger(key, issues, state, events, { notes: ledgerNotes, topics: [...topicList], issues, state })
    return { role: 'user', text: ledgerRowText(seq, kst(), pointer, text, opts.ledgerTarget), toolUses: [] }
  }
  const fixedRow = await renderRow([], fixedNotes)
  const fixedTokens = sum([fixedRow])
  const topicBudget = Math.max(0, opts.ledgerTarget - fixedTokens)
  const allocation = ageDecayPlan(normalized.map(topic => ({ sourceTokens: topic.sourceTokens, currentTokens: topicTokens(topic), floorTokens: topicFloorTokens(topic), seq: topic.seq })), topicBudget)
  const targets = allocation.targets
  const rewrite: typeof normalized = []
  for (const index of allocation.rewrite) {
    const topic = normalized[index]
    if (topic) rewrite.push(topic)
  }
  let retryReason = ''
  let latest = [...normalized]
  let latestTokens = 0
  if (!rewrite.length) {
    const row = await renderRow(latest, notesWithTopics(notes, latest))
    latestTokens = sum([row])
    if (latestTokens > opts.ledgerTarget) {
      const over = latestTokens - opts.ledgerTarget
      io.log(`clm: ledger over budget by ${over}`, { to: 'debug' })
      await io.logEvent('ledger-over-budget', { reason: `ledger over budget by ${over}` })
    }
    return { topics: latest, ledgerTokens: latestTokens }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await io.complete({
        model: opts.model,
        system: LEDGER_COMPACT_SYSTEM,
        prompt: [
          `<budget>\n${opts.ledgerTarget} tokens for the complete ledger; fixed sections use about ${fixedTokens} tokens and topic summaries have ${topicBudget} tokens.</budget>`,
          `<fixed_sections>\n${xmlText(fixedRow.text)}\n</fixed_sections>`,
          `<topic_entries>\n${rewrite.map(topic => JSON.stringify({ ...topic, tokens: topicTokens(topic), targetTokens: targets[normalized.indexOf(topic)] })).join('\n') || '(none)'}\n</topic_entries>`,
          `<new_summary>\n${rewrite.filter(topic => topic.seq === seq).map(topic => JSON.stringify({ ...topic, tokens: topicTokens(topic), targetTokens: targets[normalized.indexOf(topic)] })).join('\n') || '(none)'}\n</new_summary>`,
          retryReason ? `<retry_rule>\n${retryReason}\n</retry_rule>` : '',
        ].filter(Boolean).join('\n\n'),
        maxTokens: Math.max(1024, Math.min(8192, opts.ledgerTarget * 2)), timeoutMs: 60_000,
      })
      const parsed = response.isAnswered ? parseTopics(response.text) : `topic merge gave no text (${response.reason})`
      if (typeof parsed === 'string') {
        retryReason = `The previous reply failed: ${parsed}. Return the required JSON object with a topics array.`
        if (attempt === 1) io.log(`clm: topic merge failed (${parsed}); keeping the summaries as written`, { to: 'debug' })
        continue
      }
      const byName = new Map(parsed.map(topic => [topicKey(topic), topic]))
      latest = normalized.map(topic => {
        const response = rewrite.some(candidate => topicKey(candidate) === topicKey(topic))
          ? byName.get(topicKey(topic)) ?? (parsed.filter(candidate => instructionKey(candidate.topic) === instructionKey(topic.topic)).length === 1
            ? parsed.find(candidate => instructionKey(candidate.topic) === instructionKey(topic.topic)) : undefined)
          : undefined
        const previous = old.get(topicKey(topic))
        if (!response) return topic
        return { ...topic, summary: response.summary, seq: previous?.summary === response.summary ? previous.seq : seq }
      })
      const row = await renderRow(latest, notesWithTopics(notes, latest))
      latestTokens = sum([row])
      if (latestTokens <= opts.ledgerTarget) return { topics: latest, ledgerTokens: latestTokens }
      retryReason = `The previous ledger used ${latestTokens} tokens, exceeding ${opts.ledgerTarget} by ${latestTokens - opts.ledgerTarget}. Re-summarize older topics more tightly and return the full topics array.`
    } catch (err) {
      retryReason = `The previous topic merge failed: ${String(err).slice(0, 120)}. Return the required JSON object.`
      if (attempt === 1) io.log(`clm: topic merge failed (${String(err).slice(0, 120)}); keeping the summaries as written`, { to: 'debug' })
    }
  }
  const fallbackRow = await renderRow(latest, notesWithTopics(notes, latest))
  latestTokens = sum([fallbackRow])
  if (latestTokens > opts.ledgerTarget) {
    const over = latestTokens - opts.ledgerTarget
    io.log(`clm: ledger over budget by ${over}`, { to: 'debug' })
    await io.logEvent('ledger-over-budget', { reason: `ledger over budget by ${over}` })
  }
  return { topics: latest, ledgerTokens: latestTokens }
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
  if (meta.estimatorVersion !== TOKEN_ESTIMATOR_VERSION) {
    meta.overhead = undefined
    meta.ratio = undefined
    meta.estimatorVersion = TOKEN_ESTIMATOR_VERSION
  }
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
  const view = await io.trackerView(here)
  let notes = notesOf(previous)
  const kept = [...preservedLines(notes), ...withheldLines(plan.dropped)]
  const storedInstructions = instructionValues(notes)
  const instructions = storedInstructions.filter(item => !item.startsWith(WITHDRAWN_PREFIX))
  const priorFacts = factLines(notes)
  const range = renderRange(plan.dropped, undefined, undefined, await io.sentAt())
  let ops: Payload[] = [], evidence: Evidence[][] = [], facts: Fact[] = [], retracted: string[] = [], withdrawn: string[] = []
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
          `<issues>\n${issueList(modelIssues(view))}\n</issues>`,
          ...(view.finished.length ? [`<finished_earlier>\n${view.finished.map(issue => `- ${issue.title}`).join('\n')}\n</finished_earlier>`] : []),
          ...(legacy.length ? [`<legacy>\n${legacy.join('\n')}\n</legacy>`] : []),
          `<removed_turns>\n${range.text}\n</removed_turns>`,
        ].join('\n\n'), maxTokens: 4096, timeoutMs: 120_000,
      })
    const withdrawable = [...instructions, ...plan.dropped.filter(isUserTyped).map(message => stripReminders(message.text))]
    const merged = response.isAnswered ? parseMerge(response.text, new Set(modelIssues(view).map(issue => issue.id)), Math.max(500, Math.floor(opts.budget / 4)), withdrawable, priorFacts) : `merge model gave no text (${response.reason})`
    const bad = typeof merged === 'string' ? merged : undefined
    if (typeof merged !== 'string') {
      notes = withNotes(notes, merged.notes)
      ;({ ops, evidence, facts, retracted, withdrawn } = merged)
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
    if (reviewed.failed) retracted = []
    facts = reviewed.facts
    promoted = reviewed.promoted
    hold = reviewed.hold
    settled = [...settled, ...reviewed.settled]
  }
  const finishedEarlier = (op: Payload) => op.op === 'create' && op.status === 'done' && view.doneTitles.has(op.title.trim())
  ops = ops.filter(op => !finishedEarlier(op))
  // The confirm ops are recomputed when the fold lands (fold-job), since the user may answer the question while this fold runs.
  const asks = fallback ? [] : claimed.filter(op => !finishedEarlier(op))
  const asking = confirmQuestion(asks, ops, view.issues, view.doneTitles)
  notes = rememberFacts(notes, facts, retracted)
  const preserved = preserveInstructions(notes, storedInstructions, plan.dropped, await io.ledgerPath(), withdrawn)
  notes = rememberPreserved(rememberOversize(preserved.notes, oversizeLines(plan.tail, plan.cuts)), kept)
  let fullNotes = rememberPreserved(rememberOversize(preserved.fullNotes, oversizeLines(plan.tail, plan.cuts)), kept)
  const seq = meta.seq + 1
  const currentView = await io.trackerView(here, [...ops, ...asking, ...promoted])
  const currentEvents = await io.readAll()
  const focusState = focusOf(currentEvents, here.session)
  const focusIssue = focusState.stack.at(-1) ?? null
  const previousTopics = (await io.storedTopics(notesOf(previous), meta.seq, transcript ?? `${here.session}:main`))
    .map(topic => topic.focusIssue === undefined ? { ...topic, focusIssue } : topic)
  if (prepared) {
    const freshTopics = prepared.topics.map(topic => ({ ...topic, sourceTokens: topicTokens(topic), seq, focusIssue }))
    const compressed = await compressTopics(io, opts, [...previousTopics, ...freshTopics], seq, notes, currentView.issues, transcript ?? `${here.session}:main`)
    notes = notesWithTopics(notes, compressed.topics)
    fullNotes = notesWithTopics(fullNotes, compressed.topics)
    topics = compressed.topics
  } else {
    const goal = /^## 목표\s*\n([\s\S]*?)(?=\n## |$)/m.exec(notes)?.[1]?.trim() ?? ''
    if (goal && goal !== '- (none yet)') {
      const focus = currentView.issues.find(issue => issue.id === focusIssue)
      const latest: TopicState = { topic: focus?.title ?? '현재 작업', summary: goal, seq, sourceTokens: estTokens({ role: 'user', text: goal, toolUses: [] }), focusIssue }
      topics = [...previousTopics.filter(topic => topic.focusIssue !== focusIssue), latest]
      notes = notesWithTopics(notes, topics)
      fullNotes = notesWithTopics(fullNotes, topics)
    } else topics = previousTopics
  }
  const preview = await io.residentLedger(transcript ?? `${here.session}:main`, currentView.issues, focusState, currentEvents, { notes: fullNotes, topics, issues: currentView.issues, state: focusState })
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
  if (calib !== undefined) meta.overhead = Math.max(0, calib - estimated)
  return { plan, notes, fullNotes, ops, asks, seq, fallback, promoted, hold, settled, topics, tailTokens }
}
