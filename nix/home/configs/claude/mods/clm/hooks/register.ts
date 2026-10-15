import { update, type BuiltinToolInputs, type EngineInterface, type Register, type SessionCompactResult, type SessionMessage } from 'claude-code'

import { boardHtml } from './board'
import {
  buildCleared, fingerprint, isHarnessText, isLedgerRow, isPrompt, isSystemRow, isUserTyped, kst, stripReminders, ledgerRowSeq, ledgerRowText, liveRows, planClear, protectedIndex, sum, visibleTokens,
  type Boundary, type ClearPlan,
} from './fold'
import {
  checkEvidence, clippedSource, describeOp, downgrade, gateOps, isDoneClaim, isDropClaim, isReopenClaim, renderRange,
  type Evidence, type Source,
} from './evidence'
import {
  composeLedger, EMPTY_LEDGER, factLine, factLines, constraintFactLines, learnedFactLines, fallbackLedger, instructionKey, instructionValues, withdrawnInstructionKeys, issueList, legacyItems, LEDGER_COMPACT_SYSTEM, MERGE_SYSTEM, mergeableNotes, normalizeLedger, notesOf, oversizeLines,
  parseChanges, parseMerge, parseReview, preservedLines, preserveInstructions, rememberFacts, rememberOversize, rememberPreserved, renderTurns, REVIEW_SYSTEM, withheldLines, withheldPointer,
  withNotes, WITHDRAWN_PREFIX, SPLIT_MERGE_SYSTEM, SECTIONS, ageDecayPlan, isDirective, type Fact,
} from './ledger'
import {
  archivedDone, describe, injected, isOpen, normalizeRemote, parseLog, parseOps, snapshot, toEvents,
  focusOf, issueId, type Issue, type Origin, type Payload, type TrackerEvent,
} from './tracker'
import { compose, INTENT_SYSTEM, intentPrompt, isRequestRecord, laterSupported, parseFocus, parseLater, parseRequests, supportedLaterDrop, supportedRequestQuote, xmlText, type RequestClassification, type RequestRecord } from './intent'
import { chooseContinuation, isHumanOrigin, removeQueueSnapshotTargets, resetUserWorkflow, restoreFailedContinuation, workflowValue, type Continuation } from './workflow'
import type { ClmStatus, ClmTaskInput, ClmWorkflow } from '../types'
import { parseTranscriptRows, recallTranscriptAddress, type AddressRow } from './address'
import { residentLedgerText, type InstructionIndex, type ResidentLedgerSections } from './resident'

export { recallTranscriptAddress } from './address'
export { residentLedgerText } from './resident'
export { chooseContinuation, removeQueueSnapshotTargets, resetUserWorkflow, restoreFailedContinuation } from './workflow'

// Each transcript has one compaction job. Turn-end work starts it in the
// background; engine compactions join that job and apply its ready plan.
//
// 한 일, 할 일 and 미결 질문 are not merged text: they are rendered from the
// tracker (tracker.ts), and the merge model only emits ops against it, so an
// item it forgets to repeat stays where it was.
//
// The oldest tool results are withheld only inside a compaction job when its
// summary fails, so a failed model call never delegates a competing summary.

const FAILS_BEFORE_FALLBACK = 3
const WORKFLOW = { plugin: 'clm', key: 'workflow' } as const
const RECALL_TOOL = 'mcp__clm__clm_recall'
export const TASK_TOOL = 'mcp__clm__clm_task'

type WorkflowReader = { state: { get: (ref: typeof WORKFLOW) => Promise<{ value: unknown }> } }
type SessionReader = { session: { id: () => Promise<string> } }
type StoreReader = SessionReader & { store: { get: (key: string) => Promise<unknown> } }
type HomeReader = SessionReader & { env: { get: (name: string) => Promise<string | undefined> } }
type TrackerReader = {
  env: { get: (name: string) => Promise<string | undefined> }
  fs: {
    exists: (path: string) => Promise<boolean>
    list: (path: string) => Promise<{ name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }[]>
    read: (path: string) => Promise<string>
  }
  ui: { log: (text: string, options?: { to?: 'transcript' | 'debug' }) => void }
}
type StatusReader = WorkflowReader & StoreReader & TrackerReader

async function readWorkflow($: WorkflowReader): Promise<ClmWorkflow> {
  const value: unknown = (await $.state.get(WORKFLOW)).value
  return workflowValue(value)
}

/** Writes one workflow version at a time so concurrent queue and arbiter updates cannot overwrite each other. */
async function changeWorkflow<T>($: EngineInterface, change: (current: ClmWorkflow) => { next: ClmWorkflow; result: T }): Promise<T> {
  let result: { value: T } | undefined
  await update($, WORKFLOW, value => {
    const current = workflowValue(value)
    const changed = change(current)
    result = { value: changed.result }
    return changed.next
  })
  if (!result) throw new Error('clm workflow update did not run')
  return result.value
}

// --- options -------------------------------------------------------------

export type Opts = { budget: number; tailTarget: number; queueTarget: number; ledgerTarget: number; reserve: number; model: string; reviewModel: string }
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
  let queueTarget = 8000
  if (o.queueTarget !== undefined) {
    if (isInt(o.queueTarget) && o.queueTarget > 0) queueTarget = o.queueTarget
    else problems.push(`queueTarget=${JSON.stringify(o.queueTarget)} must be a positive integer; using 8000`)
  }
  const defLedgerTarget = Math.floor(tailTarget / 4)
  let ledgerTarget = defLedgerTarget
  if (o.ledgerTarget !== undefined) {
    if (isInt(o.ledgerTarget) && o.ledgerTarget >= 0 && o.ledgerTarget < tailTarget) ledgerTarget = o.ledgerTarget
    else problems.push(`ledgerTarget=${JSON.stringify(o.ledgerTarget)} must be a non-negative integer under tailTarget (${tailTarget}); using ${defLedgerTarget}`)
  }
  const defReserve = Math.min(2048, Math.floor(budget / 4))
  let reserve = defReserve
  if (o.reserve !== undefined && o.reserve !== 0) {
    if (isInt(o.reserve) && o.reserve > 0 && o.reserve < budget) reserve = o.reserve
    else problems.push(`reserve=${JSON.stringify(o.reserve)} must be a positive integer under the budget (${budget}); using ${defReserve}`)
  }
  const name = (key: 'model' | 'reviewModel', fallback: string) => {
    const v = o[key]
    if (v === undefined || v === '') return fallback
    if (typeof v === 'string' && v.trim()) return v.trim()
    problems.push(`${key}=${JSON.stringify(v)} must be a model name; using ${fallback}`)
    return fallback
  }
  const model = name('model', 'haiku')
  return { opts: { budget, tailTarget, queueTarget, ledgerTarget, reserve, model, reviewModel: name('reviewModel', model) }, problems }
}

// --- session state -------------------------------------------------------

// A fold's `ops` wait here and reach the tracker only in session.compact, when
// the fold is applied, so a planned fold that never lands (a headless session,
// a re-fold) cannot leave issues behind for the next one to duplicate. The
// tracker writes at call time mirror the model's TaskCreate and TaskUpdate calls.
type Pending = {
  notes: string; fullNotes: string; ops: Payload[]; seq: number; keepFp?: string; keepFrom: number; dropFps: string[]
  cuts: Record<string, number>; keptTurns: number; fallback: boolean; summaryMs?: number; topics?: Topic[]
  rewindOnly?: boolean
  promoted?: Payload[]; hold?: Held[]; settled?: string[]
  coveredRows?: string[]
}
type FoldJob =
  | { state: 'idle' }
  | { state: 'summarizing'; promise: Promise<Pending | undefined>; fingerprints: string[]; turnEnd: boolean }
  | { state: 'ready'; plan: Pending; fingerprints: string[]; turnEnd: boolean }
  | { state: 'swapping'; promise: Promise<SessionCompactResult> }
type Topic = { topic: string; summary: string; seq: number; sourceTokens?: number; focusIssue?: string | null }
type LedgerSnapshot = { seq: number; ledgerFp: string; coveredRows: string[]; ledger: string; topics?: Topic[]; instructions?: unknown; addresses?: unknown }
// `foldTokens` is the usage reading taken when the last fold landed: the
// engine keeps reporting it until the next API response, so an equal reading
// describes the transcript before that fold and is ignored.
export type Meta = { seq: number; lastClear?: string; lastFoldAt?: number; foldDurationsMs?: Record<string, number>; foldTokens?: number; boundary?: Boundary; lastSkip?: string; fails: number; ratio?: number; overhead?: number; lastObserved?: number }
const sid = ($: SessionReader) => $.session.id()
const metaKey = async ($: SessionReader) => `ledger:${await sid($)}`
const pendingKey = async ($: SessionReader, key?: string) => {
  const session = await sid($)
  return `pending:${key && key !== `${session}:main` ? key : session}`
}
const topicsKey = async ($: EngineInterface, key?: string) => {
  const session = await sid($)
  return `topics:${key && key !== `${session}:main` ? key : session}`
}
const ledgerSnapshotsKey = (key: string) => `ledger-snapshots:${key}`
const transcriptRowsKey = (key: string) => `transcript-rows:${key}`
const transcriptPathKey = (session: string) => `transcript-path:${session}`
const instructionIndexKey = (key: string) => `instruction-index:${key}`
const issueAddressKey = (key: string) => `issue-addresses:${key}`
const requestsKey = (key: string) => `requests:${key}`
const requestPromptSeqKey = (key: string) => `request-prompt-seq:${key}`
const transcriptPaths = new Map<string, string>()
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

type LedgerPreview = { notes?: string; topics?: Topic[]; issues?: Issue[]; state?: { stack: string[]; pending: string[] } }
const isTopic = (v: unknown): v is Topic => isRecord(v) && typeof v.topic === 'string' && v.topic.trim() !== ''
  && typeof v.summary === 'string' && v.summary.trim() !== '' && typeof v.seq === 'number' && Number.isInteger(v.seq) && v.seq > 0
  && (v.sourceTokens === undefined || (typeof v.sourceTokens === 'number' && Number.isInteger(v.sourceTokens) && v.sourceTokens >= 0))
  && (v.focusIssue === undefined || v.focusIssue === null || typeof v.focusIssue === 'string')
const isNumberRecord = (v: unknown): v is Record<string, number> => isRecord(v) && Object.values(v).every(n => typeof n === 'number')
const optional = (v: unknown, type: 'number' | 'string') => v === undefined || typeof v === type
const isMeta = (v: unknown): v is Partial<Meta> =>
  isRecord(v) && optional(v.seq, 'number') && optional(v.fails, 'number') && optional(v.ratio, 'number') && optional(v.overhead, 'number')
  && optional(v.foldTokens, 'number') && optional(v.lastFoldAt, 'number') && (v.foldDurationsMs === undefined || isNumberRecord(v.foldDurationsMs)) && optional(v.lastClear, 'string') && (v.boundary === undefined || isRecord(v.boundary))
const isPending = (v: unknown): v is Pending =>
  isRecord(v) && typeof v.notes === 'string' && typeof v.fullNotes === 'string' && Array.isArray(v.ops) && typeof v.seq === 'number'
  && optional(v.keepFp, 'string') && typeof v.keepFrom === 'number' && Array.isArray(v.dropFps) && v.dropFps.every(f => typeof f === 'string')
  && isRecord(v.cuts) && typeof v.keptTurns === 'number' && typeof v.fallback === 'boolean' && optional(v.summaryMs, 'number')
  && (v.topics === undefined || (Array.isArray(v.topics) && v.topics.every(isTopic)))
  && (v.rewindOnly === undefined || typeof v.rewindOnly === 'boolean')
  && (v.promoted === undefined || Array.isArray(v.promoted)) && (v.hold === undefined || (Array.isArray(v.hold) && v.hold.every(isHeld)))
  && (v.settled === undefined || (Array.isArray(v.settled) && v.settled.every(k => typeof k === 'string')))
  && (v.coveredRows === undefined || (Array.isArray(v.coveredRows) && v.coveredRows.every(ref => typeof ref === 'string')))
async function readMeta($: StoreReader): Promise<Meta> {
  const stored = await $.store.get(await metaKey($))
  return { seq: 0, fails: 0, ...(isMeta(stored) ? stored : {}) }
}
const writeMeta = async ($: EngineInterface, m: Meta) => $.store.set(await metaKey($), m)

async function basePath($: HomeReader): Promise<string> {
  const home = await $.env.get('HOME')
  return `${home ?? '.'}/.claude-work/plans/clm-${await sid($)}`
}
const ledgerPath = async ($: HomeReader) => `${await basePath($)}.md`
const logPath = async ($: EngineInterface) => `${await basePath($)}.log.jsonl`
async function readText($: EngineInterface, p: string): Promise<string | undefined> {
  return (await $.fs.exists(p)) ? await $.fs.read(p) : undefined
}

async function transcriptRows($: EngineInterface): Promise<AddressRow[]> {
  const session = await sid($)
  const storedPath = await $.store.get(transcriptPathKey(session))
  const path = transcriptPaths.get(session) ?? (typeof storedPath === 'string' ? storedPath : undefined)
  if (!path) return []
  transcriptPaths.set(session, path)
  const text = await readText($, path)
  return text === undefined ? [] : parseTranscriptRows(text)
}

async function rememberTranscriptPath($: EngineInterface, session: string, path: string): Promise<void> {
  transcriptPaths.set(session, path)
  await $.store.set(transcriptPathKey(session), path)
}

function promptAddress(rows: readonly AddressRow[], prompt: string): string | undefined {
  const normalized = instructionKey(stripReminders(prompt))
  const row = [...rows].reverse().find(candidate => candidate.role === 'user' && instructionKey(stripReminders(candidate.text)) === normalized)
  return row ? `@${row.uuid.slice(0, 8)}` : undefined
}

async function readRequests($: EngineInterface, key: string): Promise<RequestRecord[]> {
  const value = await $.store.get(requestsKey(key))
  return Array.isArray(value) ? value.filter(isRequestRecord) : []
}

async function applyRequestClassification(
  $: EngineInterface, key: string, promptSeq: number, classification: RequestClassification,
  userPrompt: string, lastAssistantReply: string,
): Promise<void> {
  const previousSeq = await $.store.get(requestPromptSeqKey(key))
  if (typeof previousSeq === 'number' && previousSeq >= promptSeq) return
  const records = await readRequests($, key)
  const open = new Set(records.filter(request => request.status === 'open').map(request => request.id))
  const next = [...records]
  for (const request of classification.raised) {
    if (!supportedRequestQuote(request.quote, userPrompt, 'user')) {
      $.ui.log(`clm request: dropped unsupported raised quote for ${request.text}`, { to: 'debug' })
      continue
    }
    if (next.some(existing => existing.status === 'open' && instructionKey(existing.text) === instructionKey(request.text))) continue
    const id = `R${next.reduce((max, item) => Math.max(max, Number(/^R(\d+)$/.exec(item.id)?.[1] ?? 0)), 0) + 1}`
    next.push({ id, text: request.text, quote: request.quote, status: 'open' })
    open.add(id)
    $.ui.log(`clm: request raised ${id}`)
  }
  const resolved = new Set<string>()
  for (const resolution of classification.resolved) {
    if (!open.has(resolution.id) || resolved.has(resolution.id)) continue
    if (resolution.how !== 'skipped' && resolution.quote === undefined) continue
    if (resolution.quote !== undefined
      && !supportedRequestQuote(resolution.quote, userPrompt, 'user')
      && !supportedRequestQuote(resolution.quote, lastAssistantReply, 'assistant')) {
      $.ui.log(`clm request: ignored unsupported resolution quote for ${resolution.id}`, { to: 'debug' })
      continue
    }
    const index = next.findIndex(request => request.id === resolution.id && request.status === 'open')
    if (index < 0) continue
    const request = next[index]
    if (!request) continue
    next[index] = {
      ...request, status: resolution.how,
      resolution: { how: resolution.how, ...(resolution.quote === undefined ? {} : { quote: resolution.quote }) },
    }
    resolved.add(resolution.id)
  }
  if (next.length !== records.length || next.some((item, index) => item.status !== records[index]?.status))
    await $.store.set(requestsKey(key), next)
  await $.store.set(requestPromptSeqKey(key), promptSeq)
}

