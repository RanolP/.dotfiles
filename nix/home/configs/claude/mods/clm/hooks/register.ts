import { update, type EngineInterface, type Register, type SessionMessage } from 'claude-code'
import { append as appendEvents, captureOrigin as captureEventsOrigin, logEvent as writeLogEvent, readAll as readAllEvents, serialized as serializeEvents, writeEvents as writeTrackerEvents, type EventsIo, type LogEvent, type LogFields } from './events'
import { assignedTaskRoots, createAgentTaskRoot, removeAgentTaskRoot, clmStatus as panelStatus, denyModelTask as denyPanelTask, isClmTaskInput, mirrorModelTask, openBoard as openPanelBoard, runClmTask as runPanelTask, runPanelCommand, sessionIssues as panelIssues, syncPanelSafely as syncPanelDomain, trackIssue as trackPanelIssue, TASK_TOOL, type PanelIo } from './panel'
import { droppedIds, gateMerge as gateHeldMerge, heldClaims, isHeld, readHeld as readHeldStore, reviewFold as reviewHeldFold, updateHeld as updateHeldStore, type Held, type HeldIo } from './held'

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
  archivedDone, injected, normalizeRemote, parseLog, parseOps, toEvents,
  focusOf, type Issue, type Origin, type Payload, type TrackerEvent,
} from './tracker'
import { compose, recordPromptIntent as classifyPrompt, isRequestRecord, xmlText, type RequestRecord, type PromptIntentIo } from './intent'
import { arbitrateContinuation as arbitrateWorkflow, changeWorkflow as changeWorkflowDomain, completeMainTurn, isHumanOrigin, markActiveTurn, queueResume, readWorkflow as readWorkflowDomain, reconcileReplay as reconcileWorkflowReplay, removeQueueSnapshotTargets, resetUserWorkflow, stampHumanPrompt as stampWorkflowPrompt, submitWithRecovery as recoverWorkflowSubmit, type MainTurnCompletionIo, type ReplayIo, type WorkflowIo, type WorkflowStateIo } from './workflow'
import type { ClmStatus, ClmTaskInput, ClmWorkflow } from '../types'
import { recallAddress, recallIo as makeRecallIo, rememberTranscriptPath as rememberAddressTranscriptPath, transcriptRows as readAddressRows, type AddressRuntimeIo } from './address'
import { ensureInstructionIndex as ensureResidentInstructionIndex, residentLedger as renderResidentLedger, type InstructionIndex, type ResidentIo } from './resident'
import { observeTranscript, type RewindIo } from './rewind'
import { fold as runFold, parseSplitAnswer, storedTopics as storedTopicsDomain, trackerView as trackerViewDomain, type FoldRuntimeIo, type Meta, type Opts, type PreparedFold, type TopicState, type TrackerView } from './fold-runtime'
import { clearFoldJob, foldJobDropFps, handleSessionCompact as compactFoldJob, maybeClear as maybeClearFoldJob, report as foldJobReport, setRewindFoldJob, showTurnChanges as showFoldTurnChanges, transcriptKey, type FoldJobIo } from './fold-job'

export { recallTranscriptAddress } from './address'
export { residentLedgerText } from './resident'
export { chooseContinuation, removeQueueSnapshotTargets, resetUserWorkflow, restoreFailedContinuation } from './workflow'
export { messageTokens, type Meta, type Opts }

// Each transcript has one background compaction job; engine compactions join
// it and apply its ready plan. The tracker renders task state, so merge ops
// update persistent issues; withholding is used inside the job if summary fails.

const WORKFLOW = { plugin: 'clm', key: 'workflow' } as const
const RECALL_TOOL = 'mcp__clm__clm_recall'
export { TASK_TOOL }

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

