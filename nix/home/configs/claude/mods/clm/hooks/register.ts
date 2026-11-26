import { update, type EngineInterface, type Register } from 'claude-code'
import { append as appendEvents, captureOrigin as captureEventsOrigin, logEvent as writeLogEvent, readAll as readAllEvents, serialized as serializeEvents, writeEvents as writeTrackerEvents, type EventsIo, type LogEvent, type LogFields, type Payloads } from './events'
import { assignedTaskRoots, claimAgentTaskRoot, closeAgentTaskRoot, createAgentTaskRoot, plannedAgentStep, SPAWN_PLAN_REQUEST, STEPPED_WORKTREE_CONTEXT, clmStatus as panelStatus, denyModelTask as denyPanelTask, isClmTaskInput, mirrorModelTask, openBoard as openPanelBoard, planPromptContext, runClmTask as runPanelTask, runPanelCommand, sessionIssues as panelIssues, steppedPromptContext, syncPanelSafely as syncPanelDomain, trackIssue as trackPanelIssue, TASK_TOOL, type PanelIo } from './panel'
import { kst } from './text'
import { type Evidence, renderRange } from './evidence'
import { snapshot, focusOf, isOpen, isRecord, type Issue, type Origin, type Payload, type TrackerEvent } from './tracker'
import { attemptState, judgeRubric, outermostSteppedRootOf, type JudgeIo } from './stepped'
import { checkpointCommit, landCommands, rollbackTo, WorktreeError, type Worktree } from './worktree'
import { recordPromptIntent as classifyPrompt, type PromptIntentIo } from './intent'
import { arbitrateContinuation as arbitrateWorkflow, changeWorkflow as changeWorkflowDomain, completeMainTurn, isHumanOrigin, markActiveTurn, queueResume, readWorkflow as readWorkflowDomain, resetUserWorkflow, stampHumanPrompt as stampWorkflowPrompt, submitWithRecovery as recoverWorkflowSubmit, type MainTurnCompletionIo, type WorkflowIo, type WorkflowStateIo } from './workflow'
import type { ClmWorkflow } from '../types'

export { chooseContinuation, resetUserWorkflow, restoreFailedContinuation } from './workflow'

const WORKFLOW = { plugin: 'clm', key: 'workflow' } as const
export { TASK_TOOL }

type WorkflowReader = { state: { get: (ref: typeof WORKFLOW) => Promise<{ value: unknown }> } }
type SessionReader = { session: { id: () => Promise<string> } }
type StoreReader = SessionReader & {
  env: { get: (name: string) => Promise<string | undefined> }
  fs: {
    exists: (path: string) => Promise<boolean>
    list: (path: string) => Promise<{ name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }[]>
    read: (path: string) => Promise<string>
    write: (path: string, text: string) => Promise<void>
  }
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

// --- session state -------------------------------------------------------

const sid = ($: SessionReader) => $.session.id()

const SESSION_STORE_PREFIXES = new Set([
  'agent-task-roots', 'agent-task-step-claims', 'request-prompt-seq', 'requests', 'stepped', 'transcript-path',
])
const SESSION_STATE_MAX_BYTES = 4_194_304
const SESSION_STATE_MIGRATION_KEY = 'migrated:session-files:v1'
const sessionStateCache = new Map<string, { size: number; mtimeMs: number; bytes: number; state: Record<string, unknown> }>()
const sessionStateWrites = new Map<string, Promise<void>>()
let sessionStateMigration: Promise<void> | undefined
let sessionStateMigrationFailed = false

const utf8ByteLength = (text: string) => new TextEncoder().encode(text).length

function sessionStoreOwner(key: string): string | undefined {
  const separator = key.indexOf(':')
  if (separator < 0 || !SESSION_STORE_PREFIXES.has(key.slice(0, separator))) return
  const session = key.slice(separator + 1).split(':', 1)[0]
  return session || undefined
}

async function sessionStatePath($: HomeReader, session: string): Promise<string> {
  return `${await sessionBasePath($, session)}.state.json`
}

async function sessionStateEntry($: StoreReader, path: string) {
  const separator = path.lastIndexOf('/')
  const directory = separator < 0 ? '.' : path.slice(0, separator)
  const name = path.slice(separator + 1)
  try { return (await $.fs.list(directory)).find(entry => entry.kind === 'file' && entry.name === name) }
  catch { return undefined }
}

async function readSessionState($: StoreReader, session: string, enforceLimit = true): Promise<Record<string, unknown>> {
  const path = await sessionStatePath($, session)
  if (!(await $.fs.exists(path))) {
    sessionStateCache.delete(path)
    return {}
  }
  const entry = await sessionStateEntry($, path)
  const cached = sessionStateCache.get(path)
  if (entry && cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs) {
    if (enforceLimit && cached.bytes > SESSION_STATE_MAX_BYTES) throw new Error(`clm: session state exceeds ${SESSION_STATE_MAX_BYTES} bytes`)
    return { ...cached.state }
  }
  const text = await $.fs.read(path)
  const bytes = utf8ByteLength(text)
  if (enforceLimit && bytes > SESSION_STATE_MAX_BYTES) throw new Error(`clm: session state exceeds ${SESSION_STATE_MAX_BYTES} bytes`)
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) { return recoverSessionState($, session, path, text, `invalid JSON (${String(error).slice(0, 300)})`) }
  if (!isRecord(value)) return recoverSessionState($, session, path, text, 'state file is not an object')
  if (entry) {
    sessionStateCache.clear()
    sessionStateCache.set(path, { size: entry.size, mtimeMs: entry.mtimeMs, bytes, state: value })
  }
  return { ...value }
}