function isInstructionIndex(value: unknown): value is InstructionIndex {
  return isRecord(value) && typeof value.address === 'string' && (/^@[\da-f]{8}$/i.test(value.address) || value.address === '@unknown')
    && (typeof value.issue === 'string' || value.issue === null) && typeof value.text === 'string'
}

async function ensureInstructionIndex($: EngineInterface, key: string, notes: string): Promise<void> {
  const raw = await $.store.get(instructionIndexKey(key))
  const index = Array.isArray(raw) ? raw.filter(isInstructionIndex) : []
  const indexed = new Set(index.map(item => instructionKey(item.text)))
  const rows = await transcriptRows($)
  let changed = false
  for (const text of instructionValues(notes)) {
    if (text.startsWith(WITHDRAWN_PREFIX)) continue
    const normalized = instructionKey(text)
    if (!normalized || indexed.has(normalized)) continue
    const source = [...rows].reverse().find(row => row.role === 'user' && instructionKey(stripReminders(row.text)) === normalized)
    index.push({ address: source ? `@${source.uuid.slice(0, 8)}` : '@unknown', issue: null, text })
    indexed.add(normalized)
    changed = true
  }
  if (changed) await $.store.set(instructionIndexKey(key), index)
}

async function residentLedger(
  $: EngineInterface, key: string, issues: readonly Issue[], state: { stack: string[]; pending: string[] }, events: readonly TrackerEvent[], preview: LedgerPreview = {},
): Promise<string> {
  const rawIndex = await $.store.get(instructionIndexKey(key))
  const index = Array.isArray(rawIndex) ? rawIndex.filter(isInstructionIndex) : []
  const rows = await transcriptRows($)
  const seen = new Set(index.map(item => `${item.address}\0${item.issue}`))
  for (const event of events) {
    const rule = event.op === 'focus' ? event.rule?.trim() : undefined
    if (event.op !== 'focus' || event.issue !== event.origin.session || !rule) continue
    const source = [...rows].reverse().find(row => row.role === 'user' && instructionKey(row.text).includes(instructionKey(rule)))
    if (!source) continue
    const address = `@${source.uuid.slice(0, 8)}`
    if (!seen.has(`${address}\0null`)) index.push({ address, issue: null, text: source.text })
  }
  const shownIssues = preview.issues ?? [...issues]
  const shownState = preview.state ?? state
  const addressesRaw = await $.store.get(issueAddressKey(key))
  const addresses = isRecord(addressesRaw) ? addressesRaw : {}
  const byId = new Map(shownIssues.map(issue => [issue.id, issue]))
  const topId = shownState.stack.at(-1)
  const top = topId ? byId.get(topId) : undefined
  const ancestors = new Set<string>()
  let current = top
  while (current && !ancestors.has(current.id)) {
    ancestors.add(current.id)
    current = current.parent ? byId.get(current.parent) : undefined
  }
  if (index.length !== (Array.isArray(rawIndex) ? rawIndex.length : 0)) await $.store.set(instructionIndexKey(key), index)
  const rawNotes = preview.notes ?? notesOf((await readText($, await ledgerPath($))) ?? EMPTY_LEDGER)
  const meta = await readMeta($)
  const topics = preview.topics ?? await storedTopics($, rawNotes, meta.seq, key)
  const scopedTopics = topics
    .map(topic => topic.focusIssue === undefined ? { ...topic, focusIssue: topId ?? null } : topic)
    .filter(topic => (topic.focusIssue ?? null) === (topId ?? null))
  const fallbackGoal = /^## 목표\s*\n([\s\S]*?)(?=\n## |$)/m.exec(rawNotes)?.[1]?.trim() ?? ''
  const where = topics.length
    ? scopedTopics.map(topic => `${topic.topic}: ${topic.summary}`)
    : fallbackGoal && fallbackGoal !== '- (none yet)' ? [fallbackGoal] : []
  const requests = (await readRequests($, key)).filter(request => request.status === 'open')
  const constraints = constraintFactLines(rawNotes).map(line => line.replace(/^\[constraint\]\s*/, ''))
  const learned = learnedFactLines(rawNotes)
  const sections: ResidentLedgerSections = {
    where,
    children: shownIssues.filter(issue => topId !== undefined && issue.parent === topId && isOpen(issue)),
    requests,
    constraints,
    uncertain: shownIssues.filter(issue => issue.status === 'uncertain'),
    learned,
  }
  const withdrawn = withdrawnInstructionKeys(rawNotes)
  const visibleIndex = index.filter(item => !withdrawn.has(instructionKey(item.text)))
  return residentLedgerText(top, top ? String(addresses[top.id] ?? '') || undefined : undefined, shownState.stack.length, shownState.pending.length, visibleIndex, ancestors, sections)
}

type TopicDraft = { topic: string; summary: string }
type SplitAnswer = { split: number; mergeReply: string; topics: TopicDraft[] }
type PreparedFold = { plan: ClearPlan; mergeReply: string; topics: TopicDraft[] }
const isTopicDraft = (v: unknown): v is TopicDraft => isRecord(v) && typeof v.topic === 'string' && v.topic.trim() !== '' && typeof v.summary === 'string' && v.summary.trim() !== ''

function parseSplitAnswer(raw: string): SplitAnswer | string {
  let value: unknown
  try { value = JSON.parse(normalizeLedger(raw)) } catch (err) { return `split reply is not JSON (${String(err).slice(0, 80)})` }
  if (!isRecord(value) || typeof value.split !== 'number' || !Number.isInteger(value.split)) return `split must be an integer turn number (received ${JSON.stringify(isRecord(value) ? value.split : undefined)})`
  if (typeof value.notes !== 'string' || !Array.isArray(value.ops)) return 'split reply needs notes and ops'
  const topicDrafts = value.topics
  if (!Array.isArray(topicDrafts) || !topicDrafts.every(isTopicDraft)) return 'split reply needs topic summaries'
  return {
    split: value.split,
    mergeReply: `${normalizeLedger(value.notes)}\n<ops>${JSON.stringify(value.ops)}</ops>`,
    topics: topicDrafts.map(topic => ({ topic: topic.topic.trim(), summary: topic.summary.trim() })),
  }
}

function isTopicList(value: unknown): value is Topic[] {
  return Array.isArray(value) && value.every(isTopic) && new Set(value.map(topic => `${instructionKey(topic.topic)}\0${topic.focusIssue ?? ''}`)).size === value.length
}

function cleanTopicDrafts(drafts: readonly TopicDraft[]): TopicDraft[] {
  return drafts.map(draft => ({ topic: draft.topic, summary: draft.summary }))
}

async function storedTopics($: EngineInterface, notes: string, seq: number, key?: string): Promise<Topic[]> {
  const stored = await $.store.get(await topicsKey($, key))
  if (isTopicList(stored)) return stored
  const goal = /^## 목표\s*\n([\s\S]*?)(?=\n## |$)/m.exec(notes)?.[1]?.trim() ?? ''
  if (!goal || goal === '- (none yet)') return []
  return [{ topic: '기존 세션 주제', summary: goal, seq: Math.max(1, seq) }]
}

const topicKey = (topic: Pick<Topic, 'topic' | 'focusIssue'>) => `${instructionKey(topic.topic)}\0${topic.focusIssue ?? ''}`

function notesWithTopics(notes: string, topics: readonly Topic[]): string {
  const goal = topics.length ? topics.map(t => `- ${t.topic}: ${t.summary}`).join('\n') : '- (none yet)'
  return withNotes(notes, `## 목표\n${goal}`)
}

const topicTokens = (topic: Pick<Topic, 'topic' | 'summary'>) => Math.ceil((topic.topic.length + topic.summary.length) / 4)
const topicFloorTokens = (topic: Pick<Topic, 'topic'>) => Math.ceil((topic.topic.length + 10) / 4)

function parseTopics(raw: string): Topic[] | string {
  let value: unknown
  try { value = JSON.parse(normalizeLedger(raw)) } catch (err) { return `topic merge is not JSON (${String(err).slice(0, 80)})` }
  if (!isRecord(value) || !isTopicList(value.topics)) return 'topic merge needs distinct {topic, summary, seq} records'
  return value.topics
}

async function compressTopics(
  $: EngineInterface, opts: Opts, input: readonly Topic[], seq: number, notes: string, issues: readonly Issue[], key?: string,
): Promise<{ topics: Topic[]; ledgerTokens: number }> {
  const normalized: (Topic & { sourceTokens: number })[] = input.map(topic => ({ ...topic, sourceTokens: topic.sourceTokens ?? topicTokens(topic) }))
  const old = new Map(normalized.map(topic => [topicKey(topic), topic]))
  const fixedNotes = notes.replace(/^## 목표\n[\s\S]*?(?=\n## |$)/m, '## 목표\n')
  const origin = await captureOrigin($)
  const events = await readAll($)
  const state = focusOf(events, origin.session)
  const ledgerKey = key ?? transcriptKey(origin.session)
  const pointer = await ledgerPath($)
  const renderRow = async (topicList: readonly Topic[], ledgerNotes: string): Promise<SessionMessage> => {
    const text = await residentLedger($, ledgerKey, issues, state, events, {
      notes: ledgerNotes, topics: [...topicList], issues, state,
    })
    return { role: 'user', text: ledgerRowText(seq, kst(), pointer, text), toolUses: [] }
  }
  const fixedRow = await renderRow([], fixedNotes)
  const fixedTokens = sum([fixedRow])
  const topicBudget = Math.max(0, opts.ledgerTarget - fixedTokens)
  const allocation = ageDecayPlan(normalized.map(topic => ({
    sourceTokens: topic.sourceTokens, currentTokens: topicTokens(topic), floorTokens: topicFloorTokens(topic), seq: topic.seq,
  })), topicBudget)
  const targets = allocation.targets
  const rewrite = allocation.rewrite.flatMap(index => {
    const topic = normalized[index]
    return topic ? [topic] : []
  })
  let retryReason = ''
  let latest = [...normalized]
  let latestTokens = 0
  if (!rewrite.length) {
    const row = await renderRow(latest, notesWithTopics(notes, latest))
    latestTokens = sum([row])
    if (latestTokens > opts.ledgerTarget) {
      const over = latestTokens - opts.ledgerTarget
      $.ui.log(`clm: ledger over budget by ${over}`, { to: 'debug' })
      await logEvent($, 'ledger-over-budget', { reason: `ledger over budget by ${over}` })
    }
    return { topics: latest, ledgerTokens: latestTokens }
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await $.model.complete({
        model: opts.model,
        system: LEDGER_COMPACT_SYSTEM,
        prompt: [
          `<budget>\n${opts.ledgerTarget} tokens for the complete ledger; fixed sections use about ${fixedTokens} tokens and topic summaries have ${topicBudget} tokens.</budget>`,
          `<fixed_sections>\n${xmlText(fixedRow.text)}\n</fixed_sections>`,
          `<topic_entries>\n${rewrite.map(topic => JSON.stringify({ ...topic, tokens: topicTokens(topic), targetTokens: targets[normalized.indexOf(topic)] })).join('\n') || '(none)'}\n</topic_entries>`,
          `<new_summary>\n${rewrite.filter(topic => topic.seq === seq).map(topic => JSON.stringify({ ...topic, tokens: topicTokens(topic), targetTokens: targets[normalized.indexOf(topic)] })).join('\n') || '(none)'}\n</new_summary>`,
          retryReason ? `<retry_rule>\n${retryReason}\n</retry_rule>` : '',
        ].filter(Boolean).join('\n\n'),
        maxTokens: Math.max(1024, Math.min(8192, opts.ledgerTarget * 2)),
        timeoutMs: 60_000,
      })
      const parsed = response.isAnswered ? parseTopics(response.text) : `topic merge gave no text (${response.reason})`
      if (typeof parsed === 'string') {
        retryReason = `The previous reply failed: ${parsed}. Return the required JSON object with a topics array.`
        if (attempt === 1) $.ui.log(`clm: topic merge failed (${parsed}); keeping the summaries as written`, { to: 'debug' })
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
        return {
          ...topic, summary: response.summary,
          seq: previous?.summary === response.summary ? previous.seq : seq,
        }
      })
      const row = await renderRow(latest, notesWithTopics(notes, latest))
      latestTokens = sum([row])
      if (latestTokens <= opts.ledgerTarget) return { topics: latest, ledgerTokens: latestTokens }
      retryReason = `The previous ledger used ${latestTokens} tokens, exceeding ${opts.ledgerTarget} by ${latestTokens - opts.ledgerTarget}. Re-summarize older topics more tightly and return the full topics array.`
    } catch (err) {
      retryReason = `The previous topic merge failed: ${String(err).slice(0, 120)}. Return the required JSON object.`
      if (attempt === 1) $.ui.log(`clm: topic merge failed (${String(err).slice(0, 120)}); keeping the summaries as written`, { to: 'debug' })
    }
  }
  const fallbackRow = await renderRow(latest, notesWithTopics(notes, latest))
  latestTokens = sum([fallbackRow])
  if (latestTokens > opts.ledgerTarget) {
    const over = latestTokens - opts.ledgerTarget
    $.ui.log(`clm: ledger over budget by ${over}`, { to: 'debug' })
    await logEvent($, 'ledger-over-budget', { reason: `ledger over budget by ${over}` })
  }
  return { topics: latest, ledgerTokens: latestTokens }
}

export type LogEvent = 'clear' | 'skip-not-shrinking' | 'merge-invalid' | 'merge-timeout' | 'ops-rejected' | 'fallback' | 'truncation' | 'escape' | 'panel-relink'
  | 'evidence-rejected' | 'review-rejected' | 'review-failed' | 'review-dropped' | 'escape-instructions-lost' | 'ledger-over-budget' | 'rewind'
type LogFields = { tokensBefore?: number; tokensAfter?: number; keptTurns?: number; ratio?: number; durationMs?: number; summaryMs?: number; reason?: string }
const LOG_KEEP = 200
async function logEvent($: EngineInterface, event: LogEvent, f: LogFields) {
  try {
    const p = await logPath($)
    const lines = ((await readText($, p)) ?? '').split('\n').filter(Boolean)
    lines.push(JSON.stringify({ ts: new Date().toISOString(), event, ...f }))
    await $.fs.write(p, `${lines.slice(-LOG_KEEP).join('\n')}\n`)
  } catch { /* the log must never stop a fold */ }
}

const RATIO_MIN = 1, RATIO_MAX = 4
const shownChanges = new Map<string, Set<string>>()
const changeHash = (line: string): string => {
  let h = 2166136261
  for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16)
}
// clm-prompt
const TURN_CHANGE_SYSTEM = 'Summarize only concrete non-task context changes from the finished coding turn. Reply with <changes>, at most three short Korean lines, or <changes></changes> when nothing changed.'
/** The engine's live context tokens, when it has a reading. */
async function usageReading($: EngineInterface): Promise<number | undefined> {
  try {
    const { tokens } = (await $.session.usage()).context
    return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : undefined
  } catch {
    return undefined
  }
}
const freshReal = (reading: number | undefined, meta: Meta) => (reading !== meta.foldTokens ? reading : undefined)
/**
 * The message tokens the budget counts: the live reading less `meta.overhead`
 * (system prompt and tool schemas), never below the rows' own estimate. Until
 * a reading has set that baseline the reading cannot be split, so the
 * estimate stands; counting the whole reading put ~35k of system prompt
 * against a 32k budget and folded every few calls.
 */
export const messageTokens = (rows: readonly SessionMessage[], observed: number | undefined, meta: Pick<Meta, 'overhead'>) => {
  const estimated = sum(rows)
  return observed === undefined || meta.overhead === undefined ? estimated : Math.max(estimated, observed - meta.overhead)
}
const clampRatio = (n: number) => Math.round(Math.min(RATIO_MAX, Math.max(RATIO_MIN, n)) * 1000) / 1000

// --- tracker I/O -----------------------------------------------------------