const workflowStateIo = ($: EngineInterface): WorkflowStateIo => ({
  get: async () => (await $.state.get(WORKFLOW)).value,
  update: change => update($, WORKFLOW, change),
})
const readWorkflow = ($: WorkflowReader): Promise<ClmWorkflow> => readWorkflowDomain({ get: async () => (await $.state.get(WORKFLOW)).value })
const changeWorkflow = <T>($: EngineInterface, change: (current: ClmWorkflow) => { next: ClmWorkflow; result: T }): Promise<T> =>
  changeWorkflowDomain(workflowStateIo($), change)

// --- options -------------------------------------------------------------

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

// Pending fold ops land only when session.compact applies the plan, so abandoned
// plans cannot leave duplicate issues. `foldTokens` tracks the pre-fold usage
// reading until the next API response, so equal readings are ignored.
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
const transcriptRowsKey = (key: string) => `transcript-rows:${key}`
const instructionIndexKey = (key: string) => `instruction-index:${key}`
const issueAddressKey = (key: string) => `issue-addresses:${key}`
const requestsKey = (key: string) => `requests:${key}`
const requestPromptSeqKey = (key: string) => `request-prompt-seq:${key}`
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isNumberRecord = (v: unknown): v is Record<string, number> => isRecord(v) && Object.values(v).every(n => typeof n === 'number')
const optional = (v: unknown, type: 'number' | 'string') => v === undefined || typeof v === type
const isMeta = (v: unknown): v is Partial<Meta> =>
  isRecord(v) && optional(v.seq, 'number') && optional(v.fails, 'number') && optional(v.ratio, 'number') && optional(v.overhead, 'number')
  && optional(v.foldTokens, 'number') && optional(v.lastFoldAt, 'number') && (v.foldDurationsMs === undefined || isNumberRecord(v.foldDurationsMs)) && optional(v.lastClear, 'string') && (v.boundary === undefined || isRecord(v.boundary))
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

const eventsIo = ($: EngineInterface): EventsIo => ({
  sessionId: () => $.session.id(),
  cwd: () => $.session.cwd(),
  home: () => $.env.get('HOME'),
  run: (args, options) => $.process.run(args, options),
  exists: path => $.fs.exists(path),
  list: path => $.fs.list(path),
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
  log: (text, options) => $.ui.log(text, options),
  trackerDirectory: async () => `${(await $.env.get('HOME')) ?? '.'}/.claude-work/tracker/events`,
  trackerLogPath: async session => `${(await $.env.get('HOME')) ?? '.'}/.claude-work/tracker/events/${session}.jsonl`,
  generalLogPath: () => logPath($),
  project: (origin, events) => syncPanelDomain(panelIo($), origin, events),
})
const captureOrigin = ($: EngineInterface) => captureEventsOrigin(eventsIo($))
const readAll = ($: EngineInterface) => readAllEvents(eventsIo($))
const serialized = <T>(session: string, run: () => Promise<T>) => serializeEvents(session, run)
const writeEvents = ($: EngineInterface, payloads: readonly Payload[], origin: Origin) => writeTrackerEvents(eventsIo($), payloads, origin)
const append = ($: EngineInterface, payloads: readonly Payload[], origin?: Origin, project = true, knownTitles = false) => appendEvents(eventsIo($), payloads, origin, project, knownTitles)
const logEvent = ($: EngineInterface, event: LogEvent, fields: LogFields) => writeLogEvent(eventsIo($), event, fields)

