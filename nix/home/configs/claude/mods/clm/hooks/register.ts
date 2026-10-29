import { update, type EngineInterface, type Register, type SessionMessage } from 'claude-code'
import { append as appendEvents, captureOrigin as captureEventsOrigin, logEvent as writeLogEvent, readAll as readAllEvents, serialized as serializeEvents, writeEvents as writeTrackerEvents, type EventsIo, type LogEvent, type LogFields, type Payloads } from './events'
import { assignedTaskRoots, claimAgentTaskRoot, closeAgentTaskRoot, createAgentTaskRoot, plannedAgentStep, SPAWN_PLAN_REQUEST, STEPPED_WORKTREE_CONTEXT, clmStatus as panelStatus, denyModelTask as denyPanelTask, isClmTaskInput, mirrorModelTask, openBoard as openPanelBoard, runClmTask as runPanelTask, runPanelCommand, sessionIssues as panelIssues, steppedPromptContext, syncPanelSafely as syncPanelDomain, trackIssue as trackPanelIssue, TASK_TOOL, type PanelIo } from './panel'
import { droppedIds, gateMerge as gateHeldMerge, heldClaims, isHeld, readHeld as readHeldStore, reviewFold as reviewHeldFold, updateHeld as updateHeldStore, type Held, type HeldIo } from './held'

import {
  buildCleared, isHarnessText, isLedgerRow, isPrompt, isStableAttachmentType, isSystemRow, isUserTyped, keepSpawnReminders, kst, STABLE_ATTACHMENT_TYPES, stableAttachmentOf, stableAttachmentRow, stripReminders, ledgerRowSeq, ledgerRowText, liveRows, planClear, protectedIndex, sum, visibleTokens, TOKEN_ESTIMATOR_VERSION,
  type Boundary, type ClearPlan, type StableAttachmentType,
} from './fold'
import {
  checkEvidence, clippedSource, describeOp, gateOps, isDoneClaim, isDropClaim, isReopenClaim, renderRange,
  type Evidence, type Source,
} from './evidence'
import {
  composeLedger, EMPTY_LEDGER, factLine, factLines, constraintFactLines, learnedFactLines, fallbackLedger, instructionKey, instructionValues, withdrawnInstructionKeys, issueList, legacyItems, MERGE_SYSTEM, mergeableNotes, normalizeLedger, notesOf, oversizeLines,
  parseChanges, parseMerge, parseReview, preservedLines, rememberFacts, rememberOversize, rememberPreserved, renderTurns, REVIEW_SYSTEM, withheldLines, withheldPointer,
  WITHDRAWN_PREFIX, SPLIT_MERGE_SYSTEM, SECTIONS, ageDecayPlan, isDirective, type Fact,
} from './ledger'
import {
  archivedDone, injected, normalizeRemote, parseLog, parseOps, snapshot, toEvents,
  focusOf, isOpen, isRecord, type Issue, type Origin, type Payload, type TrackerEvent,
} from './tracker'
import { attemptState, judgeRubric, outermostSteppedRootOf, type JudgeIo } from './stepped'
import { checkpointCommit, landCommands, rollbackTo, WorktreeError, type Worktree } from './worktree'
import { backfillClausesChained, recordPromptIntent as classifyPrompt, isRequestRecord, type RequestRecord, type PromptIntentIo } from './intent'
import { arbitrateContinuation as arbitrateWorkflow, changeWorkflow as changeWorkflowDomain, completeMainTurn, isHumanOrigin, markActiveTurn, queueResume, readWorkflow as readWorkflowDomain, resetUserWorkflow, stampHumanPrompt as stampWorkflowPrompt, submitWithRecovery as recoverWorkflowSubmit, type MainTurnCompletionIo, type WorkflowIo, type WorkflowStateIo } from './workflow'
import type { ClmStableAttachmentSession as StableAttachmentSession, ClmStableAttachmentState as StableAttachmentStore, ClmStableAttachmentValue as StableAttachmentValue, ClmStatus, ClmTaskInput, ClmWorkflow } from '../types'
import { addressRows, recallAddress, recordPrompt, sentAtOf, stampMessages, type AddressIo, type SentAt } from './address'
import { residentLedger as renderResidentLedger, type ResidentIo } from './resident'
import { observeTranscript, type RewindIo } from './rewind'
import { fold as runFold, parseSplitAnswer, readLegacyTopics as readLegacyTopicsDomain, trackerView as trackerViewDomain, type FoldRuntimeIo, type Meta, type Opts, type PreparedFold, type TopicState, type TrackerView } from './fold-runtime'
import { adoptEngineSummary, clearFoldJob, foldJobDropFps, foldJobIdle, handOff as handOffFoldJob, handleSessionCompact as compactFoldJob, maybeClear as maybeClearFoldJob, report as foldJobReport, setRewindFoldJob, showTurnChanges as showFoldTurnChanges, transcriptKey, type FoldJobIo } from './fold-job'
import { registerResources } from './resources'
import { coworkerIntent, registerCoworkers } from './coworker-runtime'
import { clauseStoreKey, emptyClauseStore, readClauseStore } from './clauses'

export { recallRows } from './address'
export { residentLedgerText } from './resident'
export { chooseContinuation, resetUserWorkflow, restoreFailedContinuation } from './workflow'
export { messageTokens, type Meta, type Opts }

// Each transcript has one background compaction job; engine compactions join
// it and apply its ready plan. The tracker renders task state, so merge ops
// update persistent issues; withholding is used inside the job if summary fails.

const WORKFLOW = { plugin: 'clm', key: 'workflow' } as const
const RECALL_TOOL = 'mcp__clm__clm_recall'
export { TASK_TOOL }