async function trackerDir($: Pick<TrackerReader, 'env'>): Promise<string> {
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

type CachedLog = { size: number; mtimeMs: number; events: TrackerEvent[] }
const trackerCache = new Map<string, CachedLog>()
async function readAll($: TrackerReader): Promise<TrackerEvent[]> {
  const dir = await trackerDir($)
  if (!(await $.fs.exists(dir))) return []
  const out: TrackerEvent[] = []
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
    try {
      const cached = trackerCache.get(f.name)
      const events = cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs
        ? cached.events
        : parseLog(await $.fs.read(dir + '/' + f.name))
      trackerCache.set(f.name, { size: f.size, mtimeMs: f.mtimeMs, events })
      out.push(...events)
    } catch (err) {
      $.ui.log(`clm tracker: could not read ${f.name} (${String(err).slice(0, 120)})`, { to: 'debug' })
    }
  }
  return out
}

// Each session's log is a read-then-rewrite; parallel tool calls (two
// TaskCreate in one response) would otherwise both read the same lastSeq and
// the second write would drop the first's events. Every write of one session
// runs on this chain, one after another.
const writeChains = new Map<string, Promise<unknown>>()
function serialized<T>(session: string, run: () => Promise<T>): Promise<T> {
  const result = (writeChains.get(session) ?? Promise.resolve()).then(run, run)
  writeChains.set(session, result.then(() => undefined, () => undefined))
  return result
}

/** Writes events to this session's log; only this session ever writes that file. Callers hold `serialized`. */
async function writeEvents($: EngineInterface, payloads: readonly Payload[], o: Origin): Promise<TrackerEvent[]> {
  const p = await logFile($, o.session)
  const prev = (await $.fs.exists(p)) ? await $.fs.read(p) : ''
  const lastSeq = parseLog(prev).reduce((n, e) => Math.max(n, e.seq), 0)
  const events = toEvents(payloads, o, lastSeq, new Date().toISOString())
  const body = prev && !prev.endsWith('\n') ? `${prev}\n` : prev
  await $.fs.write(p, `${body}${events.map(e => JSON.stringify(e)).join('\n')}\n`)
  return events
}

// `project` is false where the caller projects later, once its own writes are
// done. `knownTitles` drops a model-derived create whose title an issue of this
// session already carries. A dropped issue counts too: <issues> lists this
// session's newest dropped ones, so the model re-opens it by id.
async function append($: EngineInterface, payloads: readonly Payload[], origin?: Origin, project = true, knownTitles = false): Promise<TrackerEvent[]> {
  if (payloads.length === 0) return []
  const o = origin ?? (await captureOrigin($))
  return serialized(o.session, async () => {
    const before = snapshot(await readAll($))
    const titles = new Set(knownTitles ? before.filter(i => i.origin.session === o.session).map(i => i.title.trim()) : [])
    const known = payloads.filter(p => p.op === 'create' && titles.has(p.title.trim()))
    if (known.length) $.ui.log(`clm: create skipped, this session already has the title: ${known.map(p => describeOp(p)).join('; ')}`, { to: 'debug' })
    const fresh = payloads.filter(p => (p.op !== 'status' || before.find(i => i.id === p.issue)?.status !== p.status) && !known.includes(p))
    if (fresh.length === 0) return []
    const events = await writeEvents($, fresh, o)
    try {
      for (const l of describe(events, before)) $.ui.log(l)
    } catch { /* display notices never block tracker writes */ }
    if (project) await syncPanelSafely($, o, events)
    return events
  })
}