const panelIo = ($: EngineInterface): PanelIo => ({
  captureOrigin: () => captureOrigin($),
  readAll: () => readAll($),
  append: (payloads, origin, project, knownTitles) => append($, payloads, origin, project, knownTitles),
  writeEvents: (payloads, origin) => writeEvents($, payloads, origin),
  logEvent: (event, fields) => logEvent($, event, fields),
  serialize: (session, run) => serialized(session, run),
  sessionId: () => $.session.id(),
  sessionMessages: agentId => agentId === undefined ? $.session.messages() : $.session.messages({ agentId }),
  readWorkflow: () => readWorkflow($),
  readMeta: () => readMeta($),
  ledgerPath: () => ledgerPath($),
  storeGet: key => $.store.get(key),
  storeSet: (key, value) => $.store.set(key, value),
  toolCall: input => $.tool.call(input),
  writeBoard: (path, html) => $.fs.write(path, html),
  boardPath: async () => `${await basePath($)}.board.html`,
  open: path => $.process.run(['open', path], { timeoutMs: 5000 }),
  now: () => kst(),
  log: (text, options) => $.ui.log(text, options),
})
const syncPanelSafely = ($: EngineInterface, origin: Origin, events: readonly TrackerEvent[]) => syncPanelDomain(panelIo($), origin, events)
const projectPanel = ($: EngineInterface, origin: Origin, events: readonly TrackerEvent[]) => panelIo($).serialize(origin.session, () => syncPanelSafely($, origin, events))
export const sessionIssues = ($: EngineInterface, query: { issue?: string; status?: Issue['status'] } = {}) => panelIssues(panelIo($), query)
export const clmStatus = ($: StatusReader) => panelStatus(panelIo($))
export const trackIssue = ($: EngineInterface, input: { title: string; status: Issue['status']; issue?: string }) => trackPanelIssue(panelIo($), input)
export { isHeld, type Held }

const heldIo = ($: EngineInterface): HeldIo => ({
  now: () => $.clock.now(),
  get: key => $.store.get(key),
  set: (key, value) => $.store.set(key, value),
  delete: key => $.store.delete(key),
  logEvent: (event, fields) => logEvent($, event, fields),
  complete: request => $.model.complete(request),
})
const readHeld = async ($: EngineInterface) => readHeldStore(heldIo($), await sid($))
const updateHeld = async ($: EngineInterface, settled: readonly string[], added: readonly Held[]) => updateHeldStore(heldIo($), await sid($), settled, added)
const gateMerge = ($: EngineInterface, ops: readonly Payload[], evidence: readonly Evidence[][], facts: readonly Fact[], sources: ReadonlyMap<string, Source>, ratio: number, dropped: ReadonlySet<string>) =>
  gateHeldMerge(heldIo($), ops, evidence, facts, sources, ratio, dropped)
const reviewFold = ($: EngineInterface, opts: Opts, input: import('./held').ReviewInput) => reviewHeldFold(heldIo($), opts, input)

const foldRuntimeIo = ($: EngineInterface): FoldRuntimeIo => ({
  readLedger: async () => readText($, await ledgerPath($)),
  captureOrigin: () => captureOrigin($),
  readAll: () => readAll($),
  trackerView: (origin, ops) => trackerViewDomain({ readAll: () => readAll($) }, origin, ops),
  readHeld: () => readHeld($),
  heldClaims: (held, issues, session) => heldClaims(held, issues, session),
  gateMerge: (ops, evidence, facts, sources, ratio, dropped) => gateMerge($, ops, evidence, facts, sources, ratio, dropped),
  reviewFold: (opts, input) => reviewFold($, opts, input),
  residentLedger: (key, issues, state, events, preview) => residentLedger($, key, issues, state, events, preview),
  storedTopics: (notes, seq, key) => storedTopics($, notes, seq, key),
  ledgerPath: () => ledgerPath($),
  topics: async key => $.store.get(await topicsKey($, key)),
  usageReading: () => usageReading($),
  complete: request => $.model.complete(request),
  logEvent: (event, fields) => logEvent($, event, fields),
  log: (text, options) => $.ui.log(text, options),
})
const fold = ($: EngineInterface, opts: Opts, rows: readonly SessionMessage[], meta: Meta, mustFold: boolean, reading?: number, calibrate = true, prepared?: PreparedFold, transcript?: string) =>
  runFold(foldRuntimeIo($), opts, rows, meta, mustFold, reading, calibrate, prepared, transcript)
const trackerView = ($: EngineInterface, origin: Origin, ops: readonly Payload[] = []) =>
  trackerViewDomain({ readAll: () => readAll($) }, origin, ops)