type WorkflowReader = { state: { get: (ref: typeof WORKFLOW) => Promise<{ value: unknown }> } }
type SessionReader = { session: { id: () => Promise<string> } }
type StoreReader = SessionReader & {
  env: { get: (name: string) => Promise<string | undefined> }
  fs: { exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string>; write: (path: string, text: string) => Promise<void> }
  store: { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void>; delete: (key: string) => Promise<void>; keys: () => Promise<string[]> }
  ui: { log: (text: string, options?: { to?: 'transcript' | 'debug' }) => void }
}
type StoreWriter = StoreReader
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
// An unset or 0 budget follows the live window: the fold escape point
// (budget - reserve) sits at `threshold` of it, so the background fold starts
// there and the targets below scale with it. The gates compare conversation
// rows alone (reading minus the fixed prefix), so the window point becomes a
// rows budget here; left whole, a 67k prefix put it past the engine's own
// autocompact point and the ready plan never applied.
export function readOpts(o: Record<string, unknown>, window?: number, prefix = 0): { opts: Opts; problems: string[] } {
  const problems: string[] = []
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
  let threshold = 0.6
  if (o.threshold !== undefined && o.threshold !== 0) {
    if (typeof o.threshold === 'number' && o.threshold > 0 && o.threshold < 1) threshold = o.threshold
    else problems.push(`threshold=${JSON.stringify(o.threshold)} must be a fraction between 0 and 1; using 0.6`)
  }
  const point = typeof window === 'number' && Number.isFinite(window) && window > 0 ? Math.floor(window * threshold) : 0
  const target = Math.max(Math.floor(point / 4), point - Math.max(0, prefix))
  const followsWindow = point >= 2000 && (o.budget === undefined || o.budget === 0)
  let budget = followsWindow ? target + Math.min(2048, Math.floor(target / 4)) : 32000
  if (!followsWindow && o.budget !== undefined && o.budget !== 0) {
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
  const defReserve = followsWindow ? budget - target : Math.min(2048, Math.floor(budget / 4))
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
const requestsKey = (key: string) => `requests:${key}`

const SESSION_STORE_PREFIXES = new Set([
  'address-index', 'agent-task-roots', 'agent-task-step-claims', 'clause-backlog', 'clauses', 'headAttachments', 'held', 'instruction-index', 'issue-addresses',
  'ledger', 'ledger-snapshots', 'pending', 'request-prompt-seq', 'requests', 'stepped', 'topics', 'transcript-path', 'transcript-rows',
])
const SESSION_STATE_MAX_CHARS = 4_194_304
const SESSION_STATE_MIGRATION_KEY = 'migrated:session-files:v1'
const sessionStateWrites = new Map<string, Promise<void>>()
let sessionStateMigration: Promise<void> | undefined
let sessionStateMigrationFailed = false

function sessionStoreOwner(key: string): string | undefined {
  const separator = key.indexOf(':')
  if (separator < 0 || !SESSION_STORE_PREFIXES.has(key.slice(0, separator))) return
  const session = key.slice(separator + 1).split(':', 1)[0]
  return session || undefined
}

async function sessionStatePath($: HomeReader, session: string): Promise<string> {
  return `${await sessionBasePath($, session)}.state.json`
}

async function readSessionState($: StoreReader, session: string, enforceLimit = true): Promise<Record<string, unknown>> {
  const path = await sessionStatePath($, session)
  if (!(await $.fs.exists(path))) return {}
  const text = await $.fs.read(path)
  if (enforceLimit && text.length > SESSION_STATE_MAX_CHARS) throw new Error(`clm: session state exceeds ${SESSION_STATE_MAX_CHARS} characters`)
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) { return recoverSessionState($, session, path, text, `invalid JSON (${String(error).slice(0, 300)})`) }
  if (!isRecord(value)) return recoverSessionState($, session, path, text, 'state file is not an object')
  return value
}

async function recoverSessionState($: StoreReader, session: string, path: string, text: string, problem: string): Promise<Record<string, unknown>> {
  const backup = `${await sessionBasePath($, session)}.state.corrupt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`
  await logEvent($, 'session-state-migration', { reason: `malformed session state for ${session}: ${problem}; preserving at ${backup}` })
  try {
    await $.fs.write(backup, text)
    await $.fs.write(path, '{}')
  } catch (error) {
    await logEvent($, 'session-state-migration', { reason: `could not recover malformed session state for ${session}: ${String(error).slice(0, 500)}` })
  }
  return {}
}

function serializeSessionState<T>(session: string, run: () => Promise<T>): Promise<T> {
  const result = (sessionStateWrites.get(session) ?? Promise.resolve()).then(run, run)
  const tail = result.then(() => undefined, () => undefined)
  sessionStateWrites.set(session, tail)
  void tail.then(() => { if (sessionStateWrites.get(session) === tail) sessionStateWrites.delete(session) })
  return result
}

async function sessionStoreGet($: StoreReader, key: string): Promise<unknown> {
  const session = sessionStoreOwner(key)
  if (!session) return $.store.get(key)
  await ensureSessionStateMigration($)
  return serializeSessionState(session, async () => (await readSessionState($, session))[key])
}

async function writeSessionState($: StoreWriter, session: string, state: Record<string, unknown>, droppedKey?: string): Promise<void> {
  const text = JSON.stringify(state)
  if (text.length > SESSION_STATE_MAX_CHARS) {
    await logEvent($, 'session-state-migration', { reason: `session state write for ${session} exceeded ${SESSION_STATE_MAX_CHARS} characters; dropped ${droppedKey ?? 'updated state'}` })
    return
  }
  await $.fs.write(await sessionStatePath($, session), text)
}

async function sessionStoreSet($: StoreWriter, key: string, value: unknown): Promise<void> {
  const session = sessionStoreOwner(key)
  if (!session) return $.store.set(key, value)
  await ensureSessionStateMigration($)
  await serializeSessionState(session, async () => {
    const state = await readSessionState($, session)
    state[key] = value
    await writeSessionState($, session, state, key)
  })
}

async function sessionStoreDelete($: StoreWriter, key: string): Promise<void> {
  const session = sessionStoreOwner(key)
  if (!session) return $.store.delete(key)
  await ensureSessionStateMigration($)
  await serializeSessionState(session, async () => {
    const path = await sessionStatePath($, session)
    if (await $.fs.exists(path)) {
      const state = await readSessionState($, session)
      if (Object.prototype.hasOwnProperty.call(state, key)) {
        delete state[key]
        await writeSessionState($, session, state)
      }
    }
  })
}

async function migrateSessionStore($: StoreWriter, report: (reason: string) => Promise<void>): Promise<void> {
  if (await $.store.get(SESSION_STATE_MIGRATION_KEY) === true) return
  const sessions = new Map<string, string[]>()
  for (const key of await $.store.keys()) {
    const session = sessionStoreOwner(key)
    if (!session) continue
    const keys = sessions.get(session) ?? []
    keys.push(key)
    sessions.set(session, keys)
  }
  let failures = 0
  for (const [session, keys] of sessions) {
    try {
      await serializeSessionState(session, async () => {
        const state = await readSessionState($, session, false)
        let text = JSON.stringify(state)
        const dropped: string[] = []
        if (text.length > SESSION_STATE_MAX_CHARS) {
          dropped.push(...keys.filter(key => !Object.prototype.hasOwnProperty.call(state, key)))
          await report(`session state for ${session} already exceeds ${SESSION_STATE_MAX_CHARS} characters; dropped ${dropped.length} legacy key(s)`)
        }
        else {
          for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(state, key)) continue
            const value = await $.store.get(key)
            if (value === undefined) continue
            const candidate = { ...state, [key]: value }
            const candidateText = JSON.stringify(candidate)
            if (candidateText.length > SESSION_STATE_MAX_CHARS) {
              dropped.push(key)
              continue
            }
            state[key] = value
            text = candidateText
          }
        }
        if (dropped.length && text.length <= SESSION_STATE_MAX_CHARS) {
          await report(`session state for ${session} exceeded ${SESSION_STATE_MAX_CHARS} characters; dropped ${dropped.length} legacy key(s): ${dropped.slice(0, 12).join(', ')}`)
        }
        await $.fs.write(await sessionStatePath($, session), text)
        for (const key of keys) await $.store.delete(key)
      })
    } catch (error) {
      failures++
      await report(`session state migration failed for ${session}: ${String(error).slice(0, 1000)}`)
    }
  }
  if (failures > 0) throw new Error(`session state migration failed for ${failures} session(s)`)
  await $.store.set(SESSION_STATE_MIGRATION_KEY, true)
}

async function ensureSessionStateMigration($: StoreWriter): Promise<void> {
  if (!sessionStateMigration) {
    const report = async (reason: string) => {
      try { await logEvent($, 'session-state-migration', { reason }) }
      catch { try { $.ui.log(`clm: ${reason}`, { to: 'debug' }) } catch { /* state access still proceeds */ } }
    }
    sessionStateMigration = migrateSessionStore($, report).catch(async error => {
      sessionStateMigrationFailed = true
      const reason = `session state migration failed: ${String(error).slice(0, 1000)}`
      await report(reason)
    })
  }
  await sessionStateMigration
}

const isNumberRecord = (v: unknown): v is Record<string, number> => isRecord(v) && Object.values(v).every(n => typeof n === 'number')
const optional = (v: unknown, type: 'number' | 'string') => v === undefined || typeof v === type
const isMeta = (v: unknown): v is Partial<Meta> =>
  isRecord(v) && optional(v.seq, 'number') && optional(v.fails, 'number') && optional(v.ratio, 'number') && optional(v.overhead, 'number')
  && optional(v.foldTokens, 'number') && optional(v.firstObserved, 'number') && optional(v.estimatorVersion, 'number') && optional(v.lastFoldAt, 'number') && (v.foldDurationsMs === undefined || isNumberRecord(v.foldDurationsMs)) && optional(v.lastClear, 'string') && (v.boundary === undefined || isRecord(v.boundary))