async function recoverSessionState($: StoreReader, session: string, path: string, text: string, problem: string): Promise<Record<string, unknown>> {
  sessionStateCache.delete(path)
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
  return serializeSessionState(session, async () => structuredClone((await readSessionState($, session))[key]))
}

async function writeSessionState($: StoreWriter, session: string, state: Record<string, unknown>, droppedKey?: string): Promise<void> {
  const text = JSON.stringify(state)
  const bytes = utf8ByteLength(text)
  if (bytes > SESSION_STATE_MAX_BYTES) {
    await logEvent($, 'session-state-migration', { reason: `session state write for ${session} exceeded ${SESSION_STATE_MAX_BYTES} bytes; dropped ${droppedKey ?? 'updated state'}` })
    return
  }
  const path = await sessionStatePath($, session)
  await $.fs.write(path, text)
  const entry = await sessionStateEntry($, path)
  if (entry) {
    sessionStateCache.clear()
    sessionStateCache.set(path, { size: entry.size, mtimeMs: entry.mtimeMs, bytes, state: { ...state } })
  }
  else sessionStateCache.delete(path)
}

async function sessionStoreSet($: StoreWriter, key: string, value: unknown): Promise<void> {
  const session = sessionStoreOwner(key)
  if (!session) return $.store.set(key, value)
  await ensureSessionStateMigration($)
  await serializeSessionState(session, async () => {
    const state = await readSessionState($, session)
    state[key] = structuredClone(value)
    await writeSessionState($, session, state, key)
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
        if (utf8ByteLength(text) > SESSION_STATE_MAX_BYTES) {
          dropped.push(...keys.filter(key => !Object.prototype.hasOwnProperty.call(state, key)))
          await report(`session state for ${session} already exceeds ${SESSION_STATE_MAX_BYTES} bytes; dropped ${dropped.length} legacy key(s)`)
        }
        else {
          for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(state, key)) continue
            const value = await $.store.get(key)
            if (value === undefined) continue
            const candidate = { ...state, [key]: value }
            const candidateText = JSON.stringify(candidate)
            if (utf8ByteLength(candidateText) > SESSION_STATE_MAX_BYTES) {
              dropped.push(key)
              continue
            }
            state[key] = value
            text = candidateText
          }
        }
        if (dropped.length && utf8ByteLength(text) <= SESSION_STATE_MAX_BYTES) {
          await report(`session state for ${session} exceeded ${SESSION_STATE_MAX_BYTES} bytes; dropped ${dropped.length} legacy key(s): ${dropped.slice(0, 12).join(', ')}`)
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


async function sessionBasePath($: HomeReader, session: string): Promise<string> {
  const home = await $.env.get('HOME')
  return `${home ?? '.'}/.claude-work/plans/clm-${session}`
}
async function basePath($: HomeReader): Promise<string> { return sessionBasePath($, await sid($)) }
const logPath = async ($: HomeReader) => `${await basePath($)}.log.jsonl`

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
        const previousSha = root.worktree.headSha
        const sha = await checkpointCommit({ run: (argv, options) => $.process.run([...argv], options) }, root.worktree, active.title)
        if (!active.result) {
          const diff = await $.process.run(['git', '-C', root.worktree.dir, 'diff', '--name-only', previousSha, sha], { timeoutMs: 30_000 })
          const files = diff.exitCode === 0 ? diff.stdout.split(/\r?\n/).map(file => file.trim()).filter(Boolean).slice(0, 5) : []
          await append($, [{
            op: 'result', issue: active.id, intent: active.title.slice(0, 160),
            finding: verdicts.map(verdict => `${verdict.id}: ${verdict.reason}`).join('; ').replace(/\s+/g, ' ').trim().slice(0, 160),
            decision: `checkpoint ${sha.slice(0, 8)}`, files, source: 'judge',
          }], origin)
        }
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
  readWorkflow: () => readWorkflow($), readAll: () => readAll($),
  sessionId: () => $.session.id(), storeGet: (key: string) => sessionStoreGet($, key),
})
const syncPanelSafely = ($: EngineInterface, origin: Origin, events: readonly TrackerEvent[]) => syncPanelDomain(panelIo($), origin, events)
export const sessionIssues = ($: EngineInterface, query: { issue?: string; status?: Issue['status'] } = {}) => panelIssues(panelIo($), query)
export const clmStatus = ($: StatusReader) => panelStatus(clmStatusIo($))
export const trackIssue = ($: EngineInterface, input: { title: string; status: Issue['status']; issue?: string }) => trackPanelIssue(panelIo($), input)

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
const recordPromptIntent = async ($: EngineInterface, text: string, promptSeq: number) => classifyPrompt(intentIo($), text, promptSeq)