const addressRuntimeIo = ($: EngineInterface): AddressRuntimeIo => ({
  sessionId: () => $.session.id(), get: key => $.store.get(key), set: (key, value) => $.store.set(key, value),
  read: async path => (await $.fs.exists(path)) ? $.fs.read(path) : undefined,
  log: (text, options) => $.ui.log(text, options),
})
const transcriptRows = ($: EngineInterface) => readAddressRows(addressRuntimeIo($))
const rememberTranscriptPath = ($: EngineInterface, session: string, path: string) => rememberAddressTranscriptPath(addressRuntimeIo($), session, path)
const addressIo = ($: EngineInterface) => makeRecallIo(addressRuntimeIo($))

async function readRequests($: EngineInterface, key: string): Promise<RequestRecord[]> {
  const value = await $.store.get(requestsKey(key))
  return Array.isArray(value) ? value.filter(isRequestRecord) : []
}

async function storedTopics($: EngineInterface, notes: string, seq: number, key?: string): Promise<Topic[]> {
  const resolvedKey = key ?? transcriptKey(await sid($))
  return storedTopicsDomain({ topics: async target => $.store.get(await topicsKey($, target)) }, notes, seq, resolvedKey)
}

const residentIo = ($: EngineInterface): ResidentIo => ({
  get: key => $.store.get(key),
  set: (key, value) => $.store.set(key, value),
  transcriptRows: () => transcriptRows($),
  readLedger: async () => readText($, await ledgerPath($)),
  readMeta: () => readMeta($),
  storedTopics: (notes, seq, key) => storedTopics($, notes, seq, key),
  readRequests: key => readRequests($, key),
})
const ensureInstructionIndex = ($: EngineInterface, key: string, notes: string) => ensureResidentInstructionIndex(residentIo($), key, notes)
const residentLedger = ($: EngineInterface, key: string, issues: readonly Issue[], state: { stack: string[]; pending: string[] }, events: readonly TrackerEvent[], preview: { notes?: string; topics?: TopicState[]; issues?: Issue[]; state?: { stack: string[]; pending: string[] } } = {}) =>
  renderResidentLedger(residentIo($), key, issues, state, events, preview)

const intentIo = ($: EngineInterface): PromptIntentIo => ({
  captureOrigin: () => captureOrigin($),
  readAll: () => readAll($),
  readWorkflow: () => readWorkflow($),
  changeWorkflow: change => changeWorkflow($, change),
  sessionMessages: () => $.session.messages(),
  complete: request => $.model.complete(request),
  get: key => $.store.get(key),
  set: (key, value) => $.store.set(key, value),
  writeEvents: (payloads, origin) => writeEvents($, payloads, origin),
  transcriptRows: () => transcriptRows($),
  serialize: (session, run) => serialized(session, run),
  syncPanel: (origin, events) => syncPanelSafely($, origin, events),
  log: (text, options) => $.ui.log(text, options),
})
const recordPromptIntent = ($: EngineInterface, text: string, promptSeq: number) => classifyPrompt(intentIo($), text, promptSeq)

/** The engine's live context tokens, when it has a reading. */
async function usageReading($: EngineInterface): Promise<number | undefined> {
  try {
    const { tokens } = (await $.session.usage()).context
    return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : undefined
  } catch {
    return undefined
  }
}
const rewindIo = ($: EngineInterface): RewindIo => ({
  storeGet: key => $.store.get(key),
  storeSet: (key, value) => $.store.set(key, value),
  storeDelete: key => $.store.delete(key),
  writeFile: (path, text) => $.fs.write(path, text),
  ledgerPath: () => ledgerPath($),
  topicsKey: key => topicsKey($, key),
  pendingKey: key => pendingKey($, key),
  readMeta: () => readMeta($),
  writeMeta: value => writeMeta($, value),
  readyFoldDropFps: key => foldJobDropFps(key),
  clearReadyFold: async key => {
    clearFoldJob(key)
    await $.store.delete(await pendingKey($, key))
  },
  setRewindReady: (key, plan, fingerprints) => setRewindFoldJob(key, plan, fingerprints),
  logEvent: fields => logEvent($, 'rewind', fields),
  log: text => $.ui.log(text, { to: 'debug' }),
})