async function readMeta($: StoreReader): Promise<Meta> {
  const stored = await sessionStoreGet($, await metaKey($))
  const meta = { seq: 0, fails: 0, ...(isMeta(stored) ? stored : {}) }
  if (meta.estimatorVersion !== TOKEN_ESTIMATOR_VERSION) {
    meta.ratio = undefined
    meta.overhead = undefined
    meta.estimatorVersion = TOKEN_ESTIMATOR_VERSION
  }
  return meta
}
const writeMeta = async ($: EngineInterface, m: Meta) => sessionStoreSet($, await metaKey($), m)
export type StableAttachmentInput = { type: StableAttachmentType; text: string; origin: unknown; agentId?: string; detail?: unknown }
export type StableAttachmentIo = Pick<EngineInterface, 'state'> & StoreWriter
const STABLE_ATTACHMENTS = { plugin: 'clm', key: 'stableAttachments' } as const
const MAX_STABLE_ATTACHMENT_DELTAS = 32
const INSTRUCTIONS_PREAMBLE = 'Codebase and user instructions are shown below.'
const isInstructionDelta = (text: string) => !text.startsWith(INSTRUCTIONS_PREAMBLE)
const textDigest = (text: string) => {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) hash = ((hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n) & 0xffffffffffffffffn
  return `${text.length}:${hash.toString(16)}`
}
// The descriptions Claude Code 2.1.288 emits; a quoted header with any other
// description stays file content instead of starting a fake section.
const INSTRUCTION_KINDS = ["project instructions, checked into the codebase", "user's private project instructions, not checked in", "user's auto-memory, persists across conversations", 'organization-managed policy instructions', "user's private global instructions for all projects"]
const INSTRUCTION_FILE = new RegExp(`(?:^|\\n\\n)Contents of (.+) \\((?:${INSTRUCTION_KINDS.join('|')})\\):\\n\\n`, 'g')
const instructionSections = (text: string) => {
  const heads = [...text.matchAll(INSTRUCTION_FILE)].map(m => ({ path: m[1] ?? '', at: m.index + m[0].indexOf('Contents of ') }))
  return { lead: text.slice(0, heads[0]?.at ?? text.length), sections: heads.map((head, i) => ({ path: head.path, text: text.slice(head.at, heads[i + 1]?.at ?? text.length) })) }
}
const uniquePaths = (sections: readonly { path: string }[]) => new Set(sections.map(section => section.path)).size === sections.length
// The harness re-announces a changed file after every compact boundary, each
// section replacing "its earlier copy"; folding it into the full text keeps one
// latest instructions row. undefined when either side has no file sections.
export const mergeInstructions = (full: string, delta: string): string | undefined => {
  const changed = instructionSections(delta).sections
  const { lead, sections } = instructionSections(full)
  // A path seen twice, or one the full text lacks, means file content quoted the
  // header shape; keeping the delta as its own row loses nothing.
  if (!changed.length || !uniquePaths(changed) || !uniquePaths(sections) || changed.some(c => !sections.some(section => section.path === c.path))) return undefined
  const replace = new Map(changed.map(section => [section.path, section.text.trimEnd()]))
  let differs = false
  const merged = sections.map(section => {
    const next = replace.get(section.path)
    const body = section.text.trimEnd()
    if (next === undefined || next === body) return section.text
    differs = true
    return next + section.text.slice(body.length)
  })
  return differs ? lead + merged.join('') : full
}
const stableDeltaSections = (text: string) => {
  const matches = [...text.matchAll(/^(?:Contents of (.+?)(?: \(([^()\n]*)\))?:|Instructions no longer present: (.+))$/gm)]
  const sections = matches.flatMap((match, i) => {
    const path = match[1] ?? match[3]
    const start = match.index
    if (path === undefined || start === undefined) return []
    const end = matches[i + 1]?.index ?? text.length
    return [{ path, start, text: text.slice(start, end) }]
  })
  if (!sections.length) return undefined
  return {
    prefix: text.slice(0, sections[0]?.start ?? text.length),
    sections,
  }
}
const appendStableDelta = (deltas: string[], text: string, type: StableAttachmentType) => {
  const incoming = type === 'instructions' ? stableDeltaSections(text) : undefined
  const paths = new Set(incoming?.sections.map(section => section.path))
  const retained = incoming ? deltas.flatMap(delta => {
    const previous = stableDeltaSections(delta)
    if (!previous) return [delta]
    const sections = previous.sections.filter(section => !paths.has(section.path))
    if (!sections.length) {
      const remaining = previous.prefix.replace(/^Instruction files were re-read[^\n]*(?:\n|$)/, '').trim()
      return remaining ? [remaining] : []
    }
    return [previous.prefix + sections.map(section => section.text).join('')]
  }) : deltas
  return [...retained.filter(delta => delta !== text), text].slice(-MAX_STABLE_ATTACHMENT_DELTAS)
}
type StableAttachmentProgress = StableAttachmentValue & { droppedAtSeq?: number }

const absorbStable = (value: StableAttachmentValue, type: StableAttachmentType, text: string): boolean => {
  if (type === 'instructions' && isInstructionDelta(text)) {
    const merged = value.full === undefined ? undefined : mergeInstructions(value.full, text)
    if (merged !== undefined) {
      if (merged === value.full) return false
      value.full = merged
      return true
    }
    if (value.deltas.includes(text)) return false
    const deltas = appendStableDelta(value.deltas, text, type)
    const changed = deltas.length !== value.deltas.length || deltas.some((delta, index) => delta !== value.deltas[index])
    value.deltas = deltas
    return changed
  }
  if (value.full === text) return false
  Object.assign(value, { full: text, deltas: [] })
  return true
}
const isStableAttachmentValue = (value: unknown): value is StableAttachmentValue =>
  isRecord(value) && (value.full === undefined || typeof value.full === 'string') && (value.inHead === undefined || typeof value.inHead === 'boolean') && (value.headDigest === undefined || typeof value.headDigest === 'string') && Array.isArray(value.deltas)
  && value.deltas.every(item => typeof item === 'string') && typeof value.carriedAtSeq === 'number'
  && (value.droppedAtSeq === undefined || typeof value.droppedAtSeq === 'number')
const isStableAttachmentSession = (value: unknown): value is StableAttachmentSession =>
  isRecord(value) && Object.entries(value).every(([type, item]) => isStableAttachmentType(type) && isStableAttachmentValue(item))
const stableAttachmentStore = (value: unknown): StableAttachmentStore => {
  const store: StableAttachmentStore = {}
  if (!isRecord(value)) return store
  for (const [session, item] of Object.entries(value)) if (isStableAttachmentSession(item)) store[session] = item
  return store
}
const updateStableAttachmentStore = async <T>($: StableAttachmentIo, change: (current: StableAttachmentStore) => { next: StableAttachmentStore; result: T }): Promise<T> => {
  const outcomes: { result: T }[] = []
  await update($, STABLE_ATTACHMENTS, current => {
    const changed = change(stableAttachmentStore(current))
    outcomes.push({ result: changed.result })
    return changed.next
  })
  const outcome = outcomes[0]
  if (outcome === undefined) throw new Error('clm: stable attachment state update did not run')
  return outcome.result
}

function attachmentSessionFromMessages(rows: readonly SessionMessage[]): StableAttachmentSession {
  const ledgerIndex = rows.findLastIndex(isLedgerRow)
  const ledgerRow = ledgerIndex < 0 ? undefined : rows[ledgerIndex]
  const seq = ledgerRow === undefined ? 0 : Number(ledgerRowSeq(ledgerRow.text) ?? 0)
  const state: StableAttachmentSession = {}
  const carried: { type: StableAttachmentType; text: string }[] = []
  for (let i = ledgerIndex - 1; i >= 0; i--) {
    const message = rows[i]
    if (message === undefined) continue
    const row = stableAttachmentOf(message)
    if (!row) break
    carried.unshift(row)
  }
  for (const row of carried) {
    let value = state[row.type]
    if (!value) value = state[row.type] = { deltas: [], carriedAtSeq: seq }
    if (row.type === 'instructions' && isInstructionDelta(row.text)) {
      const merged = value.full === undefined ? undefined : mergeInstructions(value.full, row.text)
      if (merged !== undefined) value.full = merged
      else value.deltas = appendStableDelta(value.deltas, row.text, row.type)
    }
    else if (value.full === undefined) value.full = row.text
    else value.deltas = appendStableDelta(value.deltas, row.text, row.type)
  }
  return state
}