const workflowIo = ($: EngineInterface): WorkflowIo => ({
  read: () => readWorkflow($),
  change: change => changeWorkflow($, change),
  submit: input => $.prompt.submit(input),
  log: message => $.ui.log(message),
})
const stampHumanPrompt = ($: EngineInterface) => stampWorkflowPrompt(workflowIo($))
export const submitWithRecovery = recoverWorkflowSubmit

const mainTurnCompletionIo = ($: EngineInterface): MainTurnCompletionIo => ({
  arbitrate: turnId => arbitrateWorkflow(workflowIo($), turnId),
  clearActiveTurn: turnId => changeWorkflow($, current => ({
    next: current.activeTurnId === turnId ? { ...current, activeTurnId: null } : current,
    result: undefined,
  })),
  log: message => $.ui.log(message, { to: 'debug' }),
})

// clm-prompt
const GUIDE = 'Describe task changes in the conversation; clm records them in the tracker and task panel.'

export const register: Register = (on, options) => {

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
    if (e.agentId === undefined) {
      if (sessionStateMigrationFailed) {
        sessionStateMigration = undefined
        sessionStateMigrationFailed = false
      }
      await ensureSessionStateMigration($)
    }
    try {
      await $.tool.register({
        name: 'clm_task',
        description: 'Update a task you are working on: record its ordered plan in one todo call with plan (2-8 short titles), mark a step doing when you start (declare the method you will use), done when you finish it (add evidence with the row and a verbatim quote when one shows the result), or dropped when the user abandons it, citing that user message. A dropped issue is a rejected assumption; a done issue with result is a merged assumption. Set hypothesis true while creating a todo or doing issue to name it explicitly as a hypothesis. When you finish a planned step, mark it done with result {intent, finding, decision, files}: one clause each for what you set out to do, what you found, and what you decided or changed, plus up to five file paths you touched or relied on. To close any other open board issue, such as a deferred todo, pass its id with done or dropped directly; your focus stays where it is. Create a child task for a sub-step you will do yourself.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done', 'dropped'] },
            method: { type: 'string', description: 'The current approach for a stepped goal task; use a short distinct description.' },
            plan: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string', maxLength: 120 }, description: 'Ordered short step titles for the focused task.' },
            result: { type: 'object', properties: { intent: { type: 'string', maxLength: 160 }, finding: { type: 'string', maxLength: 160 }, decision: { type: 'string', maxLength: 160 }, files: { type: 'array', maxItems: 5, items: { type: 'string' } } }, required: ['intent', 'finding', 'decision'], additionalProperties: false },
            note: { type: 'string' }, hypothesis: { type: 'boolean', description: 'Mark a newly created todo or doing issue as an explicit hypothesis.' }, evidence: { type: 'object', properties: { ref: { type: 'string', description: '"user" for a user message (clm finds the row by the quote), a row ref such as m3, or a tool_use id.' }, quote: { type: 'string', description: 'At least four words, or eight Korean characters, copied verbatim from that row.' } }, required: ['ref', 'quote'], additionalProperties: false },
          },
          required: ['status'], additionalProperties: false,
        },
      })
    } catch (err) {
      $.ui.log(`clm: clm_task registration failed (${String(err).slice(0, 120)})`, { to: 'debug' })
    }
    await $.command.register({
      name: 'clm',
      description: 'List the open clm issues; `board` opens the issue board.',
      immediate: true,
    })
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
    const open = (await sessionIssues($)).filter(isOpen)
    $.ui.log(open.length ? open.map(issue => `clm: ${issue.id} [${issue.status}] ${issue.title}`).join('\n') : 'clm: no open issues; /clm board opens the board')
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
    await completeMainTurn(mainTurnCompletionIo($), e.turnId, e.isAborted)
    return res
  })

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
    const toolUseId = e.tool_use_id
    const result = await runPanelTask(panelIo($), e, e.agentId, toolUseId)
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
    try {
      const plan = await planPromptContext(panelIo($))
      if (plan) sections.push({ id: 'clm:plan', text: plan, scope: 'session' as const })
    } catch (err) {
      $.ui.log(`clm plan: prompt context failed issue=unknown argv=[] exitCode=unavailable stderr=${JSON.stringify(String(err))}`, { to: 'debug' })
    }
    return { ...r, sections }
  })

  on('prompt.submit', async ($, e, next) => {
    let promptSeq: number | undefined
    if (isHumanOrigin(e.origin)) {
      try {
        await changeWorkflow($, current => ({ next: resetUserWorkflow(current, e.origin), result: undefined }))
        promptSeq = await stampHumanPrompt($)
      } catch (err) {
        $.ui.log(`clm: prompt state update failed (${String(err).slice(0, 160)})`)
      }
    }
    if (promptSeq !== undefined) {
      void recordPromptIntent($, e.text, promptSeq).catch(err => {
        $.ui.log(`clm intent: classifier failed issue=unknown argv=[] exitCode=unavailable stderr=${JSON.stringify(String(err))}`, { to: 'debug' })
      })
    }
    return next(e)
  })

}