const foldJobIo = ($: EngineInterface): FoldJobIo => ({
  sessionId: () => $.session.id(),
  sessionMessages: () => $.session.messages(),
  sessionCompact: () => $.session.compact({}),
  now: () => $.clock.now(),
  usageReading: () => usageReading($),
  readMeta: () => readMeta($),
  writeMeta: meta => writeMeta($, meta),
  readLedger: async () => readText($, await ledgerPath($)),
  ledgerPath: () => ledgerPath($),
  logPath: () => logPath($),
  basePath: () => basePath($),
  readFile: async path => readText($, path),
  writeFile: (path, text) => $.fs.write(path, text),
  fileExists: path => $.fs.exists(path),
  fileList: path => $.fs.list(path),
  run: (args, options) => $.process.run(args, options),
  storeGet: key => $.store.get(key),
  storeSet: (key, value) => $.store.set(key, value),
  storeDelete: key => $.store.delete(key),
  pendingKey: key => pendingKey($, key),
  topicsKey: key => topicsKey($, key),
  captureOrigin: () => captureOrigin($),
  readAll: () => readAll($),
  trackerView: (origin, ops) => trackerView($, origin, ops),
  readHeld: () => readHeld($),
  updateHeld: (settled, hold) => updateHeld($, settled, hold),
  ensureInstructionIndex: (key, notes) => ensureInstructionIndex($, key, notes),
  residentLedger: (key, issues, state, events, preview) => residentLedger($, key, issues, state, events, preview),
  append: (payloads, origin, project, knownTitles) => append($, payloads, origin, project, knownTitles),
  projectPanel: (origin, events) => projectPanel($, origin, events),
  readRewindIo: () => rewindIo($),
  observeTranscript: (key, rows) => observeTranscript(rewindIo($), key, rows),
  fold: (opts, rows, meta, mustFold, reading, calibrate, prepared, transcript) => fold($, opts, rows, meta, mustFold, reading, calibrate, prepared, transcript),
  complete: request => $.model.complete(request),
  logEvent: (event, fields) => logEvent($, event, fields),
  log: (text, options) => $.ui.log(text, options),
})

export const report = foldJobReport

const replayIo = ($: EngineInterface): ReplayIo => ({
  read: () => readWorkflow($),
  change: change => changeWorkflow($, change),
  log: message => $.ui.log(message),
  captureOrigin: () => captureOrigin($),
  readEvents: () => readAll($),
  serialize: (session, run) => serialized(session, run),
  compose,
  writeEvents: (payloads, origin) => writeEvents($, payloads, origin),
  syncPanel: (origin, events) => syncPanelSafely($, origin, events),
})
const reconcileReplay = ($: EngineInterface) => reconcileWorkflowReplay(replayIo($))

const workflowIo = ($: EngineInterface): WorkflowIo => ({
  read: () => readWorkflow($),
  change: change => changeWorkflow($, change),
  submit: input => $.prompt.submit(input),
  log: message => $.ui.log(message),
})
const stampHumanPrompt = ($: EngineInterface) => stampWorkflowPrompt(workflowIo($))
export const submitWithRecovery = recoverWorkflowSubmit