async function applyLaterClassification(
  $: EngineInterface, classification: ReturnType<typeof parseLater>, prompt: string, queueSnapshot: readonly ClmWorkflow['later'][number][],
): Promise<void> {
  const later = classification.later.filter(item => {
    if (laterSupported(item, prompt)) return true
    $.ui.log(`clm: later item dropped (not supported by prompt): ${item}`)
    return false
  })
  const drop = supportedLaterDrop(classification.laterDrop, prompt)
  if (classification.laterDrop === 'all' && drop !== 'all') $.ui.log('clm: ignored laterDrop=all without a queue reference')
  if (Array.isArray(classification.laterDrop)) {
    for (const index of classification.laterDrop) if (!drop.includes(index))
      $.ui.log(`clm: ignored later drop ${index}; its number is absent from the prompt`)
  }
  const dropItems = drop === 'all'
    ? queueSnapshot.map((item, index) => ({ text: item.text, number: index + 1 }))
    : drop.flatMap(number => {
      const item = queueSnapshot[number - 1]
      return item ? [{ text: item.text, number }] : []
    })
  if (!dropItems.length && !later.length) return
  try {
    const { dropped, queued } = await changeWorkflow($, current => {
      const { remaining, dropped } = removeQueueSnapshotTargets(current.later, queueSnapshot, dropItems.map(item => item.number))
      const queued = later.map((item, index) => ({ item, number: remaining.length + index + 1 }))
      return { next: { ...current, later: [...remaining, ...later.map(text => ({ text }))] }, result: { dropped, queued } }
    })
    for (const item of dropped) $.ui.log(`clm: dropped later item ${item.number}: ${item.item}`)
    for (const item of queued) $.ui.log(`clm: queued later item ${item.number}`)
  } catch (err) {
    $.ui.log(`clm later queue: update failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}

async function parseAndApplyLater(
  $: EngineInterface, raw: string, prompt: string, queueSnapshot: readonly ClmWorkflow['later'][number][],
): Promise<ReturnType<typeof parseLater> | undefined> {
  try {
    const classification = parseLater(raw)
    await applyLaterClassification($, classification, prompt, queueSnapshot)
    return classification
  } catch (err) {
    $.ui.log(`clm intent: later classification failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    return undefined
  }
}

async function recordPromptIntent($: EngineInterface, text: string, promptSeq: number): Promise<void> {
  const userPrompt = stripReminders(text)
  if (!userPrompt || isHarnessText(userPrompt)) return
  try {
    const origin = await captureOrigin($)
    const events = await readAll($)
    const issues = snapshot(events).filter(issue => issue.origin.session === origin.session)
    const state = focusOf(events, origin.session)
    const key = transcriptKey(origin.session)
    const requests = (await readRequests($, key)).filter(request => request.status === 'open').map(({ id, text }) => ({ id, text }))
    const workflow = await readWorkflow($)
    const queueSnapshot = workflow.later.map(item => ({ ...item }))
    const rows = await $.session.messages()
    const lastAssistantReply = [...rows].reverse().find(row => row.role === 'assistant' && row.text.trim())?.text ?? ''
    const r = await $.model.complete({
      model: 'haiku', system: INTENT_SYSTEM,
      prompt: intentPrompt({ state, issues, lastAssistantReply, userPrompt, later: queueSnapshot, requests }),
      maxTokens: 1800, timeoutMs: 15000,
    })
    if (!r.isAnswered) throw new Error(`model did not answer (${r.reason})`)

    const later = await parseAndApplyLater($, r.text, userPrompt, queueSnapshot)
    let requestClassification: RequestClassification | undefined
    try {
      requestClassification = parseRequests(r.text)
    } catch (err) {
      $.ui.log(`clm intent: request classification failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    }

    try {
      await serialized(origin.session, async () => {
        const workflowAtApply = await readWorkflow($)
        if (promptSeq <= workflowAtApply.focusAppliedSeq) {
          $.ui.log(`clm intent: dropped older focus result ${promptSeq} (applied ${workflowAtApply.focusAppliedSeq})`, { to: 'debug' })
          return
        }
      if (requestClassification) {
        try { await applyRequestClassification($, key, promptSeq, requestClassification, userPrompt, lastAssistantReply) }
        catch (err) { $.ui.log(`clm request: store update failed (${String(err).slice(0, 160)})`, { to: 'debug' }) }
      }
      const currentEvents = await readAll($)
      const allIssues = snapshot(currentEvents)
      const currentIssues = allIssues.filter(issue => issue.origin.session === origin.session)
      const currentState = focusOf(currentEvents, origin.session)
      const focused = new Set([...currentState.stack, ...currentState.pending])
      const shownOpen = currentIssues.filter(issue => isOpen(issue) && !focused.has(issue.id)).slice(0, 30)
      const isCurrentOpen = (id: string) => currentIssues.some(issue => issue.id === id && isOpen(issue))
      const knownIds = new Set([
        ...currentState.stack.filter(isCurrentOpen),
        ...currentState.pending.filter(isCurrentOpen),
        ...shownOpen.map(issue => issue.id),
      ])
      const cls = parseFocus(r.text, knownIds)
      const lastSeq = currentEvents.filter(event => event.origin.session === origin.session).reduce((n, event) => Math.max(n, event.seq), 0)
      const { payloads, next } = compose(currentState, cls, currentIssues, () => issueId(origin.session, lastSeq + 1))
      const written = await writeEvents($, [
        ...payloads,
        { op: 'focus', stack: next.stack, pending: next.pending, intent: cls.intent, ...(cls.rule === null ? {} : { rule: cls.rule }) },
      ], origin)
      try {
        for (const line of describe(written, allIssues)) $.ui.log(line)
      } catch { /* display notices never block tracker writes */ }
      const sourceRows = await transcriptRows($)
      const address = promptAddress(sourceRows, userPrompt)
      if (address) {
        const scopeIssue = cls.rule !== null
          ? null
          : currentState.stack.at(-1) ?? cls.target ?? payloads.find((payload): payload is Extract<Payload, { op: 'create' }> => payload.op === 'create')?.issue ?? next.stack.at(-1) ?? null
        if (cls.rule !== null || (cls.intent !== 'question' && isDirective(userPrompt))) {
          const rawIndex = await $.store.get(instructionIndexKey(transcriptKey(origin.session)))
          const index = Array.isArray(rawIndex) ? rawIndex.filter(isInstructionIndex) : []
          if (!index.some(item => item.address === address && item.issue === scopeIssue)) {
            const source = sourceRows.find(row => `@${row.uuid.slice(0, 8)}` === address)
            if (source) {
              index.push({ address, issue: scopeIssue, text: source.text })
              await $.store.set(instructionIndexKey(transcriptKey(origin.session)), index)
            }
          }
        }
        const addressesRaw = await $.store.get(issueAddressKey(transcriptKey(origin.session)))
        const addresses = isRecord(addressesRaw) ? { ...addressesRaw } : {}
        for (const id of new Set([cls.target, next.stack.at(-1), payloads.find((payload): payload is Extract<Payload, { op: 'create' }> => payload.op === 'create')?.issue])) {
          if (id && typeof addresses[id] !== 'string') addresses[id] = address
        }
        await $.store.set(issueAddressKey(transcriptKey(origin.session)), addresses)
      }
      if (payloads.length) await syncPanelSafely($, origin, written)
      await changeWorkflow($, current => ({
        next: promptSeq > current.focusAppliedSeq ? { ...current, focusAppliedSeq: promptSeq } : current,
        result: undefined,
      }))
      if (later && cls.intent === 'pending' && later.later.length === 1) {
        const pendingIssue = cls.target ?? payloads.find((payload): payload is Extract<Payload, { op: 'create' }> => payload.op === 'create')?.issue
        const deferred = later.later[0]
        if (pendingIssue && deferred) {
          await changeWorkflow($, current => {
            const index = current.later.map(item => item.text).lastIndexOf(deferred)
            const queued = current.later[index]
            if (index < 0 || !queued || queued.issue === pendingIssue) return { next: current, result: undefined }
            const items = [...current.later]
            items[index] = { ...queued, issue: pendingIssue }
            return { next: { ...current, later: items }, result: undefined }
          })
        }
      }
      })
    } catch (err) {
      $.ui.log(`clm intent: focus classification failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
  } catch (err) {
    $.ui.log(`clm intent: classification failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}

export async function sessionIssues($: EngineInterface, query: { issue?: string; status?: Issue['status'] } = {}): Promise<Issue[]> {
  const session = (await captureOrigin($)).session
  return snapshot(await readAll($)).filter(i => i.origin.session === session
    && (query.issue === undefined || i.id === query.issue)
    && (query.status === undefined || i.status === query.status))
}

export async function clmStatus($: StatusReader): Promise<ClmStatus> {
  const [workflow, meta, events, session, path] = await Promise.all([
    readWorkflow($), readMeta($), readAll($), $.session.id(), ledgerPath($),
  ])
  const issues = snapshot(events).filter(issue => issue.origin.session === session)
  return {
    later: workflow.later.map(item => ({ ...item })),
    resumeRequest: workflow.resumeRequest ? { ...workflow.resumeRequest } : null,
    lastFoldAt: meta.lastFoldAt ?? null,
    ledgerPath: path,
    openIssues: issues.filter(isOpen).length,
  }
}

export async function trackIssue($: EngineInterface, input: { title: string; status: Issue['status']; issue?: string }): Promise<Issue> {
  const origin = await captureOrigin($)
  if (input.issue !== undefined) {
    const before = (await sessionIssues($, { issue: input.issue }))[0]
    if (!before) throw new Error(`clm issue ${input.issue} does not belong to this session`)
    if (before.status !== input.status) await append($, [{ op: 'status', issue: input.issue, status: input.status }], origin)
    const updated = (await sessionIssues($, { issue: input.issue }))[0]
    if (!updated) throw new Error('clm tracker did not return the tracked issue')
    return updated
  }
  const title = input.title.trim()
  if (!title) throw new Error('clm issue title must not be empty')
  const events = await append($, [{ op: 'create', title, status: input.status }], origin)
  const issueId = events[0]?.issue
  const issue = issueId ? (await sessionIssues($, { issue: issueId }))[0] : undefined
  if (!issue) throw new Error('clm tracker did not return the tracked issue')
  return issue
}

const agentTaskRootsKey = (session: string) => `agent-task-roots:${session}`
const taskStatuses = new Set(['doing', 'done', 'uncertain', 'dropped'])
function isClmTaskInput(value: unknown): value is ClmTaskInput {
  if (!isRecord(value) || !taskStatuses.has(String(value.status))) return false
  if (value.id !== undefined && typeof value.id !== 'string') return false
  if (value.title !== undefined && typeof value.title !== 'string') return false
  if (value.note !== undefined && typeof value.note !== 'string') return false
  return value.evidence === undefined || (isRecord(value.evidence) && typeof value.evidence.ref === 'string' && typeof value.evidence.quote === 'string')
}

async function assignedTaskRoots($: EngineInterface, session: string): Promise<Record<string, string>> {
  const value = await $.store.get(agentTaskRootsKey(session))
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function isWithinTask(id: string, root: string, issues: ReadonlyMap<string, Issue>): boolean {
  const seen = new Set<string>()
  let current = issues.get(id)
  while (current && !seen.has(current.id)) {
    if (current.id === root) return true
    seen.add(current.id)
    current = current.parent ? issues.get(current.parent) : undefined
  }
  return false
}

function taskOwner(id: string, focusRoots: readonly string[], roots: Readonly<Record<string, string>>, issues: ReadonlyMap<string, Issue>): string | undefined {
  const seen = new Set<string>()
  let current = issues.get(id)
  while (current && !seen.has(current.id)) {
    const owner = Object.entries(roots).find(([, root]) => root === current?.id)?.[0]
    if (owner) return owner
    seen.add(current.id)
    current = current.parent ? issues.get(current.parent) : undefined
  }
  return focusRoots.some(root => isWithinTask(id, root, issues)) ? 'main' : undefined
}

function taskOwnerName(owner: string | undefined): string {
  return owner === 'main' ? 'the main agent' : owner ? `subagent ${owner}` : 'no assigned task owner'
}

async function runClmTask($: EngineInterface, input: ClmTaskInput, agentId?: string): Promise<{ result: string }> {
  const origin = await captureOrigin($)
  const events = await readAll($)
  const issues = snapshot(events).filter(issue => issue.origin.session === origin.session)
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const focus = focusOf(events, origin.session)
  const roots = await assignedTaskRoots($, origin.session)
  const ownRoot = agentId ? roots[agentId] : focus.stack.at(-1)
  if (!ownRoot) return { result: agentId ? `clm_task: subagent ${agentId} has no task assigned by the harness.` : 'clm_task: the main agent has no focused task to own.' }
  const ownRootOwner = taskOwner(ownRoot, focus.stack, roots, byId)
  if (ownRootOwner !== (agentId ?? 'main'))
    return { result: `clm_task: ${ownRoot} belongs to ${taskOwnerName(ownRootOwner)}.` }

  if (input.id !== undefined) {
    const target = byId.get(input.id)
    if (!target) return { result: `clm_task: issue ${input.id} does not exist in this session.` }
    const owner = taskOwner(target.id, focus.stack, roots, byId)
    if (owner !== (agentId ?? 'main')) return { result: `clm_task: issue ${target.id} belongs to ${taskOwnerName(owner)}.` }
  } else if (!input.title?.trim()) return { result: 'clm_task: provide an issue id to update or a title to create a child task.' }

  let status: ClmTaskInput['status'] = input.status
  let reason: string | undefined
  if (status === 'done') {
    if (!input.evidence) reason = 'done requires a tool-result ref and a verbatim quote.'
    else {
      const range = renderRange(await $.session.messages())
      const checked = checkEvidence([input.evidence], range.sources, ['tool_result'], true)
      if (!checked.held.length) reason = checked.problems.join('; ') || 'the evidence did not match this transcript.'
    }
    if (reason) status = 'uncertain'
  }

  let taskId = input.id
  const audit = status === 'done' && input.evidence ? `verified tool result ${input.evidence.ref}: ${input.evidence.quote}` : undefined
  const note = [input.note?.trim(), audit].filter((line): line is string => Boolean(line)).join('\n')
  if (taskId) {
    await append($, [{ op: 'status', issue: taskId, status }, ...(note ? [{ op: 'note' as const, issue: taskId, text: note }] : [])], origin)
  } else {
    const title = input.title?.trim()
    if (!title) return { result: 'clm_task: title must not be empty.' }
    const created = await append($, [{ op: 'create', title, status, ...(note ? { note } : {}) }], origin)
    taskId = created.find(event => event.op === 'create')?.issue
    if (!taskId) return { result: 'clm_task: task creation did not return an issue id.' }
    await append($, [{ op: 'parent', issue: taskId, parent: ownRoot }], origin)
  }

  if (taskId === focus.stack.at(-1) && (status === 'done' || status === 'dropped')) {
    const currentEvents = await readAll($)
    const currentFocus = focusOf(currentEvents, origin.session)
    const currentIssues = snapshot(currentEvents).filter(issue => issue.origin.session === origin.session)
    const lastSeq = currentEvents.reduce((n, event) => event.origin.session === origin.session ? Math.max(n, event.seq) : n, 0)
    const composed = compose(currentFocus, { intent: 'continue', target: null, title: null, rule: null }, currentIssues, () => issueId(origin.session, lastSeq + 1))
    await append($, [{ op: 'focus', stack: composed.next.stack, pending: composed.next.pending, intent: 'continue' }], origin)
  }

  const current = (await sessionIssues($, { issue: taskId }))[0]
  const actualStatus = current?.status ?? status
  return { result: `clm_task: ${taskId} ${actualStatus}${reason ? `; recorded as uncertain because ${reason}` : ''}.` }
}

const PANEL_STATUS: Record<Issue['status'], 'pending' | 'in_progress' | 'completed' | 'deleted'> = {
  todo: 'pending', doing: 'in_progress', done: 'completed', dropped: 'deleted', question: 'pending',
}
const panelSubject = (i: Issue) => `${i.status === 'question' ? '질문: ' : ''}${i.title}${i.progress ? ` (${i.progress.done}/${i.progress.total})` : ''}`
const panelDescription = (i: Issue) => i.notes.at(-1) ?? i.title
const TASK_STATUS: Record<string, Issue['status'] | undefined> = {
  pending: 'todo', in_progress: 'doing', completed: 'done', deleted: 'dropped',
}

type ModelTaskCall =
  | ({ tool: 'TaskCreate' } & BuiltinToolInputs['TaskCreate'])
  | ({ tool: 'TaskUpdate' } & BuiltinToolInputs['TaskUpdate'])
// What a model task call became in the tracker: the issues it wrote, with
// their state afterwards, and the fields the tracker has no place for; or the
// panel task id no issue of this session carries.
type Mirrored = { recorded: Issue[]; unrecorded: string[] } | { unknownTask: string }

/** Turns the model's TaskCreate / TaskUpdate into tracker ops, appended now so the notice shows at call time. */
async function mirrorModelTask($: EngineInterface, e: ModelTaskCall): Promise<Mirrored> {
  const origin = await captureOrigin($)
  const issues = snapshot(await readAll($))
  const byTask = (taskId: string) => issues.find(i => i.origin.session === origin.session && i.taskId === taskId)
  const recordedAs = async (id: string | undefined, unrecorded: string[]): Promise<Mirrored> => {
    const after = id === undefined ? undefined : snapshot(await readAll($)).find(i => i.id === id)
    return { recorded: after ? [after] : [], unrecorded }
  }
  if (e.tool === 'TaskCreate') {
    const title = e.subject.trim(), note = e.description.trim()
    if (!title) return { recorded: [], unrecorded: [] }
    const events = await append($, [{ op: 'create', title, status: 'todo', ...(note ? { note } : {}) }], origin)
    return recordedAs(events[0]?.issue, e.metadata ? ['metadata'] : [])
  }
  const issue = byTask(e.taskId)
  if (!issue) return { unknownTask: e.taskId }
  const status = e.status ? TASK_STATUS[e.status] : undefined
  const named = (ids: readonly string[] | undefined) => (ids ?? []).map(t => byTask(t)?.id ?? `task ${t}`)
  const blockedBy = named(e.addBlockedBy), blocks = named(e.addBlocks)
  const subject = e.subject?.trim(), description = e.description?.trim()
  const ops: Payload[] = [
    ...(subject && subject !== issue.title ? [{ op: 'retitle' as const, issue: issue.id, title: subject }] : []),
    ...(description ? [{ op: 'note' as const, issue: issue.id, text: description }] : []),
    ...(blockedBy.length ? [{ op: 'note' as const, issue: issue.id, text: `blocked by ${blockedBy.join(', ')}` }] : []),
    ...(blocks.length ? [{ op: 'note' as const, issue: issue.id, text: `blocks ${blocks.join(', ')}` }] : []),
    ...(status ? [{ op: 'status' as const, issue: issue.id, status }] : []),
  ]
  await append($, ops, origin)
  return recordedAs(issue.id, [...(e.owner ? ['owner'] : []), ...(e.metadata ? ['metadata'] : [])])
}

// clm-prompt
function mirrorDeny(m: Mirrored): string {
  if ('unknownTask' in m)
    return `clm 트래커에 작업 ${m.unknownTask}이(가) 없다. 이 작업 변경은 답변 본문에 적어라; clm이 다음 정리 때 트래커에 옮긴다.`
  const lines = m.recorded.map(i => `clm이 트래커에 기록했다: ${i.id} '${i.title}' → ${i.status}`)
  if (m.unrecorded.length) lines.push(`${m.unrecorded.join(', ')}은(는) 트래커에 칸이 없다. 필요하면 답변 본문에 적어라.`)
  return lines.length ? lines.join('\n') : '이 작업 변경은 답변 본문에 적어라; clm이 다음 정리 때 트래커에 옮긴다.'
}

// The model's task calls are recorded in the tracker (and through it the
// panel) at call time; the deny tells the model what was recorded.
async function denyModelTask($: EngineInterface, e: ModelTaskCall): Promise<{ deny: string }> {
  try {
    return { deny: mirrorDeny(await mirrorModelTask($, e)) }
  } catch (err) {
    $.ui.log(`clm tracker: ${e.tool} mirror failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    // clm-prompt
    return { deny: 'clm이 이 작업 변경을 기록하지 못했다. 변경 내용을 답변 본문에 적어라; clm이 다음 정리 때 트래커에 옮긴다.' }
  }
}

async function createTask($: EngineInterface, issue: Issue): Promise<string> {
  const r = await $.tool.call({ tool: 'TaskCreate', subject: panelSubject(issue), description: panelDescription(issue) })
  if ('deny' in r || r.isError) throw new Error('TaskCreate was refused')
  return r.result.task.id
}

async function updateTask($: EngineInterface, taskId: string, issue: Issue, status = PANEL_STATUS[issue.status]): Promise<void> {
  const r = await $.tool.call({
    tool: 'TaskUpdate', taskId, subject: panelSubject(issue), description: panelDescription(issue), status,
  })
  if ('deny' in r || r.isError) throw new Error('TaskUpdate was refused')
  // A missing task can come back as success: false with no isError.
  if (!r.result.success) throw new Error(`TaskUpdate failed: ${r.result.error ?? 'success: false'}`)
}

// One pass over one snapshot: an issue without a task gets one (a dropped or
// archived one never needs it), a projected issue is updated only when it was
// touched by `events` or moved into or out of the archive by them, and the new
// task ids land in one write that does not project again. An archived done
// issue leaves the panel through the same deleted status a dropped one uses.
async function syncPanel($: EngineInterface, origin: Origin, events: readonly TrackerEvent[]): Promise<void> {
  const all = await readAll($)
  const fresh = new Set(events.map(e => e.seq))
  const issues = snapshot(all).filter(i => i.origin.session === origin.session)
  const archived = archivedDone(issues, origin.session)
  const archivedBefore = archivedDone(snapshot(all.filter(e => e.origin.session !== origin.session || !fresh.has(e.seq))), origin.session)
  const touched = new Set([
    ...events.map(e => e.issue),
    ...[...archived].filter(id => !archivedBefore.has(id)),
    ...[...archivedBefore].filter(id => !archived.has(id)),
  ])
  const panelStatus = (i: Issue) => (archived.has(i.id) ? 'deleted' : PANEL_STATUS[i.status])
  const links: Payload[] = []
  for (const issue of issues) {
    if (issue.taskId ? !touched.has(issue.id) || (archived.has(issue.id) && archivedBefore.has(issue.id)) : panelStatus(issue) === 'deleted') continue
    try {
      let taskId = issue.taskId
      if (!taskId) {
        taskId = await createTask($, issue)
        links.push({ op: 'task', issue: issue.id, taskId })
      } else {
        try {
          await updateTask($, taskId, issue, panelStatus(issue))
        } catch (err) {
          const oldTaskId = taskId
          taskId = await createTask($, issue)
          links.push({ op: 'task', issue: issue.id, taskId })
          await logEvent($, 'panel-relink', { reason: issue.id + ': ' + oldTaskId + ' -> ' + taskId + ' (' + String(err).slice(0, 120) + ')' })
          if (panelStatus(issue) !== 'pending') await updateTask($, taskId, issue, panelStatus(issue))
        }
      }
      if (!issue.taskId && panelStatus(issue) !== 'pending') await updateTask($, taskId, issue, panelStatus(issue))
    } catch (err) {
      $.ui.log(`clm task panel: ${issue.id} not projected (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
  }
  if (links.length) await writeEvents($, links, origin)
}

async function syncPanelSafely($: EngineInterface, origin: Origin, events: readonly TrackerEvent[]): Promise<void> {
  try {
    if (origin.session === await sid($)) await syncPanel($, origin, events)
  } catch (err) {
    $.ui.log(`clm task panel: projection failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}
const projectPanel = ($: EngineInterface, origin: Origin, events: readonly TrackerEvent[]) =>
  serialized(origin.session, () => syncPanelSafely($, origin, events))

// `/clm board` reads every session's log, writes a self-contained page and opens it.
async function openBoard($: EngineInterface) {
  const [events, here] = await Promise.all([readAll($), captureOrigin($)])
  const issues = snapshot(events).map(i => ({
    id: i.id, title: i.title, status: i.status, repo: i.origin.repo, ...(i.origin.branch ? { branch: i.origin.branch } : {}), updated: i.updated,
  }))
  const path = `${await basePath($)}.board.html`
  await $.fs.write(path, boardHtml(issues, here.repo, kst()))
  const r = await $.process.run(['open', path], { timeoutMs: 5000 })
  if (r.exitCode !== 0) $.ui.log(`clm: could not open the board at ${path} (exit ${r.exitCode}: ${r.stderr.slice(0, 160)})`)
  else $.ui.log(`clm: board opened (${path})`)
}

// --- folding -------------------------------------------------------------

// `finished` is this session's archived done issues, shown to the merge model
// only, so it does not re-create them from the turns being folded.
// `dropped` is shown to the merge model, so it can re-open one
// by id; the ledger and the panel keep to `issues`.
type TrackerView = { issues: Issue[]; dropped: Issue[]; finished: Issue[]; doneTitles: Set<string> }
const DROPPED_SHOWN = 5
/** The issues the merge model sees and may name by id. */
const modelIssues = (view: TrackerView) => [...view.issues, ...view.dropped]
type Fold = { plan: ClearPlan; notes: string; fullNotes: string; ops: Payload[]; seq: number; fallback: boolean; promoted: Payload[]; hold: Held[]; settled: string[]; topics?: Topic[]; tailTokens: number }

// The issues one session's ledger shows, with `ops` previewed on top when the
// fold has not appended them yet; ids then match what append assigns.
async function trackerView($: EngineInterface, here: Origin, ops: readonly Payload[] = []): Promise<TrackerView> {
  const events = await readAll($)
  const lastSeq = events.reduce((n, e) => (e.origin.session === here.session ? Math.max(n, e.seq) : n), 0)
  const all = snapshot([...events, ...toEvents(ops, here, lastSeq, new Date().toISOString())])
  const archived = archivedDone(all, here.session)
  const done = all.filter(i => i.status === 'done' && i.origin.session === here.session)
  return {
    issues: injected(all, here),
    dropped: all.filter(i => i.origin.session === here.session && i.status === 'dropped').sort((a, b) => a.updated.localeCompare(b.updated)).slice(-DROPPED_SHOWN),
    finished: done.filter(i => archived.has(i.id)), doneTitles: new Set(done.map(i => i.title.trim())),
  }
}

// --- evidence gate and review ------------------------------------------------

type Gated = { ops: Payload[]; evidence: Evidence[][]; facts: Fact[] }

/** The mechanical check: a done claim without a held quote is downgraded, a fact without one dropped, and each rejection logged. */
async function gateMerge($: EngineInterface, ops: readonly Payload[], evidence: readonly Evidence[][], facts: readonly Fact[], sources: ReadonlyMap<string, Source>, ratio: number, dropped: ReadonlySet<string>): Promise<Gated> {
  const gated = gateOps(ops, evidence, sources, dropped)
  const rejections = [...gated.rejections]
  const kept: Fact[] = []
  for (const f of facts) {
    const { held, problems } = checkEvidence(f.evidence, sources)
    const hasToolEvidence = held.some(item => sources.get(item.ref)?.kind === 'tool_result')
    if (held.length && (f.kind !== 'constraint' || hasToolEvidence)) kept.push({ ...f, evidence: held })
    else rejections.push(`fact "${f.text}" dropped (${problems.join('; ') || (f.kind === 'constraint' ? 'constraint needs tool-result evidence' : 'no evidence')})`)
  }
  if (rejections.length) await logEvent($, 'evidence-rejected', { ratio, reason: rejections.join(' | ').slice(0, 2000) })
  return { ops: gated.ops, evidence: gated.evidence, facts: kept }
}

// A claim no reviewer has accepted yet is held here, out of the ledger, until
// a fold's reviewer judges it: a drop the review could not audit (the issue
// stays open), and a fact whose fold review failed. Each entry keeps the cited
// rows' text, since those rows may be gone by the time a fold runs, and a nonce
// so a refreshed held entry survives a fold that read its earlier version.
export type Held = { key: string; nonce: string; kind: 'drop' | 'fact'; factKind?: Fact['kind']; issue?: string; text?: string; evidence: Evidence[]; sources: Record<string, Source> }
const heldKey = async ($: EngineInterface) => `held:${await sid($)}`
export function isHeld(v: unknown): v is Held {
  return isRecord(v) && typeof v.key === 'string' && typeof v.nonce === 'string' && (v.kind === 'drop' || v.kind === 'fact')
    && optional(v.issue, 'string') && optional(v.text, 'string') && (v.factKind === undefined || v.factKind === 'constraint' || v.factKind === 'learned')
    && Array.isArray(v.evidence) && isRecord(v.sources)
}
const token = (h: Pick<Held, 'key' | 'nonce'>) => `${h.key}#${h.nonce}`
const newNonce = async ($: EngineInterface) => `${await $.clock.now()}-${Math.random().toString(36).slice(2, 10)}`
async function readHeld($: EngineInterface): Promise<Held[]> {
  const v = await $.store.get(await heldKey($))
  return Array.isArray(v) ? v.filter(isHeld) : []
}
// A held fact's stored evidence always holds, so only a verdict settles it;
// with the reviewer down every fold would add its facts for good and resend
// them all. Past this many the oldest are settled unreviewed.
const HELD_FACTS_MAX = 20
/** Drops the `settled` (key, nonce) entries, then adds `added`, each replacing any entry with its key, and settles the oldest facts past HELD_FACTS_MAX. */
async function updateHeld($: EngineInterface, settled: readonly string[], added: readonly Held[]): Promise<void> {
  if (!settled.length && !added.length) return
  const gone = new Set(settled), keys = new Set(added.map(h => h.key))
  let list = [...(await readHeld($)).filter(h => !gone.has(token(h)) && !keys.has(h.key)), ...added]
  const facts = list.filter(h => h.kind === 'fact')
  if (facts.length > HELD_FACTS_MAX) {
    const dropped = new Set(facts.slice(0, facts.length - HELD_FACTS_MAX))
    list = list.filter(h => !dropped.has(h))
    await logEvent($, 'review-dropped', { reason: `${dropped.size} held fact(s) settled unreviewed past the cap of ${HELD_FACTS_MAX}: ${[...dropped].map(h => h.text).join(' | ')}`.slice(0, 2000) })
  }
  if (list.length) await $.store.set(await heldKey($), list)
  else await $.store.delete(await heldKey($))
}
/** The status a held issue claim moves its issue to once a reviewer accepts it. */
const heldStatus = () => 'dropped' as const
const heldDrop = async ($: EngineInterface, issue: string, evidence: Evidence[], sources: Record<string, Source>): Promise<Held> =>
  ({ key: `drop:${issue}`, nonce: await newNonce($), kind: 'drop', issue, evidence, sources })
const citedSources = (evidence: readonly Evidence[], sources: ReadonlyMap<string, Source>) =>
  Object.fromEntries(evidence.flatMap(e => { const src = sources.get(e.ref); return src ? [[e.ref, src]] : [] }))

/** A held claim ready for review, its evidence re-checked against the stored rows. */
type HeldClaim = { held: Extract<Held, { kind: 'drop' }>; issue: Issue; evidence: Evidence[] }
type HeldFactClaim = { held: Extract<Held, { kind: 'fact' }> & { text: string }; evidence: Evidence[] }

/** Resolves held drops against this session's still-open issues and re-checks each stored evidence quote. */
function heldClaims(list: readonly Held[], issues: readonly Issue[], session: string): { claims: HeldClaim[]; facts: HeldFactClaim[]; settled: string[] } {
  const claims: HeldClaim[] = [], facts: HeldFactClaim[] = [], settled: string[] = []
  for (const h of list) {
    const { held } = checkEvidence(h.evidence, new Map(Object.entries(h.sources)), h.kind === 'drop' ? ['user'] : undefined)
    const issue = h.kind === 'drop' ? issues.find(i => i.id === h.issue && i.origin.session === session) : undefined
    if (!held.length || (h.kind === 'drop' && (!issue || issue.status === 'done' || issue.status === 'dropped')) || (h.kind === 'fact' && !h.text)) settled.push(token(h))
    else if (h.kind === 'fact' && h.text) facts.push({ held: { ...h, text: h.text }, evidence: held })
    else if (issue) claims.push({ held: h, issue, evidence: held })
  }
  return { claims, facts, settled }
}

type ReviewInput = {
  ops: readonly Payload[]; evidence: readonly Evidence[][]; facts: readonly Fact[]; issues: readonly Issue[]
  claims: readonly HeldClaim[]; heldFacts: readonly HeldFactClaim[]; range: { text: string; sources: ReadonlyMap<string, Source> }; ratio: number
}
type Reviewed = { ops: Payload[]; facts: Fact[]; promoted: Payload[]; hold: Held[]; settled: string[]; failed: boolean }
// Room for one verdict line per claim, so a large held set cannot truncate the reply into a parse failure.
const reviewMaxTokens = (claims: number) => Math.min(16_384, Math.max(2048, 512 + 100 * claims))
const droppedIds = (issues: readonly Issue[]) => new Set(issues.filter(i => i.status === 'dropped').map(i => i.id))
// What a failed review still lets land: ops that add an issue or move it forward.
// A note, a retitle, or a move to question rewrites what the tracker already
// shows, and nothing has audited it; these carry no evidence for a held entry
// to keep, so they are dropped and the next fold re-reads any that still hold
// from the kept turns. A drop carries its user quote, so it is held instead; a
// re-open of a dropped issue is discarded, and the next fold re-reads it.
const landsUnreviewed = (o: Payload, dropped: ReadonlySet<string>) =>
  o.op === 'create' || o.op === 'progress' || o.op === 'task' || o.op === 'link'
  || (o.op === 'status' && o.status !== 'dropped' && o.status !== 'question' && !isReopenClaim(o, dropped))

/**
 * A second model call audits the gated ops, the facts and the held claims
 * against the folded range. A done reaches 한 일 and a fact 핵심 사실·경로 only
 * on an accept. A rejected or unverdicted done is downgraded; a rejected
 * non-done op or fact is dropped, and so is an unverdicted fact. A failed or
 * malformed review downgrades every done, drops the ops `landsUnreviewed`
 * refuses, holds every fact for the next fold, and reports `failed` so the
 * caller drops the merge's retracts. A held claim lands on accept, is settled on reject, and stays held
 * otherwise. The review never blocks the fold.
 */
async function reviewFold($: EngineInterface, opts: Opts, input: ReviewInput): Promise<Reviewed> {
  const title = (id: string) => input.issues.find(i => i.id === id)?.title
  const withSource = (c: HeldClaim) => Object.fromEntries(c.evidence.map(e => [e.ref, c.held.sources[e.ref]?.text ?? '']))
  const claims = [
    ...input.ops.map((o, i) => ({ id: `op${i + 1}`, claim: describeOp(o, 'issue' in o ? title(o.issue) : undefined), evidence: input.evidence[i] ?? [] })),
    ...input.facts.map((f, i) => ({ id: `fact${i + 1}`, claim: `fact (${f.kind ?? 'learned'}): ${f.text}`, kind: f.kind ?? 'learned', evidence: f.evidence })),
    ...input.claims.map((c, i) => ({ id: `drop${i + 1}`, claim: describeOp({ op: 'status', issue: c.issue.id, status: heldStatus() }, c.issue.title), evidence: c.evidence, source: withSource(c) })),
    ...input.heldFacts.map((c, i) => ({ id: `held${i + 1}`, claim: `fact (${c.held.factKind ?? 'learned'}): ${c.held.text}`, kind: c.held.factKind ?? 'learned', evidence: c.evidence, source: withSource(c) })),
  ]
  let review
  try {
    const r = await $.model.complete({
      model: opts.reviewModel,
      system: REVIEW_SYSTEM,
      prompt: [
        `<claims>\n${claims.map(c => JSON.stringify(c)).join('\n') || '(none)'}\n</claims>`,
        `<folded_range>\n${input.range.text}\n</folded_range>`,
      ].join('\n\n'),
      maxTokens: reviewMaxTokens(claims.length),
      timeoutMs: 60_000,
    })
    review = r.isAnswered ? parseReview(r.text) : `review model gave no text (${r.reason})`
  } catch (err) {
    review = `review call failed (${String(err).slice(0, 120)})`
  }
  if (typeof review === 'string') {
    const dones = input.ops.filter(isDoneClaim).length
    const dropped = droppedIds(input.issues)
    const refused = input.ops.filter(o => !landsUnreviewed(o, dropped) && !isDropClaim(o))
    const hold: Held[] = []
    for (const [i, o] of input.ops.entries()) if (o.op === 'status' && isDropClaim(o)) hold.push(await heldDrop($, o.issue, input.evidence[i] ?? [], citedSources(input.evidence[i] ?? [], input.range.sources)))
    const drops = hold.length
    for (const f of input.facts) hold.push({ key: `fact:${instructionKey(f.text)}`, nonce: await newNonce($), kind: 'fact', factKind: f.kind, text: f.text, evidence: f.evidence, sources: citedSources(f.evidence, input.range.sources) })
    await logEvent($, 'review-failed', { ratio: input.ratio, reason: `${review}; ${dones} done(s) moved to uncertain, ${refused.length} unreviewed op(s) dropped${refused.length ? ` (${refused.map(o => describeOp(o)).join('; ')})` : ''}, ${drops} drop(s) held, retracts dropped, ${input.facts.length} fact(s) and ${input.claims.length + input.heldFacts.length} held claim(s) held for the next fold`.slice(0, 2000) })
    return { ops: input.ops.filter(o => landsUnreviewed(o, dropped)).map(o => (isDoneClaim(o) ? downgrade(o) : o)), facts: [], promoted: [], hold, settled: [], failed: true }
  }
  const verdict = new Map(review.map(v => [v.id, v]))
  const lines: string[] = []
  const ops = input.ops.flatMap((o, i): Payload[] => {
    const v = verdict.get(`op${i + 1}`)
    if (v?.accept) return [o]
    if (!v && !isDoneClaim(o)) return [o]
    const why = v ? v.reason : 'no verdict'
    lines.push(`op${i + 1} ${describeOp(o)}: ${isDoneClaim(o) ? 'done moved to uncertain' : 'dropped'} (${why})`)
    return isDoneClaim(o) ? [downgrade(o)] : []
  })
  const facts = input.facts.filter((f, i) => {
    const v = verdict.get(`fact${i + 1}`)
    if (!v?.accept) lines.push(`fact${i + 1} "${f.text}" dropped (${v ? v.reason : 'no verdict'})`)
    return v?.accept === true
  })
  const promoted: Payload[] = [], settled: string[] = []
  const judge = (id: string, c: HeldClaim, land: () => void) => {
    const v = verdict.get(id)
    if (!v) return void lines.push(`${id} ${c.held.key}: still held (no verdict)`)
    settled.push(token(c.held))
    if (v.accept) land()
    else lines.push(`${id} ${c.held.key}: settled unaccepted (${v.reason})`)
  }
  input.claims.forEach((c, i) => judge(`drop${i + 1}`, c, () => promoted.push({ op: 'status', issue: c.issue.id, status: heldStatus() })))
  input.heldFacts.forEach((c, i) => judge(`held${i + 1}`, c, () => facts.push({ text: c.held.text, evidence: c.evidence, kind: c.held.factKind })))
  if (lines.length) await logEvent($, 'review-rejected', { ratio: input.ratio, reason: lines.join(' | ').slice(0, 2000) })
  return { ops, facts, promoted, hold: [], settled, failed: false }
}

/**
 * Plans a fold of `rows` and merges the dropped turns into the ledger. Returns
 * the reason instead when there is nothing to fold, the merge failed and
 * `mustFold` is off, or the result would not be smaller. Updates `meta.fails`;
 * the caller writes `meta`.
 */
// `calibrate` is false on the escape retry, whose usage reading predates the
// withheld rows and so would inflate the ratio and overhead.
async function fold($: EngineInterface, opts: Opts, rows: readonly SessionMessage[], meta: Meta, mustFold: boolean, reading?: number, calibrate = true, prepared?: PreparedFold, transcript?: string): Promise<Fold | string> {
  const observed = freshReal(reading ?? await usageReading($), meta)
  const calib = calibrate ? observed : undefined
  const estimated = sum(rows)
  const overhead = meta.overhead ?? 0
  // The ratio needs an overhead baseline (system prompt, tools) to subtract;
  // the first reading only sets that baseline, below.
  const ratio = calib === undefined || meta.overhead === undefined ? (meta.ratio ?? 1) : clampRatio(calib / Math.max(1, overhead + estimated))
  if (calib !== undefined) {
    if (meta.overhead !== undefined) meta.ratio = ratio
    meta.lastObserved = calib
  }
  const prev = (await readText($, await ledgerPath($))) ?? EMPTY_LEDGER
  // tailTarget counts message tokens, as the budget does; the system prompt and tool schemas are outside it.
  const plan = prepared?.plan ?? planClear(rows, Math.max(0, opts.tailTarget / ratio), Math.ceil(prev.length / 4) + 60)
  if (!plan) return 'nothing left to fold'

  const here = await captureOrigin($)
  const view = await trackerView($, here)
  let notes = notesOf(prev)
  // Taken before the merge, which may drop them, so a withheld file keeps its pointer.
  const kept = [...preservedLines(notes), ...withheldLines(plan.dropped)]
  const storedInstructions = instructionValues(notes)
  const instructions = storedInstructions.filter(i => !i.startsWith(WITHDRAWN_PREFIX))
  const priorFacts = factLines(notes)
  const range = renderRange(plan.dropped)
  let ops: Payload[] = []
  let evidence: Evidence[][] = []
  let facts: Fact[] = []
  let retracted: string[] = []
  let withdrawn: string[] = []
  let fallback = false
  let promoted: Payload[] = []
  let hold: Held[] = []
  const held = heldClaims(await readHeld($), view.issues, here.session)
  let settled = held.settled
  let topics: Topic[] | undefined
  if (plan.dropped.length > 0) {
    const legacy = legacyItems(prev)
    const r = prepared
      ? { isAnswered: true, text: prepared.mergeReply, reason: '' }
      : await $.model.complete({
        model: opts.model,
        system: MERGE_SYSTEM,
        prompt: [
          `<notes>\n${mergeableNotes(notes)}\n</notes>`,
          `<instructions>\n${instructions.map(i => JSON.stringify(i)).join('\n') || '(none)'}\n</instructions>`,
          `<facts>\n${priorFacts.join('\n') || '(none)'}\n</facts>`,
          `<issues>\n${issueList(modelIssues(view))}\n</issues>`,
          ...(view.finished.length ? [`<finished_earlier>\n${view.finished.map(i => `- ${i.title}`).join('\n')}\n</finished_earlier>`] : []),
          ...(legacy.length ? [`<legacy>\n${legacy.join('\n')}\n</legacy>`] : []),
          `<removed_turns>\n${range.text}\n</removed_turns>`,
        ].join('\n\n'),
        maxTokens: 4096,
        timeoutMs: 120_000,
      })
    const withdrawable = [...instructions, ...plan.dropped.filter(isUserTyped).map(m => stripReminders(m.text))]
    const merged = r.isAnswered ? parseMerge(r.text, new Set(modelIssues(view).map(i => i.id)), Math.max(500, Math.floor(opts.budget / 4)), withdrawable, priorFacts) : 'merge model gave no text (' + r.reason + ')'
    const bad = typeof merged === 'string' ? merged : undefined
    if (typeof merged !== 'string') {
      notes = withNotes(notes, merged.notes)
      ;({ ops, evidence, facts, retracted, withdrawn } = merged)
      meta.fails = 0
      if (merged.rejected) await logEvent($, 'ops-rejected', { ratio, reason: `${merged.rejected} op(s) failed validation; ${ops.length} kept` })
      const gated = await gateMerge($, ops, evidence, facts, range.sources, ratio, droppedIds(view.dropped))
      ;({ ops, evidence, facts } = gated)
    } else {
      meta.fails += 1
      await logEvent($, !r.isAnswered && r.reason === 'aborted' ? 'merge-timeout' : 'merge-invalid', { ratio, reason: `${bad} (failure ${meta.fails} in a row)` })
      if (!mustFold && meta.fails < FAILS_BEFORE_FALLBACK) return `merged ledger rejected: ${bad}`
      // A merge that never succeeds must not block folding forever.
      ;(notes = fallbackLedger(notes, plan.dropped)), (ops = [])
      evidence = ops.map(() => [])
      fallback = true
      meta.fails = 0
      $.ui.log(`clm: merge failed (${bad}); folded with a mechanical ledger instead`, { to: 'debug' })
      await logEvent($, 'fallback', { ratio, reason: bad })
    }
    // The fallback's ops claim no done, so only the merge claims and held drops go to review.
    const reviewed = await reviewFold($, opts, {
      ops: fallback ? [] : ops, evidence: fallback ? [] : evidence, facts, issues: modelIssues(view), claims: held.claims, heldFacts: held.facts, range, ratio,
    })
    if (!fallback) ops = reviewed.ops
    // A retract deletes a fact a reviewer once accepted; with no verdict on it, the fact stays.
    if (reviewed.failed) retracted = []
    facts = reviewed.facts
    promoted = reviewed.promoted
    hold = reviewed.hold
    settled = [...settled, ...reviewed.settled]
  }
  // Backstop for the merge model: a completed issue is never created twice.
  ops = ops.filter(o => !(o.op === 'create' && o.status === 'done' && view.doneTitles.has(o.title.trim())))
  notes = rememberFacts(notes, facts, retracted)
  const preserved = preserveInstructions(notes, storedInstructions, plan.dropped, await ledgerPath($), withdrawn)
  notes = rememberPreserved(rememberOversize(preserved.notes, oversizeLines(plan.tail, plan.cuts)), kept)
  let fullNotes = rememberPreserved(rememberOversize(preserved.fullNotes, oversizeLines(plan.tail, plan.cuts)), kept)

  const seq = meta.seq + 1
  const currentView = await trackerView($, here, [...ops, ...promoted])
  const currentEvents = await readAll($)
  const focusState = focusOf(currentEvents, here.session)
  const focusIssue = focusState.stack.at(-1) ?? null
  const previousTopics = (await storedTopics($, notesOf(prev), meta.seq, transcript))
    .map(topic => topic.focusIssue === undefined ? { ...topic, focusIssue } : topic)
  if (prepared) {
    const freshTopics = prepared.topics.map(t => ({ ...t, sourceTokens: topicTokens(t), seq, focusIssue }))
    const compacted = await compressTopics($, opts, [...previousTopics, ...freshTopics], seq, notes, currentView.issues, transcript ?? `${here.session}:main`)
    notes = notesWithTopics(notes, compacted.topics)
    fullNotes = notesWithTopics(fullNotes, compacted.topics)
    topics = compacted.topics
  } else {
    const goal = /^## 목표\s*\n([\s\S]*?)(?=\n## |$)/m.exec(notes)?.[1]?.trim() ?? ''
    if (goal && goal !== '- (none yet)') {
      const focus = currentView.issues.find(issue => issue.id === focusIssue)
      const latest: Topic = {
        topic: focus?.title ?? '현재 작업', summary: goal, seq, sourceTokens: Math.ceil(goal.length / 4), focusIssue,
      }
      topics = [...previousTopics.filter(topic => topic.focusIssue !== focusIssue), latest]
      notes = notesWithTopics(notes, topics)
      fullNotes = notesWithTopics(fullNotes, topics)
    } else topics = previousTopics
  }
  const previewLedger = await residentLedger($, transcript ?? `${here.session}:main`, currentView.issues, focusState, currentEvents, {
    notes: fullNotes, topics, issues: currentView.issues, state: focusState,
  })
  const text = ledgerRowText(seq, kst(), await ledgerPath($), previewLedger)
  const tokensBefore = messageTokens(rows, observed, meta)
  const tokensAfter = sum(buildCleared(plan, { role: 'user', text, toolUses: [] }))
  const tailTokens = sum([{ role: 'user', text, toolUses: [] }, ...plan.tail.filter(m => !isLedgerRow(m) && !isSystemRow(m))])
  if (tokensAfter >= tokensBefore && (!prepared || tailTokens <= opts.tailTarget)) {
    const why = `the fold would not shrink the context (${tokensBefore} -> ${tokensAfter} est. tokens)`
    $.ui.log(`clm: ${why}`)
    await logEvent($, 'skip-not-shrinking', { tokensBefore, tokensAfter, keptTurns: plan.keptTurns, ratio, reason: why })
    return why
  }
  if (Object.keys(plan.cuts).length)
    await logEvent($, 'truncation', { keptTurns: plan.keptTurns, ratio, reason: `cut ${Object.keys(plan.cuts).length} tool result(s) to ~${Object.values(plan.cuts)[0]}t each` })
  if (calib !== undefined) meta.overhead = Math.max(0, calib - estimated)
  return {
    plan, notes, fullNotes, ops, seq, fallback, promoted, hold, settled, topics, tailTokens,
  }
}

type QueueTurn = { number: number; start: number; rows: readonly SessionMessage[] }
const foldJobs = new Map<string, FoldJob>()
const transcriptKey = (session: string, agentId?: string) => `${session}:${agentId ?? 'main'}`

function queueTurns(rows: readonly SessionMessage[], first: number): QueueTurn[] {
  const start = first + 1
  const queue = rows.slice(start)
  const prompts = queue.flatMap((m, index) => isPrompt(m) ? [index] : [])
  return prompts.map((prompt, i) => {
    const from = i === 0 ? 0 : prompt
    const to = prompts[i + 1] ?? queue.length
    return { number: i + 1, start: start + prompt, rows: queue.slice(from, to).filter(m => !isLedgerRow(m)) }
  })
}

function splitPrompt(prev: string, turns: readonly QueueTurn[], retryRule: string): string {
  let refOffset = 0
  const numbered = turns.map(turn => {
    const citable = turn.rows.filter(m => !isSystemRow(m) && !isLedgerRow(m))
    const rendered = renderRange(citable, 120_000, refOffset).text
    refOffset += citable.length
    return `<turn number="${turn.number}" tokens="${sum(turn.rows)}">\n${xmlText(rendered)}\n</turn>`
  }).join('\n')
  return [
    `<current_ledger>\n${xmlText(prev)}\n</current_ledger>`,
    `<queue_turns>\n${numbered}\n</queue_turns>`,
    retryRule ? `<retry_rule>\n${xmlText(retryRule)}\n</retry_rule>` : '',
  ].filter(Boolean).join('\n\n')
}

async function prepareBackgroundFold($: EngineInterface, opts: Opts, rows: readonly SessionMessage[], meta: Meta, first: number, turns: readonly QueueTurn[], key: string): Promise<Pending | undefined> {
  const session = await sid($)
  const startedAt = await $.clock.now()
  const previous = (await readText($, await ledgerPath($))) ?? EMPTY_LEDGER
  const here = await captureOrigin($)
  const view = await trackerView($, here)
  const known = new Set([...view.issues, ...view.dropped].map(issue => issue.id))
  let retryRule = ''
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await $.model.complete({
      model: opts.model,
      system: SPLIT_MERGE_SYSTEM,
      prompt: splitPrompt(previous, turns, retryRule),
      maxTokens: 8192,
      timeoutMs: 120_000,
    })
    const answer = response.isAnswered ? parseSplitAnswer(response.text) : `split model gave no text (${response.reason})`
    if (typeof answer === 'string') {
      retryRule = `The previous reply failed: ${answer}. Return the required JSON object and choose a whole-turn split.`
      if (attempt === 1) $.ui.log(`clm: split summary failed (${answer}); the next turn end may retry`, { to: 'debug' })
      continue
    }
    const boundary = turns[answer.split - 1]
    if (answer.split < 2 || !boundary || !turns.slice(0, answer.split - 1).some(turn => turn.rows.length)) {
      retryRule = `The previous split=${answer.split} did not leave a non-empty A and a B starting at a prompt row. Choose split from 2 through ${turns.length}.`
      if (attempt === 1) $.ui.log(`clm: split summary rejected (${retryRule}); the next turn end may retry`, { to: 'debug' })
      continue
    }
    const keepFrom = boundary.start
    const plan: ClearPlan = {
      head: rows.slice(0, first + 1),
      dropped: rows.slice(first + 1, keepFrom).filter(m => !isLedgerRow(m) && !isSystemRow(m)),
      tail: rows.slice(keepFrom),
      keptTurns: turns.length - answer.split + 1,
      cuts: {},
    }
    if (plan.dropped.length === 0) {
      retryRule = `The previous split=${answer.split} left A empty. Choose split from 2 through ${turns.length}.`
      if (attempt === 1) $.ui.log(`clm: split summary rejected (${retryRule}); the next turn end may retry`, { to: 'debug' })
      continue
    }
    const merge = parseMerge(answer.mergeReply, known, Math.max(500, Math.floor(opts.budget / 4)), instructionValues(notesOf(previous)), factLines(notesOf(previous)))
    if (typeof merge === 'string') {
      retryRule = `The previous summary failed validation: ${merge}. Return valid note sections and ops in the required JSON object.`
      if (attempt === 1) $.ui.log(`clm: split summary rejected (${merge}); the next turn end may retry`, { to: 'debug' })
      continue
    }
    const prepared: PreparedFold = { plan, mergeReply: answer.mergeReply, topics: cleanTopicDrafts(answer.topics) }
    const folded = await fold($, opts, rows, meta, false, undefined, true, prepared, key)
    if (typeof folded === 'string') {
      await writeMeta($, meta)
      $.ui.log(`clm: background fold skipped (${folded})`, { to: 'debug' })
      return undefined
    }
    if (folded.tailTokens > opts.tailTarget) {
      retryRule = `The previous split=${answer.split} produced ${folded.tailTokens} tokens for the new ledger plus B, above tailTarget=${opts.tailTarget}; choose an earlier whole-topic boundary or shorter summaries.`
      if (attempt === 1) {
        $.ui.log(`clm: split summary dropped (${retryRule}); the next turn end may retry`, { to: 'debug' })
        return undefined
      }
      continue
    }
    await writeMeta($, meta)
    const summaryMs = Math.max(0, (await $.clock.now()) - startedAt)
    const pending: Pending = {
      notes: folded.notes, fullNotes: folded.fullNotes, ops: folded.ops, seq: folded.seq,
      keepFp: folded.plan.tail[0] && fingerprint(folded.plan.tail[0]), keepFrom: rows.length - folded.plan.tail.length,
      dropFps: folded.plan.dropped.filter(m => !isLedgerRow(m) && !isSystemRow(m)).map(fingerprint),
      cuts: folded.plan.cuts, keptTurns: folded.plan.keptTurns, fallback: folded.fallback,
      summaryMs, topics: folded.topics,
      promoted: folded.promoted, hold: folded.hold, settled: folded.settled,
    }
    return pending
  }
  $.ui.log(`clm: background fold gave up for ${session}`, { to: 'debug' })
  return undefined
}

function pendingFromFold(folded: Fold, rows: readonly SessionMessage[], summaryMs: number): Pending {
  const keepFrom = rows.length - folded.plan.tail.length
  const keptRow = rows[keepFrom]
  return {
    notes: folded.notes, fullNotes: folded.fullNotes, ops: folded.ops, seq: folded.seq,
    ...(keptRow ? { keepFp: fingerprint(keptRow) } : {}), keepFrom,
    dropFps: folded.plan.dropped.filter(m => !isLedgerRow(m) && !isSystemRow(m)).map(fingerprint),
    cuts: folded.plan.cuts, keptTurns: folded.plan.keptTurns, fallback: folded.fallback,
    summaryMs, topics: folded.topics,
    promoted: folded.promoted, hold: folded.hold, settled: folded.settled,
  }
}

async function prepareEngineFold($: EngineInterface, opts: Opts, rows: readonly SessionMessage[], meta: Meta, key: string): Promise<Pending | undefined> {
  const startedAt = await $.clock.now()
  let working = rows
  let folded: Fold | string
  try { folded = await fold($, opts, working, meta, false, undefined, true, undefined, key) }
  catch (err) { folded = `fold failed: ${String(err).slice(0, 160)}` }
  if (typeof folded === 'string') {
    const escaped = await withholdOldestResults($, working, opts)
    if (escaped) {
      working = escaped
      try { folded = await fold($, opts, working, meta, true, undefined, false, undefined, key) }
      catch (err) { folded = `escape retry failed: ${String(err).slice(0, 160)}` }
    }
  }
  if (typeof folded === 'string') {
    await logEvent($, 'escape', { reason: folded })
    $.ui.log(`clm: compaction job kept the transcript unchanged (${folded})`, { to: 'debug' })
    return undefined
  }
  await writeMeta($, meta)
  return pendingFromFold(folded, working, Math.max(0, (await $.clock.now()) - startedAt))
}

async function startFoldJob(
  $: EngineInterface, opts: Opts, rows: readonly SessionMessage[], meta: Meta, key: string, turnEnd: boolean,
): Promise<FoldJob> {
  const current = foldJobs.get(key)
  if (current && current.state !== 'idle') return current
  const first = protectedIndex(rows)
  const turns = queueTurns(rows, first)
  const work = turnEnd
    ? prepareBackgroundFold($, opts, rows, meta, first, turns, key)
    : prepareEngineFold($, opts, rows, meta, key)
  const job: Extract<FoldJob, { state: 'summarizing' }> = { state: 'summarizing', promise: work, fingerprints: rows.map(fingerprint), turnEnd }
  foldJobs.set(key, job)
  void job.promise.then(plan => {
    if (foldJobs.get(key) === job) {
      foldJobs.set(key, plan ? { state: 'ready', plan, fingerprints: job.fingerprints, turnEnd: job.turnEnd } : { state: 'idle' })
      void (async () => {
        const pending = await pendingKey($, key)
        if (plan) await $.store.set(pending, plan)
        else await $.store.delete(pending)
      })()
    }
  }, err => {
    if (foldJobs.get(key) === job) {
      foldJobs.delete(key)
      void pendingKey($, key).then(pending => $.store.delete(pending))
    }
    $.ui.log(`clm: background fold failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  })
  return job
}

function removedRows(previous: readonly string[], current: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const ref of current) counts.set(ref, (counts.get(ref) ?? 0) + 1)
  const removed: string[] = []
  for (const ref of previous) {
    const count = counts.get(ref) ?? 0
    if (count === 0) removed.push(ref)
    else counts.set(ref, count - 1)
  }
  return removed
}

function isLedgerSnapshot(value: unknown): value is LedgerSnapshot {
  return isRecord(value) && typeof value.seq === 'number' && Number.isInteger(value.seq)
    && typeof value.ledgerFp === 'string'
    && Array.isArray(value.coveredRows) && value.coveredRows.every(ref => typeof ref === 'string')
    && typeof value.ledger === 'string'
    && (value.topics === undefined || isTopicList(value.topics))
}

async function readLedgerSnapshots($: EngineInterface, key: string): Promise<LedgerSnapshot[]> {
  const stored = await $.store.get(ledgerSnapshotsKey(key))
  return Array.isArray(stored) ? stored.filter(isLedgerSnapshot).slice(-32) : []
}

async function saveLedgerSnapshot(
  $: EngineInterface, key: string, seq: number, ledgerFp: string, ledger: string, topics: Topic[] | undefined, coveredRows: readonly string[],
): Promise<void> {
  const history = await readLedgerSnapshots($, key)
  const instructions = await $.store.get(instructionIndexKey(key))
  const addresses = await $.store.get(issueAddressKey(key))
  const next: LedgerSnapshot = {
    seq, ledgerFp, ledger, coveredRows: [...new Set(coveredRows)],
    ...(topics ? { topics } : {}),
    ...(instructions === undefined ? {} : { instructions }),
    ...(addresses === undefined ? {} : { addresses }),
  }
  await $.store.set(ledgerSnapshotsKey(key), [...history, next].slice(-32))
}

async function restoreLedgerSnapshot($: EngineInterface, key: string, snapshot: LedgerSnapshot | undefined): Promise<void> {
  const path = await ledgerPath($)
  await $.fs.write(path, (snapshot?.ledger ?? EMPTY_LEDGER).trimEnd() + '\n')
  if (snapshot?.topics) await $.store.set(await topicsKey($, key), snapshot.topics)
  else await $.store.delete(await topicsKey($, key))
  if (snapshot?.instructions === undefined) await $.store.delete(instructionIndexKey(key))
  else await $.store.set(instructionIndexKey(key), snapshot.instructions)
  if (snapshot?.addresses === undefined) await $.store.delete(issueAddressKey(key))
  else await $.store.set(issueAddressKey(key), snapshot.addresses)
}

async function rewindOnlyPlan($: EngineInterface, rows: readonly SessionMessage[], meta: Meta, key: string, snapshot: LedgerSnapshot | undefined): Promise<Pending> {
  const first = protectedIndex(rows)
  const ledger = snapshot?.ledger ?? EMPTY_LEDGER
  const keptRow = rows[first + 1]
  return {
    notes: notesOf(ledger), fullNotes: notesOf(ledger), ops: [], seq: snapshot?.seq ?? 0,
    ...(keptRow ? { keepFp: fingerprint(keptRow) } : {}), keepFrom: first + 1, dropFps: [],
    cuts: {}, keptTurns: 0, fallback: false, rewindOnly: true,
    ...(snapshot?.topics ? { topics: snapshot.topics } : {}),
    coveredRows: snapshot?.coveredRows ?? [],
  }
}

async function observeTranscript($: EngineInterface, _opts: Opts, key: string, all: readonly SessionMessage[]): Promise<void> {
  const snapshotKey = transcriptRowsKey(key)
  const meta = await readMeta($)
  const rows = liveRows(all, meta.boundary)
  const current = rows.map(fingerprint)
  const stored = await $.store.get(snapshotKey)
  await $.store.set(snapshotKey, current)
  if (!Array.isArray(stored) || !stored.every(ref => typeof ref === 'string')) return
  const removed = removedRows(stored, current)
  if (!removed.length) return

  const removedSet = new Set(removed)
  const history = await readLedgerSnapshots($, key)
  const latest = history.at(-1)
  const ledgerWasRemoved = latest !== undefined && removedSet.has(latest.ledgerFp)
  const restored = ledgerWasRemoved ? history.at(-2) : undefined
  const existing = foldJobs.get(key)
  const invalidated = existing?.state === 'ready' && existing.plan.dropFps.some(ref => removedSet.has(ref))
  if (invalidated) {
    foldJobs.set(key, { state: 'idle' })
    await $.store.delete(await pendingKey($, key))
    $.ui.log('clm: rewound rows overlapped the pending summary; discarded its plan', { to: 'debug' })
  }
  if (!ledgerWasRemoved) return

  if (restored) {
    const restoredIndex = history.indexOf(restored)
    await $.store.set(ledgerSnapshotsKey(key), history.slice(0, restoredIndex + 1))
  } else {
    await $.store.delete(ledgerSnapshotsKey(key))
  }
  await restoreLedgerSnapshot($, key, restored)
  const plan = await rewindOnlyPlan($, rows, meta, key, restored)
  foldJobs.set(key, { state: 'ready', plan, fingerprints: current, turnEnd: false })
  await $.store.set(await pendingKey($, key), plan)
  await writeMeta($, { ...meta, seq: plan.seq })
  await logEvent($, 'rewind', { reason: `restored ledger snapshot ${plan.seq} after ${removed.length} row(s) left the active transcript` })
  $.ui.log(`clm: restored ledger snapshot ${plan.seq} after rewind (${removed.length} row(s))`, { to: 'debug' })
}

async function applyReadyIfAtThreshold($: EngineInterface, opts: Opts, key: string): Promise<boolean> {
  const job = foldJobs.get(key)
  if (job?.state !== 'ready') return false
  if (!job.plan.rewindOnly && (await usageReading($) ?? 0) < opts.budget - opts.reserve) return false
  try {
    await $.session.compact({})
  } catch (err) {
    $.ui.log(`clm: ready fold swap deferred (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
  return true
}

async function maybeClear($: EngineInterface, opts: Opts): Promise<void> {
  const session = await sid($)
  const key = transcriptKey(session)
  const current = foldJobs.get(key)
  if (current?.state === 'ready') {
    await applyReadyIfAtThreshold($, opts, key)
    return
  }
  if (current && current.state !== 'idle') return
  const meta = await readMeta($)
  const rows = liveRows(await $.session.messages(), meta.boundary)
  const first = protectedIndex(rows)
  const queue = rows.slice(first + 1)
  if (sum(queue) < opts.queueTarget) return
  const turns = queueTurns(rows, first)
  if (turns.length < 2) return
  void startFoldJob($, opts, rows, meta, key, true).catch(err => $.ui.log(`clm: background fold failed (${String(err).slice(0, 160)})`, { to: 'debug' }))
}

async function applyFoldPlan(
  $: EngineInterface, all: readonly SessionMessage[], workingRows: readonly SessionMessage[], meta: Meta,
  first: number, use: Pending, escaped: boolean, startedAt: number, key: string,
): Promise<SessionCompactResult> {
  const here = await captureOrigin($)
  const appended = await append($, [...use.ops, ...(use.promoted ?? [])], here, false, true)
  await updateHeld($, use.settled ?? [], use.hold ?? [])
  await ensureInstructionIndex($, key, use.fullNotes)
  const stateEvents = await readAll($)
  const currentView = await trackerView($, here)
  const liveIssues = snapshot(stateEvents).filter(issue => issue.origin.session === here.session)
  const liveFocus = focusOf(stateEvents, here.session)
  const ledger = await residentLedger($, key, liveIssues, liveFocus, stateEvents, {
    notes: use.fullNotes, topics: use.topics, issues: liveIssues, state: liveFocus,
  })
  const fileLedger = composeLedger(use.fullNotes, currentView.issues)
  const text = ledgerRowText(use.seq, kst(), await ledgerPath($), ledger)
  const ledgerRow: SessionMessage = { role: 'user', text, toolUses: [] }
  const messages = buildCleared({ head: workingRows.slice(0, first + 1), tail: workingRows.slice(use.keepFrom), cuts: use.cuts }, ledgerRow)
  const tokensBefore = sum(workingRows)
  const tokensAfter = sum(messages)
  await $.fs.write(await ledgerPath($), fileLedger + '\n')
  if (use.topics) await $.store.set(await topicsKey($, key), use.topics)
  else await $.store.delete(await topicsKey($, key))
  const previousSnapshot = (await readLedgerSnapshots($, key)).at(-1)
  await saveLedgerSnapshot($, key, use.seq, fingerprint(ledgerRow), fileLedger, use.topics, [
    ...(use.coveredRows ?? previousSnapshot?.coveredRows ?? []), ...use.dropFps,
  ])
  await $.store.set(transcriptRowsKey(key), messages.map(fingerprint))
  await pruneWithheld($, escaped ? workingRows : messages, fileLedger)
  const offset = messages.findIndex(m => m.text === text)
  const foldedAt = await $.clock.now()
  const swapMs = Math.max(0, foldedAt - startedAt)
  await writeMeta($, {
    ...meta, seq: use.seq, lastClear: kst(), lastFoldAt: foldedAt,
    foldDurationsMs: { ...meta.foldDurationsMs, [String(use.seq)]: swapMs },
    foldTokens: await usageReading($), lastSkip: undefined, boundary: { fp: fingerprint(ledgerRow), offset },
  })
  await logEvent($, 'clear', {
    tokensBefore, tokensAfter, keptTurns: use.keptTurns, ratio: meta.ratio ?? 1,
    durationMs: swapMs, ...(use.summaryMs === undefined ? {} : { summaryMs: use.summaryMs }),
    reason: `${escaped ? 'escape' : 'clm'}${use.fallback ? ', fallback ledger' : ''}`,
  })
  await projectPanel($, here, appended)
  return { messages, tokensBefore, tokensAfter }
}

async function applyRewindPlan(
  $: EngineInterface, all: readonly SessionMessage[], rows: readonly SessionMessage[], meta: Meta,
  first: number, use: Pending, key: string,
): Promise<SessionCompactResult> {
  const here = await captureOrigin($)
  const stateEvents = await readAll($)
  const view = await trackerView($, here)
  const liveIssues = snapshot(stateEvents).filter(issue => issue.origin.session === here.session)
  const liveFocus = focusOf(stateEvents, here.session)
  const ledger = await residentLedger($, key, liveIssues, liveFocus, stateEvents, {
    notes: use.fullNotes, topics: use.topics, issues: liveIssues, state: liveFocus,
  })
  const fullLedger = composeLedger(use.fullNotes, view.issues)
  const text = ledgerRowText(use.seq, kst(), await ledgerPath($), ledger)
  const row: SessionMessage = { role: 'user', text, toolUses: [] }
  const plan: ClearPlan = {
    head: rows.slice(0, first + 1).filter(message => !isLedgerRow(message)),
    dropped: [],
    tail: rows.slice(first + 1).filter(message => !isLedgerRow(message)),
    keptTurns: 0,
    cuts: {},
  }
  const messages = buildCleared(plan, row)
  await $.fs.write(await ledgerPath($), fullLedger + '\n')
  if (use.topics) await $.store.set(await topicsKey($, key), use.topics)
  await saveLedgerSnapshot($, key, use.seq, fingerprint(row), fullLedger, use.topics, use.coveredRows ?? [])
  const offset = messages.findIndex(message => message.text === text)
  await writeMeta($, { ...meta, seq: use.seq, lastClear: kst(), boundary: { fp: fingerprint(row), offset } })
  await $.store.set(transcriptRowsKey(key), messages.map(fingerprint))
  return { messages, tokensBefore: sum(rows), tokensAfter: sum(messages) }
}

async function showTurnChanges($: EngineInterface, e: { answer: string }) {
  if (!e.answer.trim()) return
  const session = await sid($)
  const meta = await readMeta($)
  const rows = liveRows(await $.session.messages(), meta.boundary)
  const hasToolUse = rows.slice(-8).some(m => m.toolUses.length > 0 || (m.toolResults?.length ?? 0) > 0)
  if (!hasToolUse && e.answer.trim().length < 200) return
  try {
    const stored = notesOf((await readText($, await ledgerPath($))) ?? EMPTY_LEDGER)
    const ledger = `${mergeableNotes(stored)}\n\n## 핵심 사실·경로\n${factLines(stored).map(l => `- ${l}`).join('\n') || '- (none yet)'}`
    // clm-prompt
    const prompt = `<ledger_goal_and_key_facts>\n${ledger}\n</ledger_goal_and_key_facts>\n<finished_turn>\n${renderTurns(rows.slice(-8), 20000)}\n</finished_turn>`
    const r = await $.model.complete({ model: 'haiku', system: TURN_CHANGE_SYSTEM, prompt, maxTokens: 300, timeoutMs: 15000 })
    if (!r.isAnswered) return
    const seen = shownChanges.get(session) ?? new Set<string>()
    shownChanges.set(session, seen)
    for (const line of parseChanges(r.text)) {
      const key = changeHash(line)
      if (seen.has(key)) continue
      seen.add(key)
      $.ui.log('맥락 갱신: ' + line)
    }
  } catch (err) {
    $.ui.log(`clm: turn context refresh failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}

// The engine summarizer, not clm, folds the rows on the escape path, so their
// prompts would reach the next clm fold only as the summary's paraphrase.
/** Records every user prompt in `rows` under 사용자 지시 in the ledger file, which the next fold reads as its prior instructions. */
async function keepEscapedInstructions($: EngineInterface, rows: readonly SessionMessage[]): Promise<void> {
  try {
    const path = await ledgerPath($)
    const notes = notesOf((await readText($, path)) ?? EMPTY_LEDGER)
    const preserved = preserveInstructions(notes, instructionValues(notes), rows.slice(protectedIndex(rows)), path)
    const view = await trackerView($, await captureOrigin($))
    await $.fs.write(path, composeLedger(preserved.fullNotes, view.issues) + '\n')
  } catch (err) {
    await logEvent($, 'escape-instructions-lost', { reason: String(err).slice(0, 160) })
  }
}

const WITHHELD = '.withheld-'

// The files stay while a row or the ledger file points at them, so a resumed
// session can still read them; once neither does, nothing can reach them.
/** Removes this session's withheld-result files that neither a row in `live` nor `ledger` names. */
async function pruneWithheld($: EngineInterface, live: readonly SessionMessage[], ledger = ''): Promise<void> {
  try {
    const base = await basePath($)
    const dir = base.slice(0, base.lastIndexOf('/'))
    const prefix = base.slice(dir.length + 1) + WITHHELD
    if (!(await $.fs.exists(dir))) return
    const pointed = [ledger, ...live.flatMap(m => (m.toolResults ?? []).map(r => r.text))].join('\n')
    const stale = (await $.fs.list(dir))
      .filter(f => f.kind === 'file' && f.name.startsWith(prefix) && !pointed.includes(`${dir}/${f.name}`))
      .map(f => `${dir}/${f.name}`)
    if (stale.length === 0) return
    const r = await $.process.run(['rm', '-f', '--', ...stale], { timeoutMs: 5000 })
    if (r.exitCode !== 0) $.ui.log(`clm escape: could not remove ${stale.length} withheld file(s) (exit ${r.exitCode}: ${r.stderr.slice(0, 160)})`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`clm escape: withheld-file cleanup failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}

// After a failed fold, the oldest tool results move to files, one at a time,
// until the rows fit the budget; each row keeps a pointer to its file. A
// changed row is rebuilt without its handle, which would map it back to the
// engine's original message.
async function withholdOldestResults($: EngineInterface, rows: readonly SessionMessage[], opts: Opts): Promise<readonly SessionMessage[] | undefined> {
  if (!rows.some(m => m.toolResults?.length)) return undefined
  await pruneWithheld($, rows, (await readText($, await ledgerPath($))) ?? '')
  const current = [...rows]
  const limit = opts.budget - opts.reserve
  const base = await basePath($)
  let n = 0
  for (const [rowIndex, row] of rows.entries()) {
    let updated = row
    for (const result of row.toolResults ?? []) {
      const index = n++
      if (result.text.startsWith('[clm escape:')) continue
      const path = `${base}${WITHHELD}${index}-${result.tool_use_id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.txt`
      try {
        await $.fs.write(path, result.text)
      } catch (err) {
        $.ui.log('clm escape: could not preserve tool result at ' + path + ' (' + String(err).slice(0, 160) + ')', { to: 'debug' })
        continue
      }
      updated = {
        role: updated.role, text: updated.text, toolUses: updated.toolUses,
        toolResults: (updated.toolResults ?? []).map(r => (r.tool_use_id === result.tool_use_id ? { ...r, text: withheldPointer(path) } : r)),
      }
      current[rowIndex] = updated
      if (sum(current) <= limit) return current
    }
  }
  return current
}

export function report(ledger: string | undefined, rows: readonly SessionMessage[], opts: Opts, meta: Meta, logTail: readonly string[]): string {
  const used = Math.round(visibleTokens(rows) * (meta.ratio ?? 1))
  return [
    `clm budget: ${used}/${opts.budget} tokens (${Math.round((used / opts.budget) * 100)}%); escape at ${opts.budget - opts.reserve}, queue target ${opts.queueTarget}, tail target ${opts.tailTarget}, ledger target ${opts.ledgerTarget}, ratio ${meta.ratio ?? 1}`,
    `rows: ${rows.filter(m => !isSystemRow(m)).length} kept, ${rows.filter(isSystemRow).length} hidden system rows`,
    `last fold: ${meta.lastClear ?? 'never'} (ledger #${meta.seq})${meta.lastSkip ? `; last skip: ${meta.lastSkip}` : ''}`,
    '',
    ledger ?? '(no ledger yet)',
    '',
    'recent decisions:',
    ...(logTail.length ? logTail : ['(none)']),
  ].join('\n')
}

async function claimContinuation($: EngineInterface, turnId: string): Promise<Continuation | undefined> {
  return changeWorkflow($, current => {
    const selected = chooseContinuation(current, turnId)
    return { next: selected.workflow, result: selected.continuation }
  })
}

async function stampHumanPrompt($: EngineInterface): Promise<number> {
  return changeWorkflow($, current => {
    const promptSeq = Math.max(current.promptSeq, current.focusAppliedSeq) + 1
    return { next: { ...current, promptSeq }, result: promptSeq }
  })
}

async function reconcileReplay($: EngineInterface): Promise<void> {
  const origin = await captureOrigin($)
  await serialized(origin.session, async () => {
    const workflow = await readWorkflow($)
    const replayed = workflow.replayed
    if (!replayed) return
    const events = await readAll($)
    const allIssues = snapshot(events)
    const issue = allIssues.find(item => item.id === replayed.issue && item.origin.session === origin.session)
    const state = focusOf(events, origin.session)
    if (issue && isOpen(issue) && state.stack.at(-1) !== issue.id) {
      const currentIssues = allIssues.filter(item => item.origin.session === origin.session)
      const lastSeq = events.filter(event => event.origin.session === origin.session).reduce((n, event) => Math.max(n, event.seq), 0)
      const intent = { intent: 'handoff' as const, target: issue.id, title: null, rule: null, later: [], laterDrop: [] }
      const { payloads, next } = compose(state, intent, currentIssues, () => issueId(origin.session, lastSeq + 1))
      const written = await writeEvents($, [
        ...payloads,
        { op: 'focus', stack: next.stack, pending: next.pending, intent: 'handoff' },
      ], origin)
      for (const line of describe(written, allIssues)) $.ui.log(line)
      if (payloads.length) await syncPanelSafely($, origin, written)
    }
    await changeWorkflow($, current => current.replayed?.issue === replayed.issue
      ? { next: { ...current, replayed: null }, result: undefined }
      : { next: current, result: undefined })
  })
}

async function restoreContinuation($: EngineInterface, turnId: string, continuation: Continuation): Promise<void> {
  await changeWorkflow($, current => ({ next: restoreFailedContinuation(current, turnId, continuation), result: undefined }))
}

export async function submitWithRecovery(
  submit: () => Promise<void>,
  restore: () => Promise<void>,
  log: (message: string) => void,
): Promise<boolean> {
  try {
    await submit()
    return true
  } catch (err) {
    try {
      await restore()
    } catch (restoreError) {
      log(`clm: continuation restore failed (${String(restoreError).slice(0, 160)})`)
    }
    log(`clm: continuation submit failed (${String(err).slice(0, 160)})`)
    return false
  }
}

async function submitContinuation($: EngineInterface, turnId: string, continuation: Continuation): Promise<boolean> {
  return submitWithRecovery(
    async () => {
      const submitted = await $.prompt.submit({ text: continuation.text, ...(continuation.asUser ? { asUser: true } : {}) })
      if (submitted.drop !== undefined) throw new Error(submitted.drop)
    },
    () => restoreContinuation($, turnId, continuation),
    message => $.ui.log(message),
  )
}

async function arbitrateContinuation($: EngineInterface, turnId: string): Promise<'submitted' | 'queued'> {
  const continuation = await claimContinuation($, turnId)
  if (!continuation) return 'queued'
  if ((await readWorkflow($)).activeTurnId !== null) {
    void submitContinuation($, turnId, continuation)
    return 'queued'
  }
  const submitted = await submitContinuation($, turnId, continuation)
  return submitted && continuation.source === 'resume' ? 'submitted' : 'queued'
}

// clm-prompt
const GUIDE = [
  'Memory ledger (clm): when this conversation outgrows its budget, the harness folds the older turns into one row that starts with "[clm ledger".',
  'That row is a Haiku summary: the goal, the user\'s instructions verbatim, what was done, what is left, open questions and key facts, each completed task and key fact citing a quote from the user or a tool result. The turns it replaced are gone.',
  'Use it as your memory of that work, and re-query any PR, branch, deploy or ticket state before acting on it or reporting it.',
  'Describe task changes in the conversation; clm records them in the tracker and task panel.',
].join('\n')

export const register: Register = (on, options) => {
  const { opts, problems } = readOpts(options as Record<string, unknown>)

  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return {
      ...built,
      clm: {
        track: () => { throw new Error('clm.track is handled by the clm plugin') },
        issues: () => { throw new Error('clm.issues is handled by the clm plugin') },
        resume: () => { throw new Error('clm.resume is handled by the clm plugin') },
        status: () => { throw new Error('clm.status is handled by the clm plugin') },
      },
    }
  })

  on('clm.track', async ($, e) => ({ value: await trackIssue($, e) }))
  on('clm.issues', async ($, e) => ({ value: await sessionIssues($, e ?? {}) }))
  on('clm.status', async $ => ({ value: await clmStatus($) }))
  on('clm.resume', async ($, e) => {
    const text = e.text.trim()
    if (!text) throw new Error('clm.resume text must not be empty')
    const activeTurn = (await readWorkflow($)).activeTurnId
    await changeWorkflow($, current => ({ next: { ...current, resumeRequest: { text } }, result: undefined }))
    if (activeTurn === null) {
      const requestTurn = `resume:${await $.clock.now()}:${Math.random().toString(36).slice(2, 10)}`
      return { value: await arbitrateContinuation($, requestTurn) }
    }
    return { value: 'queued' as const }
  })

  on('session.start', async ($, e, next) => {
    for (const p of problems) $.ui.log(`clm: option ${p}`)
    try {
      await $.tool.register({
        name: 'clm_recall',
        description: 'Read original transcript rows by address @xxxxxxxx or an ancestor range @first..@last. Includes rows folded from the live context and rows on rewound branches.',
        inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'], additionalProperties: false },
      })
    } catch (err) {
      $.ui.log(`clm: clm_recall registration failed (${String(err).slice(0, 120)})`, { to: 'debug' })
    }
    try {
      await $.tool.register({
        name: 'clm_task',
        description: 'Update a task you are working on: mark it doing when you start, done when a tool result shows it finished (cite that row and a verbatim quote), uncertain when you cannot verify it, dropped when the user abandons it. Create a child task for a sub-step you will do yourself.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string', enum: ['doing', 'done', 'uncertain', 'dropped'] },
            note: { type: 'string' }, evidence: { type: 'object', properties: { ref: { type: 'string' }, quote: { type: 'string' } }, required: ['ref', 'quote'], additionalProperties: false },
          },
          required: ['status'], additionalProperties: false,
        },
      })
    } catch (err) {
      $.ui.log(`clm: clm_task registration failed (${String(err).slice(0, 120)})`, { to: 'debug' })
    }
    await $.command.register({
      name: 'clm',
      description: 'Show the clm ledger, budget use and recent decisions; `board` opens the issue board in the browser, `link <id>` brings another repo\'s issue into this session, `drop <id…|all>` drops open issues of this session (shown to you only).',
      immediate: true,
    })
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    if (e.transcript_path) await rememberTranscriptPath($, e.session_id ?? await sid($), e.transcript_path)
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.transcript_path) await rememberTranscriptPath($, e.session_id ?? await sid($), e.transcript_path)
    return next(e)
  })

  // Printed through ui.log, which the engine draws as a notice and never sends
  // to the model; a command's `text` is a transcript row and may be.
  on('command.run', { command: 'clm' }, async ($, e) => {
    // `$.command.run` documents a left-out args as "", yet the test kit hands it over undefined.
    const [sub, ...args] = (e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const arg = args[0]
    if (sub === 'board') {
      await openBoard($)
      return {}
    }
    if (sub === 'link') {
      const issue = arg ? snapshot(await readAll($)).find(i => i.id === arg) : undefined
      if (!issue) {
        $.ui.log(arg ? `clm: no issue ${arg}; /clm board lists them` : 'clm: usage /clm link <issue id>')
        return {}
      }
      await append($, [{ op: 'link', issue: issue.id }])
      $.ui.log(`clm: ${issue.id} "${issue.title}" (${issue.origin.repo}) is linked to this session and shows in its ledger from the next fold`)
      return {}
    }
    if (sub === 'drop') {
      const open = (await sessionIssues($)).filter(isOpen)
      const named = args.includes('all') ? open : open.filter(i => args.includes(i.id))
      const unknown = args.filter(a => a !== 'all' && !open.some(i => i.id === a))
      if (!args.length) $.ui.log('clm: usage /clm drop <issue id…|all>')
      if (unknown.length) $.ui.log(`clm: no open issue ${unknown.join(', ')} in this session; /clm lists them`)
      await append($, named.map(i => ({ op: 'status' as const, issue: i.id, status: 'dropped' as const })))
      if (args.length && !named.length && !unknown.length) $.ui.log('clm: no open issue to drop')
      return {}
    }
    if (sub) {
      $.ui.log('clm: usage /clm, /clm board, /clm link <issue id>, /clm drop <issue id…|all>')
      return {}
    }
    const meta = await readMeta($)
    const rows = liveRows(await $.session.messages(), meta.boundary)
    const log = ((await readText($, await logPath($))) ?? '').split('\n').filter(Boolean).slice(-5)
    $.ui.log(report(await readText($, await ledgerPath($)), rows, opts, meta, log))
    return {}
  })

  on('turn.start', async ($, e, next) => {
    try {
      await changeWorkflow($, current => ({ next: { ...current, activeTurnId: e.turnId }, result: undefined }))
    } catch (err) {
      $.ui.log(`clm: active turn state failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      try {
        await changeWorkflow($, current => ({ next: { ...current, activeTurnId: e.turnId }, result: undefined }))
      } catch (err) {
        $.ui.log(`clm: active turn state failed (${String(err).slice(0, 160)})`, { to: 'debug' })
      }
    }
    const res = await next(e)
    if (e.agentId !== undefined) return res
    try {
      void showTurnChanges($, e).catch(err => $.ui.log(`clm: turn context refresh failed (${String(err).slice(0, 160)})`, { to: 'debug' }))
      await reconcileReplay($)
      await maybeClear($, opts)
    } catch (err) {
      $.ui.log(`clm: fold failed, ${String(err).slice(0, 200)}`, { to: 'debug' })
    }
    if (!e.isAborted) {
      try {
        await arbitrateContinuation($, e.turnId)
      } catch (err) {
        $.ui.log(`clm: continuation arbitration failed (${String(err).slice(0, 160)})`, { to: 'debug' })
      }
    }
    try {
      await changeWorkflow($, current => ({
        next: current.activeTurnId === e.turnId ? { ...current, activeTurnId: null } : current,
        result: undefined,
      }))
    } catch (err) {
      $.ui.log(`clm: active turn clear failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
    return res
  })

  // The engine and the turn-end check share one per-transcript job.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.trigger === 'precompute') return { skip: 'clm replaces compaction' }
    if (!Array.isArray(e.messages)) return { skip: 'clm: the compaction carried no transcript' }
    const compactStartedAt = await $.clock.now()
    const all = e.messages
    const meta = await readMeta($)
    const workingRows = liveRows(all, meta.boundary)
    const first = protectedIndex(workingRows)
    const key = transcriptKey(await sid($), e.agentId)
    await observeTranscript($, opts, key, all)
    const existing = foldJobs.get(key)
    if (existing?.state === 'summarizing') await existing.promise
    if (e.trigger === 'plugin' && (!existing || existing.state === 'idle')) return { messages: all }
    let job = existing
    if (!job || job.state === 'idle') job = await startFoldJob($, opts, workingRows, meta, key, false)
    if (job.state === 'swapping') return job.promise
    const plan = job.state === 'summarizing' ? await job.promise : job.state === 'ready' ? job.plan : undefined
    if (!plan) {
      foldJobs.set(key, { state: 'idle' })
      await $.store.delete(await pendingKey($, key))
      return { messages: all }
    }
    if (!plan.rewindOnly && (await usageReading($) ?? 0) < opts.budget - opts.reserve) return { messages: all }
    const keepFrom = plan.keepFrom
    const row = keepFrom < workingRows.length ? workingRows[keepFrom] : undefined
    const expectedDropped = workingRows.slice(first + 1, keepFrom).filter(m => !isLedgerRow(m) && !isSystemRow(m)).map(fingerprint)
    const sameDropped = expectedDropped.length === plan.dropFps.length && expectedDropped.every((fp, i) => fp === plan.dropFps[i])
    const sameKept = plan.keepFp === undefined ? keepFrom === workingRows.length : row !== undefined && fingerprint(row) === plan.keepFp
    if (keepFrom < first + 1 || keepFrom > workingRows.length || !sameKept || !sameDropped) {
      $.ui.log('clm: compaction job input changed before swap; transcript left untouched', { to: 'debug' })
      foldJobs.set(key, { state: 'idle' })
      await $.store.delete(await pendingKey($, key))
      return { messages: all }
    }
    const use = { ...plan, keepFrom }
    const swap = (async (): Promise<SessionCompactResult> => {
      try {
        return use.rewindOnly
          ? await applyRewindPlan($, all, workingRows, meta, first, use, key)
          : await applyFoldPlan($, all, workingRows, meta, first, use, false, compactStartedAt, key)
      }
      finally {
        foldJobs.set(key, { state: 'idle' })
        await $.store.delete(await pendingKey($, key))
      }
    })()
    foldJobs.set(key, { state: 'swapping', promise: swap })
    return swap
  })

  on('tool.call', { tool: RECALL_TOOL }, async ($, e) => {
    if (typeof e.address !== 'string') return { deny: 'clm_recall requires an address such as @c130a62d or @first..@last.' }
    const session = await sid($)
    const storedPath = await $.store.get(transcriptPathKey(session))
    const path = transcriptPaths.get(session) ?? (typeof storedPath === 'string' ? storedPath : undefined)
    if (!path) return { result: 'The transcript path is unavailable for this session.', isError: true, isReadOnly: true }
    try {
      const source = await readText($, path)
      if (source === undefined) return { result: 'The transcript file is unavailable.', isError: true, isReadOnly: true }
      const recalled = recallTranscriptAddress(source, e.address)
      if (recalled.error) return { result: recalled.error, isError: true, isReadOnly: true }
      return { result: recalled.text ?? '', isReadOnly: true }
    } catch (err) {
      $.ui.log(`clm_recall: transcript read failed (${String(err).slice(0, 120)})`, { to: 'debug' })
      return { result: 'The transcript could not be read.', isError: true, isReadOnly: true }
    }
  })
  on('agent.spawn', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const origin = await captureOrigin($)
    const parent = focusOf(await readAll($), origin.session).stack.at(-1)
    const spawned = await next(e)
    if (!spawned.agentId || !parent) return spawned
    const roots = await assignedTaskRoots($, origin.session)
    roots[spawned.agentId] = parent
    await $.store.set(agentTaskRootsKey(origin.session), roots)
    return spawned
  })
  on('tool.call', { tool: TASK_TOOL }, async ($, e) => {
    if (!isClmTaskInput(e)) return { deny: 'clm_task requires status and either an issue id or a new task title.' }
    return runClmTask($, e, e.agentId)
  })
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => (e.agentId !== undefined || next.origin.plugin === 'clm' ? next(e) : denyModelTask($, e)))
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => (e.agentId !== undefined || next.origin.plugin === 'clm' ? next(e) : denyModelTask($, e)))
  on('tool.describe', { tool: 'TaskCreate' }, ($, e) => ({ ...e, isDeferred: true }))
  on('tool.describe', { tool: 'TaskUpdate' }, ($, e) => ({ ...e, isDeferred: true }))
  on('prompt.attachment', { type: 'todo_reminder' }, () => ({ text: null }))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const seq = ledgerRowSeq(e.props.text)
    if (e.props.isExpanded || e.props.from !== undefined || e.props.task !== undefined || seq === undefined) return next(e)
    const durationMs = (await readMeta($)).foldDurationsMs?.[seq]
    const text = durationMs === undefined ? '* clm compacted' : `* clm compacted in ${(durationMs / 1000).toFixed(1)} s`
    const { Text } = $.ui.resolve(e)
    return Text({ children: [text] })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const base = await next(e).catch(err => {
      if (!String(err).includes('no implementation for ui.render')) throw err
      return null
    })
    try {
      const later = (await readWorkflow($)).later
      if (!later.length || e.props.hasSurvey) {
        if (base) return base
        throw new Error('no implementation for ui.render')
      }
      const { Box, Text } = $.ui.resolve(e)
      const queue = Text({ dimColor: true, children: `Later queue:\n${later.map((item, i) => `${i + 1}. ${item.text}`).join('\n')}` })
      return Box({ gap: 1, children: base === null ? [queue] : [base, queue] })
    } catch (err) {
      if (String(err).includes('no implementation for ui.render')) throw err
      $.ui.log(`clm: later band failed (${String(err).slice(0, 160)})`, { to: 'debug' })
      if (base) return base
      throw err
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.includes('bare')) return r
    return { ...r, sections: [...r.sections, { id: 'clm:guide', text: GUIDE, scope: 'session' as const }] }
  })

  on('prompt.submit', async ($, e, next) => {
    let promptSeq: number | undefined
    if (isHumanOrigin(e.origin)) {
      try {
        const key = transcriptKey(await sid($))
        await observeTranscript($, opts, key, await $.session.messages())
        await changeWorkflow($, current => ({ next: resetUserWorkflow(current, e.origin), result: undefined }))
        promptSeq = await stampHumanPrompt($)
        await reconcileReplay($)
      } catch (err) {
        $.ui.log(`clm: prompt state update failed (${String(err).slice(0, 160)})`, { to: 'debug' })
      }
    }
    const submitted = await next(e)
    if (promptSeq !== undefined) void recordPromptIntent($, e.text, promptSeq)
    return submitted
  })
}