// $.state does not survive a resume, and attachments the kept head row holds
// leave no carried row to restore from. Their digests (never the text) persist
// so the resumed harness's re-announcement is still recognised and dropped.
type HeadAttachments = { seq: number; digests: Partial<Record<StableAttachmentType, string>> }
const headAttachmentsKey = async ($: StableAttachmentIo) => `headAttachments:${await $.session.id()}`
const isHeadAttachments = (value: unknown): value is HeadAttachments =>
  isRecord(value) && typeof value.seq === 'number' && isRecord(value.digests)
  && Object.entries(value.digests).every(([type, digest]) => isStableAttachmentType(type) && typeof digest === 'string')
async function stableAttachmentSession($: StableAttachmentIo): Promise<{ session: string; state: StableAttachmentSession }> {
  const session = await $.session.id()
  const current = stableAttachmentStore((await $.state.get(STABLE_ATTACHMENTS)).value)[session]
  if (current) return { session, state: current }
  const restored = attachmentSessionFromMessages(await $.session.messages())
  const head = await sessionStoreGet($, await headAttachmentsKey($))
  if (isHeadAttachments(head)) for (const [type, digest] of Object.entries(head.digests)) {
    if (!isStableAttachmentType(type) || digest === undefined) continue
    const value = restored[type] ?? (restored[type] = { deltas: [], carriedAtSeq: head.seq })
    if (value.full === undefined) Object.assign(value, { inHead: true, headDigest: digest })
  }
  return updateStableAttachmentStore($, sessions => {
    const state = sessions[session] ?? restored
    return { next: { ...sessions, [session]: state }, result: { session, state } }
  })
}

export async function handleStableAttachment($: StableAttachmentIo, input: StableAttachmentInput): Promise<{ text: null } | undefined> {
  if (input.agentId !== undefined) return
  const { session } = await stableAttachmentSession($)
  // Announced before any reply, it sits in the first request's transcript group.
  const inHead = !(await $.session.messages()).some(m => m.role === 'assistant')
  return updateStableAttachmentStore($, sessions => {
    const state = sessions[session] ?? {}
    const value = state[input.type] ?? (state[input.type] = { deltas: [], carriedAtSeq: 0 })
    const delta = input.type === 'instructions' && isInstructionDelta(input.text)
    if (!delta && value.full === undefined && value.headDigest === textDigest(input.text)) value.full = input.text
    const changed = absorbStable(value, input.type, input.text)
    if (inHead && !delta) Object.assign(value, { inHead, headDigest: textDigest(input.text) })
    if (changed) {
      value.carriedAtSeq = 0
      ;(value as StableAttachmentProgress).droppedAtSeq = 0
    }
    // Re-announced carried attachments must not create duplicate rows.
    const progress = value as StableAttachmentProgress
    const result = input.type !== 'instructions' && !changed && value.carriedAtSeq > 0 && (delta || value.carriedAtSeq > (progress.droppedAtSeq ?? 0)) ? { text: null } : undefined
    if (result) progress.droppedAtSeq = value.carriedAtSeq
    return { next: { ...sessions, [session]: state }, result }
  })
}

// The kept head group brings back the session-start copy; once a newer text
// replaced it, that copy is stale, so the head is rebuilt without its handle
// and the latest text is carried instead. A head copy known only by digest
// (after a resume) cannot be carried, so it keeps the head.
const stableAttachmentRows = async ($: StableAttachmentIo, headKept: boolean): Promise<{ rows: SessionMessage[]; headKept: boolean }> => {
  const { session } = await stableAttachmentSession($)
  return updateStableAttachmentStore($, sessions => {
    const state = sessions[session] ?? {}
    const stale = (value: StableAttachmentValue) => value.inHead === true && value.full !== undefined && textDigest(value.full) !== value.headDigest
    const held = Object.values(state).filter(value => value.inHead)
    const keep = headKept && !(held.every(value => value.full !== undefined) && held.some(stale))
    const rows = STABLE_ATTACHMENT_TYPES.filter(type => type !== 'instructions').flatMap(type => {
      const value = state[type]
      return value ? [...(value.full === undefined || (keep && value.inHead && !stale(value)) ? [] : [stableAttachmentRow(type, value.full)]), ...value.deltas.map(text => stableAttachmentRow(type, text))] : []
    })
    return { next: sessions, result: { rows, headKept: keep } }
  })
}

const markStableAttachmentsCarried = async ($: StableAttachmentIo, seq: number, rows: readonly SessionMessage[], headKept: boolean) => {
  const { session } = await stableAttachmentSession($)
  const marked = await updateStableAttachmentStore($, sessions => {
    const state = sessions[session] ?? {}
    for (const row of rows) {
      const attachment = stableAttachmentOf(row)
      const value = attachment?.type === 'instructions' ? undefined : attachment && state[attachment.type]
      if (value) value.carriedAtSeq = seq
    }
    for (const [type, value] of Object.entries(state)) {
      if (type !== 'instructions' && headKept && value.inHead) value.carriedAtSeq = seq
      if (!headKept) { delete value.inHead; delete value.headDigest }
    }
    return { next: { ...sessions, [session]: state }, result: state }
  })
  const digests: HeadAttachments['digests'] = {}
  if (headKept) for (const type of STABLE_ATTACHMENT_TYPES) {
    const value = marked[type]
    const digest = value?.inHead ? (value.full === undefined ? value.headDigest : textDigest(value.full)) : undefined
    if (digest !== undefined) digests[type] = digest
  }
  await sessionStoreSet($, await headAttachmentsKey($), { seq, digests } satisfies HeadAttachments)
}

const clearStableAttachmentSession = ($: StableAttachmentIo, session: string) => updateStableAttachmentStore($, sessions => {
  const next = { ...sessions }
  delete next[session]
  return { next, result: undefined }
})

async function sessionBasePath($: HomeReader, session: string): Promise<string> {
  const home = await $.env.get('HOME')
  return `${home ?? '.'}/.claude-work/plans/clm-${session}`
}
async function basePath($: HomeReader): Promise<string> { return sessionBasePath($, await sid($)) }
const ledgerPath = async ($: HomeReader) => `${await basePath($)}.md`
const logPath = async ($: HomeReader) => `${await basePath($)}.log.jsonl`
async function readText($: EngineInterface, p: string): Promise<string | undefined> {
  return (await $.fs.exists(p)) ? await $.fs.read(p) : undefined
}