const mainTurnCompletionIo = ($: EngineInterface, opts: Opts): MainTurnCompletionIo => ({
  showChanges: answer => { void showFoldTurnChanges(foldJobIo($), answer).catch(err => $.ui.log(`clm: turn context refresh failed (${String(err).slice(0, 160)})`, { to: 'debug' })) },
  reconcileReplay: () => reconcileReplay($),
  maybeClear: () => maybeClearFoldJob(foldJobIo($), opts),
  arbitrate: turnId => arbitrateWorkflow(workflowIo($), turnId),
  clearActiveTurn: turnId => changeWorkflow($, current => ({
    next: current.activeTurnId === turnId ? { ...current, activeTurnId: null } : current,
    result: undefined,
  })),
  log: message => $.ui.log(message, { to: 'debug' }),
})

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
    const value = await queueResume(workflowIo($), e.text, async () => `resume:${await $.clock.now()}:${Math.random().toString(36).slice(2, 10)}`)
    return { value }
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
    const outcome = await runPanelCommand({
      readAll: () => readAll($),
      append: payloads => append($, payloads),
      issues: () => sessionIssues($),
      openBoard: () => openPanelBoard(panelIo($)),
      log: text => $.ui.log(text),
    }, e.args)
    if (outcome === 'handled') return {}
    const meta = await readMeta($)
    const rows = liveRows(await $.session.messages(), meta.boundary)
    const log = ((await readText($, await logPath($))) ?? '').split('\n').filter(Boolean).slice(-5)
    $.ui.log(foldJobReport(await readText($, await ledgerPath($)), rows, opts, meta, log))
    return {}
  })

  on('turn.start', async ($, e, next) => {
    await markActiveTurn({ ...workflowIo($), log: message => $.ui.log(message, { to: 'debug' }) }, e.turnId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await markActiveTurn({ ...workflowIo($), log: message => $.ui.log(message, { to: 'debug' }) }, e.turnId)
    if (e.agentId !== undefined) {
      try { return await next(e) }
      finally {
        try { await removeAgentTaskRoot(panelIo($), await sid($), e.agentId) }
        catch (err) { $.ui.log(`clm: could not clear task root for agent ${e.agentId}: ${String(err).slice(0, 120)}`, { to: 'debug' }) }
      }
    }
    const res = await next(e)
    await completeMainTurn(mainTurnCompletionIo($, opts), e.turnId, e.isAborted, e.answer)
    return res
  })

  // The engine and the turn-end check share one per-transcript job.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (!Array.isArray(e.messages)) return { skip: 'clm: the compaction carried no transcript' }
    return compactFoldJob(foldJobIo($), opts, e.messages, e.trigger)
  })

  on('tool.call', { tool: RECALL_TOOL }, async ($, e) => recallAddress(addressIo($), e.address))

  on('agent.spawn', async ($, e, next) => {
    const io = panelIo($)
    const origin = await captureOrigin($)
    const roots = await assignedTaskRoots(io, origin.session)
    const parent = e.parentAgentId === undefined ? focusOf(await readAll($), origin.session).stack.at(-1) : roots[e.parentAgentId]
    if (!parent) return { deny: `clm: ${e.parentAgentId ? `agent ${e.parentAgentId}` : 'the main agent'} needs an assigned task before spawning a child agent.` }
    const spawned = await next(e)
    if (!spawned.agentId) return spawned
    await createAgentTaskRoot(io, origin.session, spawned.agentId, parent, e.description || e.prompt)
    return spawned
  })
  on('tool.call', { tool: TASK_TOOL }, async ($, e) => {
    if (!isClmTaskInput(e)) return { deny: 'clm_task requires status and either an issue id or a new task title.' }
    return runPanelTask(panelIo($), e, e.agentId)
  })
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => (e.agentId !== undefined || next.origin.plugin === 'clm' ? next(e) : denyPanelTask({ mirrorModelTask: event => mirrorModelTask(panelIo($), event), log: (text, options) => $.ui.log(text, options) }, e)))
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => (e.agentId !== undefined || next.origin.plugin === 'clm' ? next(e) : denyPanelTask({ mirrorModelTask: event => mirrorModelTask(panelIo($), event), log: (text, options) => $.ui.log(text, options) }, e)))
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
        await observeTranscript(rewindIo($), key, await $.session.messages())
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
