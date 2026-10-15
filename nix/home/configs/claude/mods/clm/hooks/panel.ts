import type { BuiltinToolInputs } from 'claude-code'
import type { ClmStatus, ClmTaskInput, ClmWorkflow } from '../types'
import { boardHtml } from './board'
import { checkEvidence, describeOp, renderRange, type Evidence, type Source } from './evidence'
import { compose } from './intent'
import { archivedDone, focusOf, injected, isOpen, issueId, snapshot, type Issue, type Origin, type Payload, type TrackerEvent } from './tracker'
import type { FocusState } from './tracker'

export const TASK_TOOL = 'mcp__clm__clm_task'

type ModelTaskCall =
  | ({ tool: 'TaskCreate' } & BuiltinToolInputs['TaskCreate'])
  | ({ tool: 'TaskUpdate' } & BuiltinToolInputs['TaskUpdate'])
type Mirrored = { recorded: Issue[]; unrecorded: string[] } | { unknownTask: string }
type TaskToolCall =
  | { tool: 'TaskCreate'; subject: string; description: string }
  | { tool: 'TaskUpdate'; taskId: string; subject: string; description: string; status: 'pending' | 'in_progress' | 'completed' | 'deleted' }

export type PanelIo = {
  captureOrigin: () => Promise<Origin>
  readAll: () => Promise<TrackerEvent[]>
  append: (payloads: readonly Payload[], origin?: Origin, project?: boolean, knownTitles?: boolean) => Promise<TrackerEvent[]>
  writeEvents: (payloads: readonly Payload[], origin: Origin) => Promise<TrackerEvent[]>
  logEvent: (event: 'panel-relink', fields: { reason?: string }) => Promise<void>
  serialize: <T>(session: string, run: () => Promise<T>) => Promise<T>
  sessionId: () => Promise<string>
  sessionMessages: () => Promise<import('claude-code').SessionMessage[]>
  readWorkflow: () => Promise<ClmWorkflow>
  readMeta: () => Promise<{ lastFoldAt?: number }>
  ledgerPath: () => Promise<string>
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  toolCall: (input: TaskToolCall) => Promise<
    | { deny: string }
    | { isError: true; result?: { task?: { id?: string }; success?: boolean; error?: string } }
    | { isError?: false; result: { task?: { id?: string }; success?: boolean; error?: string } }
  >
  writeBoard: (path: string, html: string) => Promise<void>
  boardPath: () => Promise<string>
  open: (path: string) => Promise<{ exitCode: number; stderr: string }>
  now: () => string
  log: (text: string, options?: { to?: 'transcript' | 'debug' }) => void
}

const panelStatus: Record<Issue['status'], 'pending' | 'in_progress' | 'completed' | 'deleted'> = {
  todo: 'pending', doing: 'in_progress', done: 'completed', dropped: 'deleted', question: 'pending',
}
const taskStatus: Record<string, Issue['status'] | undefined> = {
  pending: 'todo', in_progress: 'doing', completed: 'done', deleted: 'dropped',
}
const panelSubject = (issue: Issue) => `${issue.status === 'question' ? '질문: ' : ''}${issue.title}${issue.progress ? ` (${issue.progress.done}/${issue.progress.total})` : ''}`
const panelDescription = (issue: Issue) => issue.notes.at(-1) ?? issue.title
const agentTaskRootsKey = (session: string) => `agent-task-roots:${session}`
const taskStatuses = new Set(['doing', 'done', 'uncertain', 'dropped'])
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function isClmTaskInput(value: unknown): value is ClmTaskInput {
  if (!isRecord(value)) return false
  const input = value
  if (!taskStatuses.has(String(input.status))) return false
  if (input.id !== undefined && typeof input.id !== 'string') return false
  if (input.title !== undefined && typeof input.title !== 'string') return false
  if (input.note !== undefined && typeof input.note !== 'string') return false
  return input.evidence === undefined || (isRecord(input.evidence)
    && typeof input.evidence.ref === 'string' && typeof input.evidence.quote === 'string')
}