const eventsIo = ($: EngineInterface): EventsIo => ({
  sessionId: () => $.session.id(),
  cwd: () => $.session.cwd(),
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
const append = ($: EngineInterface, payloads: Payloads, origin?: Origin, project = true, knownTitles = false) => appendEvents(eventsIo($), payloads, origin, project, knownTitles)
const logEvent = ($: StoreWriter, event: LogEvent, fields: LogFields) => writeLogEvent({
  generalLogPath: () => logPath($),
  exists: path => $.fs.exists(path),
  read: path => $.fs.read(path),
  write: (path, text) => $.fs.write(path, text),
}, event, fields)

async function logModLocationFailure($: EngineInterface, loadedFrom: string | undefined, error: unknown): Promise<void> {
  const reason = `could not resolve installed clm path: ${String(error).slice(0, 500)}`
  try { await logEvent($, 'mod-stale', { loadedFrom, reason }) }
  catch { try { $.ui.log(`clm: ${reason}`, { to: 'debug' }) } catch { /* detection remains fail-open */ } }
}

async function resolveInstalledMod($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '.'
  const pluginDirs = await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')
  const configured = pluginDirs?.split(':')
    .map(path => path.startsWith('~/') ? `${home}/${path.slice(2)}` : path)
    .find(path => /\/mods\/clm\/?$/.test(path))
  const installedDir = (configured ?? `${home}/.claude/mods/clm`).replace(/\/$/, '')
  const result = await $.process.run(['realpath', installedDir], { timeoutMs: 5000 })
  if (result.exitCode !== 0 || !result.stdout.trim()) throw new Error(`realpath exited ${result.exitCode}: ${result.stderr}`)
  return result.stdout.trim()
}

async function detectStaleMod($: EngineInterface, loadedFrom: string, installed: string, warnedSessions: Set<string>): Promise<void> {
  if (installed === loadedFrom) return
  const session = await sid($)
  if (warnedSessions.has(session)) return
  warnedSessions.add(session)
  try { await logEvent($, 'mod-stale', { loadedFrom, installedPath: installed }) }
  catch (error) { try { $.ui.log(`clm: stale mod event logging failed (${String(error).slice(0, 160)})`, { to: 'debug' }) } catch { /* detection remains fail-open */ } }
  try {
    $.ui.log(`clm: this session is running a stale clm copy and must be restarted (loaded ${loadedFrom}; installed ${installed})`)
  } catch (error) { try { $.ui.log(`clm: stale mod warning failed (${String(error).slice(0, 160)})`, { to: 'debug' }) } catch { /* detection remains fail-open */ } }
}

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
  storeGet: key => sessionStoreGet($, key),
  storeSet: (key, value) => sessionStoreSet($, key, value),
  toolCall: input => $.tool.call(input),
  writeBoard: (path, html) => $.fs.write(path, html),
  boardPath: async () => `${await basePath($)}.board.html`,
  open: path => $.process.run(['open', path], { timeoutMs: 5000 }),
  now: () => kst(),
  log: (text, options) => $.ui.log(text, options),
  complete: request => $.model.complete(request),
  run: (argv, options) => $.process.run([...argv], options),
  home: () => $.env.get('HOME'),
})
/** What `judgeRubric` needs from the engine; `agentId` picks whose transcript evidence items cite. */
export const stepJudgeIo = ($: EngineInterface, agentId?: string, worktree?: Worktree): JudgeIo => ({
  complete: request => $.model.complete(request),
  run: (argv, options) => {
    let cwd = options.cwd
    if (worktree) {
      if (!cwd || cwd === worktree.repoRoot) cwd = worktree.dir
      else if (cwd.startsWith(`${worktree.repoRoot.replace(/\/$/, '')}/`)) cwd = `${worktree.dir}${cwd.slice(worktree.repoRoot.replace(/\/$/, '').length)}`
    }
    return $.process.run(argv, { ...options, ...(cwd ? { cwd } : {}) })
  },
  sources: async () => {
    const rows = agentId === undefined ? await $.session.messages() : await $.session.messages({ agentId })
    return Array.isArray(rows) ? renderRange(rows).sources : new Map()
  },
})

const DEFAULT_STEP_METHOD = 'undeclared methodology'
const stepCitationMap = (message: string | undefined): Record<string, Evidence> => {
  if (!message) return {}
  const match = /<clm-step-citations>([\s\S]*?)<\/clm-step-citations>/.exec(message)
  if (!match?.[1]) return {}
  try {
    const value: unknown = JSON.parse(match[1])
    const rows = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.items) ? value.items : []
    return Object.fromEntries(rows.flatMap(row => isRecord(row) && typeof row.id === 'string'
      && typeof row.ref === 'string' && typeof row.quote === 'string'
      ? [[row.id, { ref: row.ref, quote: row.quote } satisfies Evidence]] : []))
  } catch { return {} }
}

const steppedFailureDetails = (error: unknown) => error instanceof WorktreeError
  ? `argv=${JSON.stringify(error.argv)} exitCode=${error.exitCode ?? 'unavailable'} stderr=${JSON.stringify(error.stderr)}`
  : `argv=[] exitCode=unavailable stderr=${JSON.stringify(String(error))}`

const failedMethodNames = (issue: Issue) => (issue.methods ?? []).flatMap(method => method.failed
  ? Array.from({ length: Math.max(1, method.failures ?? 0) }, () => method.text) : [])