export async function assignedTaskRoots(io: Pick<PanelIo, 'storeGet'>, session: string): Promise<Record<string, string>> {
  const value = await io.storeGet(agentTaskRootsKey(session))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

export async function assignAgentTaskRoot(io: Pick<PanelIo, 'storeGet' | 'storeSet'>, session: string, agentId: string, root: string): Promise<void> {
  const roots = await assignedTaskRoots(io, session)
  roots[agentId] = root
  await io.storeSet(agentTaskRootsKey(session), roots)
}

export async function sessionIssues(io: Pick<PanelIo, 'captureOrigin' | 'readAll'>, query: { issue?: string; status?: Issue['status'] } = {}): Promise<Issue[]> {
  const session = (await io.captureOrigin()).session
  return snapshot(await io.readAll()).filter(issue => issue.origin.session === session
    && (query.issue === undefined || issue.id === query.issue)
    && (query.status === undefined || issue.status === query.status))
}

export async function clmStatus(io: Pick<PanelIo, 'readWorkflow' | 'readMeta' | 'readAll' | 'sessionId' | 'ledgerPath'>): Promise<ClmStatus> {
  const [workflow, meta, events, session, path] = await Promise.all([
    io.readWorkflow(), io.readMeta(), io.readAll(), io.sessionId(), io.ledgerPath(),
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

export async function trackIssue(
  io: Pick<PanelIo, 'captureOrigin' | 'append' | 'readAll'>,
  input: { title: string; status: Issue['status']; issue?: string },
): Promise<Issue> {
  const origin = await io.captureOrigin()
  const currentIssues = async () => snapshot(await io.readAll())
  const getIssue = async (id: string) => (await currentIssues()).find(issue => issue.origin.session === origin.session && issue.id === id)
  if (input.issue !== undefined) {
    const before = await getIssue(input.issue)
    if (!before) throw new Error(`clm issue ${input.issue} does not belong to this session`)
    if (before.status !== input.status) await io.append([{ op: 'status', issue: input.issue, status: input.status }], origin)
    const updated = await getIssue(input.issue)
    if (!updated) throw new Error('clm tracker did not return the tracked issue')
    return updated
  }
  const title = input.title.trim()
  if (!title) throw new Error('clm issue title must not be empty')
  const events = await io.append([{ op: 'create', title, status: input.status }], origin)
  const issueId = events[0]?.issue
  const issue = issueId ? await getIssue(issueId) : undefined
  if (!issue) throw new Error('clm tracker did not return the tracked issue')
  return issue
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
const taskOwnerName = (owner: string | undefined) => owner === 'main' ? 'the main agent' : owner ? `subagent ${owner}` : 'no assigned task owner'

export async function runClmTask(io: PanelIo, input: ClmTaskInput, agentId?: string): Promise<{ result: string }> {
  const origin = await io.captureOrigin()
  const events = await io.readAll()
  const issues = snapshot(events).filter(issue => issue.origin.session === origin.session)
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const focus = focusOf(events, origin.session)
  const roots = await assignedTaskRoots(io, origin.session)
  const ownRoot = agentId ? roots[agentId] : focus.stack.at(-1)
  if (!ownRoot) return { result: agentId ? `clm_task: subagent ${agentId} has no task assigned by the harness.` : 'clm_task: the main agent has no focused task to own.' }
  const ownRootOwner = taskOwner(ownRoot, focus.stack, roots, byId)
  if (ownRootOwner !== (agentId ?? 'main')) return { result: `clm_task: ${ownRoot} belongs to ${taskOwnerName(ownRootOwner)}.` }
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
      const range = renderRange(await io.sessionMessages())
      const checked = checkEvidence([input.evidence], range.sources, ['tool_result'], true)
      if (!checked.held.length) reason = checked.problems.join('; ') || 'the evidence did not match this transcript.'
    }
    if (reason) status = 'uncertain'
  }
  let taskId = input.id
  const audit = status === 'done' && input.evidence ? `verified tool result ${input.evidence.ref}: ${input.evidence.quote}` : undefined
  const note = [input.note?.trim(), audit].filter((line): line is string => Boolean(line)).join('\n')
  if (taskId) {
    await io.append([{ op: 'status', issue: taskId, status }, ...(note ? [{ op: 'note' as const, issue: taskId, text: note }] : [])], origin)
  } else {
    const title = input.title?.trim()
    if (!title) return { result: 'clm_task: title must not be empty.' }
    const created = await io.append([{ op: 'create', title, status, ...(note ? { note } : {}) }], origin)
    taskId = created.find(event => event.op === 'create')?.issue
    if (!taskId) return { result: 'clm_task: task creation did not return an issue id.' }
    await io.append([{ op: 'parent', issue: taskId, parent: ownRoot }], origin)
  }
  if (taskId === focus.stack.at(-1) && (status === 'done' || status === 'dropped')) {
    const currentEvents = await io.readAll()
    const currentFocus = focusOf(currentEvents, origin.session)
    const currentIssues = snapshot(currentEvents).filter(issue => issue.origin.session === origin.session)
    const lastSeq = currentEvents.filter(event => event.origin.session === origin.session).reduce((n, event) => Math.max(n, event.seq), 0)
    const composed = compose(currentFocus, { intent: 'continue', target: null, title: null, rule: null, later: [], laterDrop: [] }, currentIssues, () => issueId(origin.session, lastSeq + 1))
    await io.append([{ op: 'focus', stack: composed.next.stack, pending: composed.next.pending, intent: 'continue' }], origin)
  }
  const current = await sessionIssues(io, { issue: taskId })
  const actualStatus = current[0]?.status ?? status
  return { result: `clm_task: ${taskId} ${actualStatus}${reason ? `; recorded as uncertain because ${reason}` : ''}.` }
}

export async function mirrorModelTask(io: Pick<PanelIo, 'captureOrigin' | 'readAll' | 'append'>, event: ModelTaskCall): Promise<Mirrored> {
  const origin = await io.captureOrigin()
  const issues = snapshot(await io.readAll())
  const byTask = (taskId: string) => issues.find(issue => issue.origin.session === origin.session && issue.taskId === taskId)
  const recordedAs = async (id: string | undefined, unrecorded: string[]): Promise<Mirrored> => {
    const after = id === undefined ? undefined : snapshot(await io.readAll()).find(issue => issue.id === id)
    return { recorded: after ? [after] : [], unrecorded }
  }
  if (event.tool === 'TaskCreate') {
    const title = event.subject.trim(), note = event.description.trim()
    if (!title) return { recorded: [], unrecorded: [] }
    const events = await io.append([{ op: 'create', title, status: 'todo', ...(note ? { note } : {}) }], origin)
    return recordedAs(events[0]?.issue, event.metadata ? ['metadata'] : [])
  }
  const issue = byTask(event.taskId)
  if (!issue) return { unknownTask: event.taskId }
  const status = event.status ? taskStatus[event.status] : undefined
  const named = (ids: readonly string[] | undefined) => (ids ?? []).map(id => byTask(id)?.id ?? `task ${id}`)
  const blockedBy = named(event.addBlockedBy), blocks = named(event.addBlocks)
  const subject = event.subject?.trim(), description = event.description?.trim()
  const ops: Payload[] = [
    ...(subject && subject !== issue.title ? [{ op: 'retitle' as const, issue: issue.id, title: subject }] : []),
    ...(description ? [{ op: 'note' as const, issue: issue.id, text: description }] : []),
    ...(blockedBy.length ? [{ op: 'note' as const, issue: issue.id, text: `blocked by ${blockedBy.join(', ')}` }] : []),
    ...(blocks.length ? [{ op: 'note' as const, issue: issue.id, text: `blocks ${blocks.join(', ')}` }] : []),
    ...(status ? [{ op: 'status' as const, issue: issue.id, status }] : []),
  ]
  await io.append(ops, origin)
  return recordedAs(issue.id, [...(event.owner ? ['owner'] : []), ...(event.metadata ? ['metadata'] : [])])
}

function mirrorDeny(mirrored: Mirrored): string {
  if ('unknownTask' in mirrored) return `clm 트래커에 작업 ${mirrored.unknownTask}이(가) 없다. 이 작업 변경은 답변 본문에 적어라; clm이 다음 정리 때 트래커에 옮긴다.`
  const lines = mirrored.recorded.map(issue => `clm이 트래커에 기록했다: ${issue.id} '${issue.title}' → ${issue.status}`)
  if (mirrored.unrecorded.length) lines.push(`${mirrored.unrecorded.join(', ')}은(는) 트래커에 칸이 없다. 필요하면 답변 본문에 적어라.`)
  return lines.length ? lines.join('\n') : '이 작업 변경은 답변 본문에 적어라; clm이 다음 정리 때 트래커에 옮긴다.'
}

export async function denyModelTask(io: Pick<PanelIo, 'mirrorModelTask' | 'log'>, event: ModelTaskCall): Promise<{ deny: string }> {
  try {
    return { deny: mirrorDeny(await io.mirrorModelTask(event)) }
  } catch (err) {
    io.log(`clm tracker: ${event.tool} mirror failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    return { deny: 'clm이 이 작업 변경을 기록하지 못했다. 변경 내용을 답변 본문에 적어라; clm이 다음 정리 때 트래커에 옮긴다.' }
  }
}

async function createTask(io: Pick<PanelIo, 'toolCall'>, issue: Issue): Promise<string> {
  const result = await io.toolCall({ tool: 'TaskCreate', subject: panelSubject(issue), description: panelDescription(issue) })
  if ('deny' in result || result.isError) throw new Error('TaskCreate was refused')
  const id = result.result.task?.id
  if (!id) throw new Error('TaskCreate returned no task id')
  return id
}
async function updateTask(io: Pick<PanelIo, 'toolCall'>, taskId: string, issue: Issue, status = panelStatus[issue.status]): Promise<void> {
  const result = await io.toolCall({ tool: 'TaskUpdate', taskId, subject: panelSubject(issue), description: panelDescription(issue), status })
  if ('deny' in result || result.isError) throw new Error('TaskUpdate was refused')
  if (!result.result.success) throw new Error(`TaskUpdate failed: ${result.result.error ?? 'success: false'}`)
}

export async function syncPanel(io: PanelIo, origin: Origin, events: readonly TrackerEvent[]): Promise<void> {
  const all = await io.readAll()
  const fresh = new Set(events.map(event => event.seq))
  const issues = snapshot(all).filter(issue => issue.origin.session === origin.session)
  const archived = archivedDone(issues, origin.session)
  const archivedBefore = archivedDone(snapshot(all.filter(event => event.origin.session !== origin.session || !fresh.has(event.seq))), origin.session)
  const touched = new Set([
    ...events.map(event => event.issue),
    ...[...archived].filter(id => !archivedBefore.has(id)),
    ...[...archivedBefore].filter(id => !archived.has(id)),
  ])
  const statusFor = (issue: Issue) => archived.has(issue.id) ? 'deleted' : panelStatus[issue.status]
  const links: Payload[] = []
  for (const issue of issues) {
    if (issue.taskId ? !touched.has(issue.id) || (archived.has(issue.id) && archivedBefore.has(issue.id)) : statusFor(issue) === 'deleted') continue
    try {
      let taskId = issue.taskId
      if (!taskId) {
        taskId = await createTask(io, issue)
        links.push({ op: 'task', issue: issue.id, taskId })
      } else {
        try {
          await updateTask(io, taskId, issue, statusFor(issue))
        } catch (err) {
          const oldTaskId = taskId
          taskId = await createTask(io, issue)
          links.push({ op: 'task', issue: issue.id, taskId })
          await io.logEvent('panel-relink', { reason: issue.id + ': ' + oldTaskId + ' -> ' + taskId + ' (' + String(err).slice(0, 120) + ')' })
          if (statusFor(issue) !== 'pending') await updateTask(io, taskId, issue, statusFor(issue))
        }
      }
      if (!issue.taskId && statusFor(issue) !== 'pending') await updateTask(io, taskId, issue, statusFor(issue))
    } catch (err) {
      io.log(`clm task panel: ${issue.id} not projected (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
  }
  if (links.length) await io.writeEvents(links, origin)
}

export async function syncPanelSafely(io: PanelIo, origin: Origin, events: readonly TrackerEvent[]): Promise<void> {
  try {
    if (origin.session === await io.sessionId()) await syncPanel(io, origin, events)
  } catch (err) {
    io.log(`clm task panel: projection failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}
export const projectPanel = (io: PanelIo, origin: Origin, events: readonly TrackerEvent[]) =>
  io.serialize(origin.session, () => syncPanelSafely(io, origin, events))

export async function openBoard(io: Pick<PanelIo, 'readAll' | 'captureOrigin' | 'boardPath' | 'writeBoard' | 'open' | 'now' | 'log'>): Promise<void> {
  const [events, here] = await Promise.all([io.readAll(), io.captureOrigin()])
  const issues = snapshot(events).map(issue => ({
    id: issue.id, title: issue.title, status: issue.status, repo: issue.origin.repo, ...(issue.origin.branch ? { branch: issue.origin.branch } : {}), updated: issue.updated,
  }))
  const path = await io.boardPath()
  await io.writeBoard(path, boardHtml(issues, here.repo, io.now()))
  const result = await io.open(path)
  if (result.exitCode !== 0) io.log(`clm: could not open the board at ${path} (exit ${result.exitCode}: ${result.stderr.slice(0, 160)})`)
  else io.log(`clm: board opened (${path})`)
}

export type PanelCommandIo = {
  readAll(): Promise<TrackerEvent[]>
  append(payloads: readonly Payload[]): Promise<TrackerEvent[]>
  issues(): Promise<Issue[]>
  openBoard(): Promise<void>
  log(text: string): void
}

export async function runPanelCommand(io: PanelCommandIo, rawArgs: string | undefined): Promise<'report' | 'handled'> {
  const [sub, ...args] = (rawArgs ?? '').trim().split(/\s+/).filter(Boolean)
  const arg = args[0]
  if (sub === 'board') {
    await io.openBoard()
    return 'handled'
  }
  if (sub === 'link') {
    const issue = arg ? snapshot(await io.readAll()).find(item => item.id === arg) : undefined
    if (!issue) {
      io.log(arg ? `clm: no issue ${arg}; /clm board lists them` : 'clm: usage /clm link <issue id>')
      return 'handled'
    }
    await io.append([{ op: 'link', issue: issue.id }])
    io.log(`clm: ${issue.id} "${issue.title}" (${issue.origin.repo}) is linked to this session and shows in its ledger from the next fold`)
    return 'handled'
  }
  if (sub === 'drop') {
    const open = (await io.issues()).filter(isOpen)
    const named = args.includes('all') ? open : open.filter(issue => args.includes(issue.id))
    const unknown = args.filter(item => item !== 'all' && !open.some(issue => issue.id === item))
    if (!args.length) io.log('clm: usage /clm drop <issue id…|all>')
    if (unknown.length) io.log(`clm: no open issue ${unknown.join(', ')} in this session; /clm lists them`)
    await io.append(named.map(issue => ({ op: 'status', issue: issue.id, status: 'dropped' as const })))
    if (args.length && !named.length && !unknown.length) io.log('clm: no open issue to drop')
    return 'handled'
  }
  if (sub) {
    io.log('clm: usage /clm, /clm board, /clm link <issue id>, /clm drop <issue id…|all>')
    return 'handled'
  }
  return 'report'
}

export type { ModelTaskCall, Mirrored, TaskToolCall }