async function handleSteppedStop($: EngineInterface, lastAssistantMessage?: string): Promise<{ block?: string } | undefined> {
  let issueId = 'unknown'
  const failOpen = (stage: string, error: unknown) => {
    const detail = `issue=${issueId} ${steppedFailureDetails(error)}`
    const message = `clm stepped: ${stage} failed; stop released (${detail})`
    $.ui.log(message)
    $.ui.log(message, { to: 'debug' })
    return undefined
  }
  try {
    const origin = await captureOrigin($)
    const events = await readAll($)
    const issues = snapshot(events).filter(issue => issue.origin.session === origin.session)
    const byId = new Map(issues.map(issue => [issue.id, issue]))
    const focusedId = focusOf(events, origin.session).stack.at(-1)
    if (!focusedId) return undefined
    issueId = focusedId
    const root = outermostSteppedRootOf(focusedId, byId)
    if (!root || root.status !== 'doing') return undefined
    issueId = root.id
    const children = issues.filter(issue => issue.parent === root.id)
    const active = children.filter(issue => issue.status === 'doing').at(-1)

    const land = async (goal: Issue): Promise<{ block?: string } | undefined> => {
      issueId = goal.id
      if (!goal.worktree) return failOpen('landing worktree lookup', new Error('stepped root has no persisted worktree'))
      if (goal.landCommandsShown) return undefined
      const commands = landCommands(goal.worktree)
      await append($, [
        { op: 'land', issue: goal.id },
        { op: 'status', issue: goal.id, status: 'done' },
      ], origin)
      return {
        block: `All steps for goal ${goal.id} passed. Run these commands in order through Bash in the main session to land the worktree:\n${commands.map(command => `- \`${command}\``).join('\n')}\nAfter the commands finish, stop again.`,
      }
    }

    if (active) {
      issueId = active.id
      if (!root.worktree) return failOpen('worktree lookup', new Error('active stepped goal has no persisted worktree'))
      const before = attemptState(active)
      if (before.stop) {
        const failed = failedMethodNames(active)
        const message = `clm stepped: goal ${root.id} stopped after five failed methodologies on issue ${active.id}: ${failed.slice(-5).join('; ')}`
        $.ui.log(message)
        $.ui.log(message, { to: 'debug' })
        return undefined
      }
      const method = active.activeMethod ?? before.method ?? DEFAULT_STEP_METHOD
      const verdicts = await judgeRubric(active, stepJudgeIo($, undefined, root.worktree), stepCitationMap(lastAssistantMessage))
      const internal = verdicts.filter(verdict => verdict.internal)
      if (internal.length) {
        const message = `clm stepped: judge internal error issue=${active.id}; stop released: ${internal.map(item => `${item.id} ${item.reason}`).join('; ')}`
        $.ui.log(message)
        $.ui.log(message, { to: 'debug' })
        return undefined
      }
      const failed = verdicts.filter(verdict => !verdict.pass)
      if (failed.length === 0) {
        await append($, [{ op: 'attempt', issue: active.id, method, verdict: 'pass' }], origin)
        const sha = await checkpointCommit({ run: (argv, options) => $.process.run([...argv], options) }, root.worktree, active.title)
        await append($, [
          { op: 'checkpoint', issue: active.id, sha },
          { op: 'status', issue: active.id, status: 'done' },
        ], origin)
        const afterEvents = await readAll($)
        const afterIssues = snapshot(afterEvents).filter(issue => issue.origin.session === origin.session)
        const nextStep = afterIssues.find(issue => issue.parent === root.id && issue.status !== 'done' && issue.status !== 'dropped')
        if (nextStep) return {
          block: `Step done: ${active.title} [${active.id}]. Next step: ${nextStep.title} [${nextStep.id}]. Start it with clm_task status "doing" and declare its method. ${STEPPED_WORKTREE_CONTEXT(root.worktree)}`,
        }
        return land(afterIssues.find(issue => issue.id === root.id) ?? root)
      }

      const reason = failed.map(item => `${item.id}: ${item.reason}`).join('\n')
      await append($, [{ op: 'attempt', issue: active.id, method, verdict: 'fail' }], origin)
      const afterAttempt = snapshot(await readAll($)).find(issue => issue.id === active.id)
      if (!afterAttempt) throw new Error(`tracker snapshot lost issue ${active.id} after a failed attempt`)
      const state = attemptState(afterAttempt)
      if (state.rollback) {
        const latestRoot = snapshot(await readAll($)).find(issue => issue.id === root.id) ?? root
        const latestWorktree = latestRoot.worktree
        if (!latestWorktree) throw new Error(`tracker snapshot lost worktree for issue ${root.id}`)
        const rollbackSha = latestWorktree.headSha || latestWorktree.baseSha
        await rollbackTo({ run: (argv, options) => $.process.run([...argv], options) }, latestWorktree, rollbackSha)
        await append($, [{ op: 'method', issue: active.id, text: method, failed: true }], origin)
        const failedIssue = snapshot(await readAll($)).find(issue => issue.id === active.id) ?? afterAttempt
        const failedMethods = failedMethodNames(failedIssue)
        if (attemptState(failedIssue).stop) {
          const message = `clm stepped: goal ${root.id} stopped after five failed methodologies on issue ${active.id}: ${failedMethods.slice(-5).join('; ')}`
          $.ui.log(message)
          $.ui.log(message, { to: 'debug' })
          return undefined
        }
        return {
          block: `The rubric failed for issue ${active.id}:\n${reason}\nThe worktree was rolled back to ${rollbackSha}. Failed methodologies: ${failedMethods.join('; ')}. Declare a different method with clm_task before continuing.`,
        }
      }
      return { block: `The rubric failed for issue ${active.id}:\n${reason}\nContinue the step, then stop for another check. The current method is ${method}.` }
    }

    if (children.length && children.every(issue => issue.status === 'done' || issue.status === 'dropped')) return land(root)
    return undefined
  } catch (error) {
    return failOpen('internal tracker or git operation', error)
  }
}
const clmStatusIo = ($: StatusReader) => ({
  readWorkflow: () => readWorkflow($), readMeta: () => readMeta($), readAll: () => readAll($),
  sessionId: () => $.session.id(), ledgerPath: () => ledgerPath($), storeGet: (key: string) => sessionStoreGet($, key),
})
const syncPanelSafely = ($: EngineInterface, origin: Origin, events: readonly TrackerEvent[]) => syncPanelDomain(panelIo($), origin, events)
const projectPanel = ($: EngineInterface, origin: Origin, events: readonly TrackerEvent[]) => panelIo($).serialize(origin.session, () => syncPanelSafely($, origin, events))
export const sessionIssues = ($: EngineInterface, query: { issue?: string; status?: Issue['status'] } = {}) => panelIssues(panelIo($), query)
export const clmStatus = ($: StatusReader) => panelStatus(clmStatusIo($))
export const trackIssue = ($: EngineInterface, input: { title: string; status: Issue['status']; issue?: string }) => trackPanelIssue(panelIo($), input)
export { isHeld, type Held }

const heldIo = ($: EngineInterface): HeldIo => ({
  now: () => $.clock.now(),
  get: key => sessionStoreGet($, key),
  set: (key, value) => sessionStoreSet($, key, value),
  delete: key => sessionStoreDelete($, key),
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
  clauseStore: async key => readClauseStore(await sessionStoreGet($, clauseStoreKey(key))) ?? emptyClauseStore(),
  addressRows: key => addressRows(addressIo($), key),
  nowIso: () => nowIso($),
  readLegacyTopics: (notes, seq, key) => readLegacyTopics($, notes, seq, key),
  ledgerPath: () => ledgerPath($),
  topics: async key => sessionStoreGet($, await topicsKey($, key)),
  usageReading: () => usageReading($),
  sentAt: () => sentAt($),
  complete: request => $.model.complete(request),
  logEvent: (event, fields) => logEvent($, event, fields),
  log: (text, options) => $.ui.log(text, options),
})
const fold = ($: EngineInterface, opts: Opts, rows: readonly SessionMessage[], meta: Meta, mustFold: boolean, reading?: number, calibrate = true, prepared?: PreparedFold, transcript?: string) =>
  runFold(foldRuntimeIo($), opts, rows, meta, mustFold, reading, calibrate, prepared, transcript)
const trackerView = ($: EngineInterface, origin: Origin, ops: readonly Payload[] = []) =>
  trackerViewDomain({ readAll: () => readAll($) }, origin, ops)

const addressIo = ($: EngineInterface): AddressIo => ({ get: key => sessionStoreGet($, key), set: (key, value) => sessionStoreSet($, key, value) })
const sentAt = async ($: EngineInterface): Promise<SentAt> => sentAtOf(addressIo($), transcriptKey(await sid($)))
const nowIso = async ($: EngineInterface) => new Date(await $.clock.now()).toISOString()

async function readRequests($: EngineInterface, key: string): Promise<RequestRecord[]> {
  const value = await sessionStoreGet($, requestsKey(key))
  return Array.isArray(value) ? value.filter(isRequestRecord) : []
}

async function readLegacyTopics($: EngineInterface, notes: string, seq: number, key?: string): Promise<Topic[]> {
  const resolvedKey = key ?? transcriptKey(await sid($))
  return readLegacyTopicsDomain({ topics: async target => sessionStoreGet($, await topicsKey($, target)) }, notes, seq, resolvedKey)
}

const residentIo = ($: EngineInterface): ResidentIo => ({
  get: key => sessionStoreGet($, key),
  set: (key, value) => sessionStoreSet($, key, value),
  log: (text, options) => $.ui.log(text, options),
  readLedger: async () => readText($, await ledgerPath($)),
  readMeta: () => readMeta($),
  readLegacyTopics: (notes, seq, key) => readLegacyTopics($, notes, seq, key),
  readRequests: key => readRequests($, key),
})
const residentLedger = ($: EngineInterface, key: string, issues: readonly Issue[], state: { stack: string[]; pending: string[] }, events: readonly TrackerEvent[], preview: { notes?: string; topics?: TopicState[]; issues?: Issue[]; state?: { stack: string[]; pending: string[] }; clauses?: import('./clauses').ClauseStore } = {}) =>
  renderResidentLedger(residentIo($), key, issues, state, events, preview)

const intentIo = ($: EngineInterface): PromptIntentIo => ({
  captureOrigin: () => captureOrigin($),
  readAll: () => readAll($),
  readWorkflow: () => readWorkflow($),
  changeWorkflow: change => changeWorkflow($, change),
  sessionMessages: () => $.session.messages(),
  complete: request => $.model.complete(request),
  get: key => sessionStoreGet($, key),
  set: (key, value) => sessionStoreSet($, key, value),
  writeEvents: (payloads, origin) => writeEvents($, payloads, origin),
  serialize: (session, run) => serialized(session, run),
  syncPanel: (origin, events) => syncPanelSafely($, origin, events),
  log: (text, options) => $.ui.log(text, options),
  logEvent: (event, fields) => logEvent($, event, fields),
})
const recordPromptIntent = async ($: EngineInterface, text: string, promptSeq: number, address?: string) => {
  const coworker = coworkerIntent(await sid($))
  return classifyPrompt({ ...intentIo($), ...coworker }, text, promptSeq, address)
}

/** Options resolved against the live context window, so the threshold point follows the model in use. */
async function liveOpts($: EngineInterface, options: Record<string, unknown>): Promise<Opts> {
  const window = await Promise.resolve().then(() => $.session.usage()).then(usage => usage.context.window, () => undefined)
  const prefix = await readMeta($).then(meta => meta.overhead, () => undefined)
  return readOpts(options, window, prefix).opts
}
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
  storeGet: key => sessionStoreGet($, key),
  storeSet: (key, value) => sessionStoreSet($, key, value),
  storeDelete: key => sessionStoreDelete($, key),
  serialize: (session, run) => serialized(session, run),
  writeFile: (path, text) => $.fs.write(path, text),
  ledgerPath: () => ledgerPath($),
  topicsKey: key => topicsKey($, key),
  pendingKey: key => pendingKey($, key),
  readMeta: () => readMeta($),
  writeMeta: value => writeMeta($, value),
  readyFoldDropFps: key => foldJobDropFps(key),
  clearReadyFold: async key => {
    clearFoldJob(key)
    await sessionStoreDelete($, await pendingKey($, key))
  },
  setRewindReady: (key, plan, fingerprints) => setRewindFoldJob(key, plan, fingerprints),
  logEvent: fields => logEvent($, 'rewind', fields),
  log: text => $.ui.log(text, { to: 'debug' }),
})

const foldJobIo = ($: EngineInterface, loadedFromPath?: string): FoldJobIo => ({
  loadedFrom: loadedFromPath,
  sessionId: () => $.session.id(),
  sessionMessages: () => $.session.messages(),
  stableAttachments: headKept => stableAttachmentRows($, headKept),
  markStableAttachmentsCarried: (seq, rows, headKept) => markStableAttachmentsCarried($, seq, rows, headKept),
  sessionCompact: () => $.session.compact({}),
  now: () => $.clock.now(),
  after: (ms, fn) => $.clock.after(ms, fn),
  usageReading: () => usageReading($),
  sentAt: () => sentAt($),
  readMeta: () => readMeta($),
  writeMeta: meta => writeMeta($, meta),
  readLedger: async () => readText($, await ledgerPath($)),
  ledgerPath: () => ledgerPath($),
  basePath: () => basePath($),
  readFile: async path => readText($, path),
  writeFile: (path, text) => $.fs.write(path, text),
  appendFile: async (path, text) => {
    await $.process.run(['mkdir', '-p', '--', path.slice(0, path.lastIndexOf('/'))], { timeoutMs: 5000 })
    await $.fs.write(path, ((await readText($, path)) ?? '') + text)
  },
  lessonsPath: async () => `${(await $.env.get('HOME')) ?? '.'}/.dotfiles/.lessons/lessons.jsonl`,
  fileExists: path => $.fs.exists(path),
  fileList: path => $.fs.list(path),
  run: (args, options) => $.process.run(args, options),
  storeGet: key => sessionStoreGet($, key),
  storeSet: (key, value) => sessionStoreSet($, key, value),
  storeDelete: key => sessionStoreDelete($, key),
  serialize: (session, run) => serialized(session, run),
  pendingKey: key => pendingKey($, key),
  topicsKey: key => topicsKey($, key),
  captureOrigin: () => captureOrigin($),
  readAll: () => readAll($),
  trackerView: (origin, ops) => trackerView($, origin, ops),
  updateHeld: (settled, hold) => updateHeld($, settled, hold),
  backfillClauses: key => backfillClausesChained(intentIo($), key.split(':', 1)[0] ?? key, key),
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
  'That row carries the goal, live user instructions as plaintext clauses with C-ids, what was done, what is left, open questions and key facts. An engine summary is followed by a "[clm clauses]" row with the same live instructions. The turns they replaced are gone.',
  'Use it as your memory of that work, and re-query any PR, branch, deploy or ticket state before acting on it or reporting it.',
  'Describe task changes in the conversation; clm records them in the tracker and task panel.',
].join('\n')

export const register: Register = (on, options) => {
  const forceCompacts = new Set<string>()
  const { problems } = readOpts(options as Record<string, unknown>)
  const userOptions = options as Record<string, unknown>
  let loadedFromPath: string | undefined
  const warnedStaleSessions = new Set<string>()

  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    try { loadedFromPath ??= await resolveInstalledMod($) }
    catch (error) { await logModLocationFailure($, loadedFromPath, error) }
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
    if (e.agentId === undefined) {
      if (sessionStateMigrationFailed) {
        sessionStateMigration = undefined
        sessionStateMigrationFailed = false
      }
      await ensureSessionStateMigration($)
      const session = await $.session.id()
      await clearStableAttachmentSession($, session)
    }
    for (const p of problems) $.ui.log(`clm: option ${p}`)
    try {
      await $.tool.register({
        name: 'clm_recall',
        description: 'Read original transcript rows by address @xxxxxxxx or an ancestor range @first..@last; read one stored instruction with #C12 or all stored instructions with clauses. Includes folded and rewound history.',
        inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'], additionalProperties: false },
      })
    } catch (err) {
      $.ui.log(`clm: clm_recall registration failed (${String(err).slice(0, 120)})`, { to: 'debug' })
    }
    try {
      await $.tool.register({
        name: 'clm_task',
        description: 'Update a task you are working on: mark it todo to record a planned step, doing when you start (declare the method you will use), done when you finish it (add evidence with the row and a verbatim quote when one shows the result), or dropped when the user abandons it, citing that user message. Create a child task for a sub-step you will do yourself.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done', 'dropped'] },
            method: { type: 'string', description: 'The current approach for a stepped goal task; use a short distinct description.' },
            note: { type: 'string' }, evidence: { type: 'object', properties: { ref: { type: 'string', description: '"user" for a user message (clm finds the row by the quote), a row ref such as m3, or a tool_use id.' }, quote: { type: 'string', description: 'At least four words, or eight Korean characters, copied verbatim from that row.' } }, required: ['ref', 'quote'], additionalProperties: false },
          },
          required: ['status'], additionalProperties: false,
        },
      })
    } catch (err) {
      $.ui.log(`clm: clm_task registration failed (${String(err).slice(0, 120)})`, { to: 'debug' })
    }
    await $.command.register({
      name: 'clm',
      description: 'Show the clm ledger, budget use and recent decisions; `board` opens the issue board, while `clm_coworker` plans, claims, hands back, lands, reassigns, lists, and messages shared board work.',
      immediate: true,
    })
    await $.command.register({ name: 'force-compact', description: 'Compact once with Claude Code\'s own summarizer instead of the clm fold; text after it becomes the summary instructions.', immediate: true })
    return next(e)
  })

  // The host refuses a compaction from inside command.run, so it runs once the command has returned.
  on('command.run', { command: 'force-compact' }, async ($, e) => {
    const key = transcriptKey(await sid($))
    const instructions = e.args.trim()
    $.clock.after(0, async () => {
      forceCompacts.add(key)
      try {
        const result = await $.session.compact(instructions ? { instructions } : {})
        if (result.skip !== undefined) $.ui.log(`clm: force-compact skipped (${result.skip})`)
        await adoptEngineSummary(foldJobIo($), key, result.messages)
      } catch (err) {
        $.ui.log(`clm: force-compact failed (${String(err).slice(0, 160)})`)
      } finally { forceCompacts.delete(key) }
    })
    return {}
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
    $.ui.log(foldJobReport(rows.findLast(isLedgerRow)?.text ?? await readText($, await ledgerPath($)), rows, await liveOpts($, userOptions), meta, log))
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
        try { await closeAgentTaskRoot(panelIo($), await sid($), e.agentId, e.reason === 'answer' ? 'done' : 'dropped') }
        catch (err) { $.ui.log(`clm: could not clear task root for agent ${e.agentId}: ${String(err).slice(0, 120)}`, { to: 'debug' }) }
      }
    }
    const res = await next(e)
    try { await stampMessages(addressIo($), transcriptKey(await sid($)), await $.session.messages(), await nowIso($)) }
    catch (err) { $.ui.log(`clm: could not stamp turn rows (${String(err).slice(0, 160)})`, { to: 'debug' }) }
    await completeMainTurn(mainTurnCompletionIo($, await liveOpts($, userOptions)), e.turnId, e.isAborted, e.answer)
    return res
  })

  // The engine and the turn-end check share one per-transcript job.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const result = await next(e)
      return Array.isArray(e.messages) && 'messages' in result && result.messages ? { ...result, messages: keepSpawnReminders(e.messages, result.messages) } : result
    }
    if (e.trigger === 'plugin' && forceCompacts.delete(transcriptKey(await sid($)))) {
      const key = transcriptKey(await sid($))
      return handOffFoldJob(foldJobIo($, loadedFromPath), key, () => next(e), 'force-compact requested')
    }
    if (e.trigger === 'precompute') return { skip: 'clm replaces compaction' }
    if (loadedFromPath !== undefined) {
      const loadedFrom = loadedFromPath
      void resolveInstalledMod($)
        .then(installedPath => detectStaleMod($, loadedFrom, installedPath, warnedStaleSessions))
        .catch(error => logModLocationFailure($, loadedFrom, error))
    }
    if (!Array.isArray(e.messages)) return next(e)
    return compactFoldJob(foldJobIo($, loadedFromPath), await liveOpts($, userOptions), e.messages, e.trigger, () => next(e))
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      void (async () => {
        // Read before the opts lookup: a check landing after a swap finished
        // would fold the pre-swap rows again, and clm's own task-panel calls
        // run inside that swap.
        if (!foldJobIdle(transcriptKey(await sid($)))) return
        await maybeClearFoldJob(foldJobIo($), await liveOpts($, userOptions), false)
      })().catch(err => $.ui.log(`clm: background fold check failed (${String(err).slice(0, 160)})`, { to: 'debug' }))
    }
    return next(e)
  })

  on('tool.call', { tool: RECALL_TOOL }, async ($, e) => recallAddress(addressIo($), transcriptKey(await sid($)), e.address))

  on('agent.spawn', async ($, e, next) => {
    const io = panelIo($)
    const origin = await captureOrigin($)
    const roots = await assignedTaskRoots(io, origin.session)
    const events = await readAll($)
    const parent = e.parentAgentId === undefined ? focusOf(events, origin.session).stack.at(-1) : roots[e.parentAgentId]
    if (!parent) return { deny: e.parentAgentId ? `clm: agent ${e.parentAgentId} needs an assigned task before spawning a child agent.` : SPAWN_PLAN_REQUEST }
    const issues = snapshot(events).filter(issue => issue.origin.session === origin.session)
    const steppedGoal = outermostSteppedRootOf(parent, new Map(issues.map(issue => [issue.id, issue])))
    const goal = steppedGoal && isOpen(steppedGoal) && !steppedGoal.landCommandsShown ? steppedGoal : undefined
    const activeStep = goal?.id === parent
      ? issues.filter(issue => issue.parent === goal.id && issue.status === 'doing').at(-1)
      : undefined
    const spawnInput = goal?.worktree
      ? { ...e, cwd: goal.worktree.dir, prompt: `${STEPPED_WORKTREE_CONTEXT(goal.worktree)}\n\n${e.prompt}` }
      : e
    const spawned = await next(spawnInput)
    if (!spawned.agentId) return spawned
    const planned = await plannedAgentStep(io, origin.session, parent, e.description)
    if (!planned || !await claimAgentTaskRoot(io, origin.session, spawned.agentId, planned))
      await createAgentTaskRoot(io, origin.session, spawned.agentId, activeStep?.id ?? parent, e.description || e.prompt)
    return spawned
  })
  on('tool.call', { tool: TASK_TOOL }, async ($, e) => {
    if (!isClmTaskInput(e)) return { deny: 'clm_task requires status and either an issue id or a new task title.' }
    const result = await runPanelTask(panelIo($), e, e.agentId)
    // A drop or done changes which board issues are ready for a co-worker.
    void coworkerIntent(await sid($))?.dispatch()
    return result
  })
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => (e.agentId !== undefined || next.origin.plugin === 'clm' ? next(e) : denyPanelTask({ mirrorModelTask: event => mirrorModelTask(panelIo($), event), log: (text, options) => $.ui.log(text, options) }, e)))
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => (e.agentId !== undefined || next.origin.plugin === 'clm' ? next(e) : denyPanelTask({ mirrorModelTask: event => mirrorModelTask(panelIo($), event), log: (text, options) => $.ui.log(text, options) }, e)))
  on('classic.Stop', async ($, e, next) => {
    const backgroundWorkers = e.background_tasks?.filter(task => task.type === 'subagent' || task.type === 'workflow') ?? []
    if (backgroundWorkers.length) {
      $.ui.log(`clm stepped: judge deferred; ${backgroundWorkers.length} background worker(s) running`, { to: 'debug' })
      return next(e)
    }
    const result = await handleSteppedStop($, e.last_assistant_message)
    if (result === undefined) return next(e)
    return { ...(await next(e)), ...result }
  })
  on('tool.describe', { tool: 'TaskCreate' }, ($, e) => ({ ...e, isDeferred: true }))
  on('tool.describe', { tool: 'TaskUpdate' }, ($, e) => ({ ...e, isDeferred: true }))
  on('prompt.attachment', { type: 'todo_reminder' }, () => ({ text: null }))
  on('prompt.attachment', async ($, e) => {
    if (e.agentId !== undefined) return
    if (isStableAttachmentType(e.type) && typeof e.text === 'string')
      return handleStableAttachment($, { type: e.type, text: e.text, origin: e.origin, detail: e.detail })
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const seq = ledgerRowSeq(e.props.text)
    if (e.props.isExpanded || e.props.from !== undefined || e.props.task !== undefined || seq === undefined) return next(e)
    const durationMs = (await readMeta($)).foldDurationsMs?.[seq]
    const text = durationMs === undefined ? '* clm compacted' : `* clm compacted in ${(durationMs / 1000).toFixed(1)} s`
    const { Text } = $.ui.resolve(e)
    return Text({ children: [text] })
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.includes('bare')) return r
    const sections = [...r.sections, { id: 'clm:guide', text: GUIDE, scope: 'session' as const }]
    try {
      // The intent job stays unawaited so the classifier never delays the main request; a focus change it makes reaches the next compose.
      const stepped = await steppedPromptContext(panelIo($))
      if (stepped) sections.push({ id: 'clm:stepped', text: stepped, scope: 'session' as const })
    } catch (err) {
      $.ui.log(`clm stepped: prompt context failed issue=unknown argv=[] exitCode=unavailable stderr=${JSON.stringify(String(err))}`, { to: 'debug' })
    }
    return { ...r, sections }
  })

  on('prompt.submit', async ($, e, next) => {
    let promptSeq: number | undefined
    let address: string | undefined
    if (isHumanOrigin(e.origin)) {
      try {
        const key = transcriptKey(await sid($))
        await observeTranscript(rewindIo($), key, await $.session.messages())
        await changeWorkflow($, current => ({ next: resetUserWorkflow(current, e.origin), result: undefined }))
        promptSeq = await stampHumanPrompt($)
        address = await recordPrompt(addressIo($), key, e.text, await nowIso($), promptSeq)
      } catch (err) {
        $.ui.log(`clm: prompt state update failed (${String(err).slice(0, 160)})`)
      }
    }
    if (promptSeq !== undefined) {
      void recordPromptIntent($, e.text, promptSeq, address).catch(err => {
        $.ui.log(`clm intent: classifier failed issue=unknown argv=[] exitCode=unavailable stderr=${JSON.stringify(String(err))}`, { to: 'debug' })
      })
    }
    return next(e)
  })

  on('session.end', { sessionId: /.*/ }, async ($, e, next) => {
    if (e.agentId === undefined) await clearStableAttachmentSession($, e.sessionId)
    return next(e)
  })

  registerResources(on, options)
  registerCoworkers(on, options)
}
