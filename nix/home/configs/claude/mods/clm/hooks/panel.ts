import type { BuiltinToolInputs, SessionMessage } from 'claude-code'
import type { ClmStatus, ClmTaskInput, ClmWorkflow } from '../types'
import { boardHtml } from './board'
import { checkEvidence, describeOp, renderRange, type Evidence, type Source, type SourceKind } from './evidence'
import { compose } from './intent'
import { archivedDone, focusOf, injected, isOpen, isRecord, issueId, shownNote, snapshot, type Issue, type Origin, type Payload, type TrackerEvent } from './tracker'
import type { FocusState } from './tracker'
import { debateRubric, outermostSteppedRootOf, rubricText, type ModelIo } from './stepped'
import { WorktreeError, startWorktree, type Worktree } from './worktree'

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
  sessionMessages: (agentId?: string) => Promise<SessionMessage[] | { deny: string }>
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
  complete: ModelIo['complete']
  run: (argv: readonly string[], options: { cwd?: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  home: () => Promise<string | undefined>
}

const panelStatus: Record<Issue['status'], 'pending' | 'in_progress' | 'completed' | 'deleted'> = {
  todo: 'pending', doing: 'in_progress', 'ready-to-land': 'pending', done: 'completed', dropped: 'deleted', question: 'pending',
}
const taskStatus: Record<string, Issue['status'] | undefined> = {
  pending: 'todo', in_progress: 'doing', completed: 'done', deleted: 'dropped',
}
const panelSubject = (issue: Issue) => `${issue.status === 'question' ? '질문: ' : ''}${issue.title}${issue.progress ? ` (${issue.progress.done}/${issue.progress.total})` : ''}`
const panelDescription = (issue: Issue) => shownNote(issue) ?? issue.title
const agentTaskRootsKey = (session: string) => `agent-task-roots:${session}`
const agentTaskStepClaimsKey = (session: string) => `agent-task-step-claims:${session}`
const taskStatuses = new Set(['todo', 'doing', 'done', 'dropped'])
export function isClmTaskInput(value: unknown): value is ClmTaskInput {
  if (!isRecord(value)) return false
  const input = value
  if (!taskStatuses.has(String(input.status))) return false
  if (input.id !== undefined && typeof input.id !== 'string') return false
  if (input.title !== undefined && typeof input.title !== 'string') return false
  if (input.note !== undefined && typeof input.note !== 'string') return false
  if (input.method !== undefined && (typeof input.method !== 'string' || !input.method.trim() || input.method.length > 300)) return false
  if (input.method !== undefined && input.status !== 'doing') return false
  return input.evidence === undefined || (isRecord(input.evidence)
    && typeof input.evidence.ref === 'string' && typeof input.evidence.quote === 'string')
}

export async function assignedTaskRoots(io: Pick<PanelIo, 'storeGet'>, session: string): Promise<Record<string, string>> {
  const value = await io.storeGet(agentTaskRootsKey(session))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

async function claimedAgentTaskSteps(io: Pick<PanelIo, 'storeGet'>, session: string): Promise<Record<string, string>> {
  const value = await io.storeGet(agentTaskStepClaimsKey(session))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

export async function assignAgentTaskRoot(io: Pick<PanelIo, 'storeGet' | 'storeSet' | 'serialize'>, session: string, agentId: string, root: string): Promise<void> {
  await io.serialize(session, async () => {
    const roots = await assignedTaskRoots(io, session)
    roots[agentId] = root
    await io.storeSet(agentTaskRootsKey(session), roots)
  })
}

/** Assigns `root` to the agent only when no other agent holds it, checked and written under one lock so parallel spawns cannot both claim it. */
export async function claimAgentTaskRoot(io: Pick<PanelIo, 'storeGet' | 'storeSet' | 'serialize'>, session: string, agentId: string, root: string): Promise<boolean> {
  return io.serialize(session, async () => {
    const roots = await assignedTaskRoots(io, session)
    if (Object.values(roots).includes(root)) return false
    const claimed = await claimedAgentTaskSteps(io, session)
    roots[agentId] = root
    claimed[agentId] = root
    await io.storeSet(agentTaskRootsKey(session), roots)
    await io.storeSet(agentTaskStepClaimsKey(session), claimed)
    return true
  })
}

export async function removeAgentTaskRoot(io: Pick<PanelIo, 'storeGet' | 'storeSet' | 'serialize'>, session: string, agentId: string): Promise<void> {
  await io.serialize(session, async () => {
    const roots = await assignedTaskRoots(io, session)
    const claimed = await claimedAgentTaskSteps(io, session)
    if (agentId in roots) {
      delete roots[agentId]
      await io.storeSet(agentTaskRootsKey(session), roots)
    }
    if (agentId in claimed) {
      delete claimed[agentId]
      await io.storeSet(agentTaskStepClaimsKey(session), claimed)
    }
  })
}

// A finished subagent reports its own end, so its root closes with no citation.
export async function closeAgentTaskRoot(io: PanelIo, session: string, agentId: string, status: 'done' | 'dropped'): Promise<void> {
  const root = (await assignedTaskRoots(io, session))[agentId]
  const issues = snapshot(await io.readAll())
  const issue = root === undefined ? undefined : issues.find(item => item.id === root)
  const isClaimedStep = issue !== undefined && (await claimedAgentTaskSteps(io, session))[agentId] === issue.id
  if (issue && isOpen(issue) && !isClaimedStep) await io.append([{ op: 'status', issue: issue.id, status }], await io.captureOrigin())
  await removeAgentTaskRoot(io, session, agentId)
}

export async function createAgentTaskRoot(io: PanelIo, session: string, agentId: string, parent: string, title: string): Promise<string> {
  const origin = await io.captureOrigin()
  const created = await io.append([{ op: 'create', title: title.trim() || `Agent task (${agentId})`, status: 'todo' }], origin)
  const root = created.find(event => event.op === 'create')?.issue
  if (!root) throw new Error(`clm: agent ${agentId} task creation returned no issue id`)
  await io.append([{ op: 'parent', issue: root, parent }], origin)
  await assignAgentTaskRoot(io, session, agentId, root)
  return root
}

export async function sessionIssues(io: Pick<PanelIo, 'captureOrigin' | 'readAll'>, query: { issue?: string; status?: Issue['status'] } = {}): Promise<Issue[]> {
  const session = (await io.captureOrigin()).session
  return snapshot(await io.readAll()).filter(issue => issue.origin.session === session
    && (query.issue === undefined || issue.id === query.issue)
    && (query.status === undefined || issue.status === query.status))
}

export async function clmStatus(io: Pick<PanelIo, 'readWorkflow' | 'readMeta' | 'readAll' | 'sessionId' | 'ledgerPath' | 'storeGet'>): Promise<ClmStatus> {
  const [workflow, meta, events, session, path] = await Promise.all([
    io.readWorkflow(), io.readMeta(), io.readAll(), io.sessionId(), io.ledgerPath(),
  ])
  const issues = snapshot(events).filter(issue => issue.origin.session === session)
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const focusState = focusOf(events, session)
  const focusId = focusState.stack.at(-1)
  const focusIssue = focusId === undefined ? undefined : byId.get(focusId)
  const taskRoots = await assignedTaskRoots(io, session)
  return {
    focus: focusIssue ? { id: focusIssue.id, title: focusIssue.title, status: focusIssue.status } : null,
    stackDepth: focusState.stack.length,
    pending: focusState.pending.flatMap(id => {
      const issue = byId.get(id)
      return issue ? [{ id: issue.id, title: issue.title }] : []
    }),
    agents: Object.entries(taskRoots).flatMap(([agentId, taskId]) => {
      const issue = byId.get(taskId)
      return issue ? [{ agentId, taskId, title: issue.title, status: issue.status }] : []
    }),
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

async function taskEvidenceProblem(
  io: PanelIo, agentId: string | undefined, evidence: Evidence | undefined,
  admissible: readonly SourceKind[], forDone: boolean, missing: string,
): Promise<string | undefined> {
  if (!evidence) return missing
  const transcript = await io.sessionMessages(agentId)
  if (!Array.isArray(transcript)) return `could not read the caller's transcript (${transcript.deny})`
  const checked = checkEvidence([evidence], renderRange(transcript).sources, admissible, forDone)
  return checked.held.length ? undefined : checked.problems.join('; ') || 'the evidence did not match this transcript.'
}

async function createChildTask(
  io: PanelIo, origin: Origin, title: string, status: ClmTaskInput['status'], note: string, parent: string,
): Promise<string | undefined> {
  const created = await io.append([{ op: 'create', title, status, ...(note ? { note } : {}) }], origin)
  const taskId = created.find(event => event.op === 'create')?.issue ?? null
  if (taskId === null) return undefined
  await io.append([{ op: 'parent', issue: taskId, parent }], origin)
  return taskId
}

export const FOCUS_HINT = 'Call clm_task with status "doing" and a title, or the id of an open task, to focus one.'
export const STEPPED_PLANNER_CONTEXT = [
  'This task is a stepped goal with no recorded steps yet. Before editing, spawn the `planner` agent using `subagent_type: "planner"`.',
  'Give the planner this input: `goal` is the user request from the current prompt verbatim, `repo` is the repository path, and `context` holds the task constraints and known files. Wait for its ordered JSON plan.',
  'Record each returned step in order with `clm_task` using `status: "todo"` and its title. Then start the first step with `status: "doing"`, its issue id, and a short `method` describing the approach.',
  'Do the goal work only after the ordered steps have been recorded.',
].join('\n')
export const STEPPED_WORKTREE_CONTEXT = (worktree: Worktree) => `Use ${worktree.dir} as the working directory for every edit and verification command for this stepped goal.`
export const SPAWN_PLAN_REQUEST = [
  'clm: report your plan as clm tasks first, then spawn the agent.',
  '1. Load the tool: ToolSearch with query "select:mcp__clm__clm_task".',
  '2. Call mcp__clm__clm_task with {"status":"doing","title":"<the task you are working on>"}. It becomes your focused task at once.',
  '3. For each sub-step, call mcp__clm__clm_task with {"status":"doing","title":"<sub-step>"}. Title the step this agent will do exactly as the Agent call\'s description, so the agent takes that step as its task.',
  '4. Re-issue this same Agent call.',
].join('\n')

// The step the plan named with the Agent call's description becomes the agent's root, so the plan and the spawn share one task.
export async function plannedAgentStep(io: Pick<PanelIo, 'readAll'>, session: string, parent: string, description: string): Promise<string | undefined> {
  const title = description.trim()
  if (!title) return undefined
  return snapshot(await io.readAll()).find(issue => issue.origin.session === session && issue.parent === parent && isOpen(issue) && issue.title === title)?.id
}

const failureDetails = (err: unknown) => err instanceof WorktreeError
  ? `argv=${JSON.stringify(err.argv)} exitCode=${err.exitCode ?? 'unavailable'} stderr=${JSON.stringify(err.stderr)}`
  : `argv=[] exitCode=unavailable stderr=${JSON.stringify(String(err))}`

export async function steppedPromptContext(io: Pick<PanelIo, 'captureOrigin' | 'readAll'>): Promise<string | undefined> {
  const origin = await io.captureOrigin()
  const events = await io.readAll()
  const issues = snapshot(events).filter(issue => issue.origin.session === origin.session)
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const focusId = focusOf(events, origin.session).stack.at(-1)
  if (!focusId) return undefined
  const root = outermostSteppedRootOf(focusId, byId)
  if (!root || !isOpen(root) || root.landCommandsShown) return undefined
  const children = issues.filter(issue => issue.parent === root.id)
  if (children.length === 0)
    return `${STEPPED_PLANNER_CONTEXT}\nGoal title: ${root.title}\nRepository: ${origin.cwd}`
  if (root.worktree) return `Stepped goal ${root.id} is using a worktree. ${STEPPED_WORKTREE_CONTEXT(root.worktree)}`
  return undefined
}

function stepForTask(taskId: string, root: Issue, byId: ReadonlyMap<string, Issue>): Issue | undefined {
  let current = byId.get(taskId)
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.parent === root.id) return current
    current = current.parent ? byId.get(current.parent) : undefined
  }
  return undefined
}

async function ensureGoalWorktree(io: PanelIo, origin: Origin, root: Issue): Promise<Worktree | undefined> {
  if (root.worktree) return root.worktree
  const argv = ['git', 'rev-parse', '--show-toplevel']
  let repoRoot: string
  try {
    const result = await io.run(argv, { cwd: origin.cwd, timeoutMs: 5000 })
    if (result.exitCode !== 0 || !result.stdout.trim().startsWith('/')) {
      const reason = `issue=${root.id} argv=${JSON.stringify(argv)} exitCode=${result.exitCode} stderr=${JSON.stringify(result.stderr || 'git toplevel was not an absolute path')}`
      io.log(`clm stepped: worktree skipped (${reason})`, { to: 'debug' })
      return undefined
    }
    repoRoot = result.stdout.trim()
  } catch (err) {
    io.log(`clm stepped: worktree skipped issue=${root.id} ${failureDetails(err)}`, { to: 'debug' })
    return undefined
  }
  let worktree: Worktree
  try {
    worktree = await startWorktree(io, { repoRoot, sessionId: origin.session, goalId: root.id })
  } catch (err) {
    io.log(`clm stepped: worktree start failed issue=${root.id} ${failureDetails(err)}`, { to: 'debug' })
    return undefined
  }
  try {
    await io.append([{ op: 'worktree', issue: root.id, ...worktree }], origin)
  } catch (err) {
    io.log(`clm stepped: worktree tracker write failed issue=${root.id} ${failureDetails(err)}`, { to: 'debug' })
    return undefined
  }
  return worktree
}

// The intent classifier writes main's focus only from a user prompt it can
// classify; a session driven by harness text (a cross-session message, a
// resume) gets none, and without this the main agent could neither own a
// task nor spawn a worker.
async function focusMainTask(
  io: PanelIo, origin: Origin, input: ClmTaskInput, focus: FocusState,
  roots: Readonly<Record<string, string>>, byId: ReadonlyMap<string, Issue>,
): Promise<{ result: string }> {
  if (input.status !== 'doing') return { result: `clm_task: the main agent has no focused task to own. ${FOCUS_HINT}` }
  let taskId: string | undefined
  if (input.id !== undefined) {
    const target = byId.get(input.id)
    if (!target) return { result: `clm_task: issue ${input.id} does not exist in this session.` }
    if (!isOpen(target)) return { result: `clm_task: issue ${target.id} is ${target.status}; focus an open task or create one with a title.` }
    const owner = taskOwner(target.id, [], roots, byId)
    if (owner) return { result: `clm_task: issue ${target.id} belongs to ${taskOwnerName(owner)}.` }
    taskId = target.id
    const note = input.note?.trim()
    await io.append([{ op: 'status', issue: taskId, status: 'doing' }, ...(note ? [{ op: 'note' as const, issue: taskId, text: note }] : [])], origin)
  } else {
    const title = input.title?.trim()
    if (!title) return { result: `clm_task: the main agent has no focused task to own. ${FOCUS_HINT}` }
    const note = input.note?.trim()
    const created = await io.append([{ op: 'create', title, status: 'doing', ...(note ? { note } : {}) }], origin)
    taskId = created.find(event => event.op === 'create')?.issue
    if (!taskId) return { result: 'clm_task: task creation did not return an issue id.' }
  }
  await io.append([{ op: 'focus', stack: [taskId], pending: focus.pending.filter(id => id !== taskId), intent: 'continue' }], origin)
  return { result: `clm_task: ${taskId} doing; now the main agent's focus.` }
}

export async function runClmTask(io: PanelIo, input: ClmTaskInput, agentId?: string): Promise<{ result: string } | { deny: string }> {
  const origin = await io.captureOrigin()
  const events = await io.readAll()
  const issues = snapshot(events).filter(issue => issue.origin.session === origin.session)
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const focus = focusOf(events, origin.session)
  const roots = await assignedTaskRoots(io, origin.session)
  const ownRoot = agentId ? roots[agentId] : focus.stack.at(-1)
  if (!ownRoot && !agentId) return focusMainTask(io, origin, input, focus, roots, byId)
  if (!ownRoot) return { result: `clm_task: subagent ${agentId} has no task assigned by the harness.` }
  const ownRootOwner = taskOwner(ownRoot, focus.stack, roots, byId)
  if (ownRootOwner !== (agentId ?? 'main')) return { result: `clm_task: ${ownRoot} belongs to ${taskOwnerName(ownRootOwner)}.` }
  const target = input.id === undefined ? undefined : byId.get(input.id)
  if (input.id !== undefined) {
    if (!target) return { result: `clm_task: issue ${input.id} does not exist in this session.` }
    const owner = taskOwner(target.id, focus.stack, roots, byId)
    if (owner !== (agentId ?? 'main')) return { result: `clm_task: issue ${target.id} belongs to ${taskOwnerName(owner)}.` }
  }
  const title = input.title?.trim()
  if (input.id === undefined && !title) return { result: 'clm_task: provide an issue id to update or a title to create a child task.' }
  const reopensDropped = target?.status === 'dropped' && input.status !== 'dropped'
  const directionProblem = input.status === 'dropped' || reopensDropped
    ? await taskEvidenceProblem(io, undefined, input.evidence, ['user'], false, 'drop or re-open requires a quote from a user message.')
    : undefined
  if (directionProblem) return { deny: `clm_task: ${directionProblem}` }
  const status = input.status
  if (status === 'done') {
    const goal = outermostSteppedRootOf(target?.id ?? ownRoot, byId)
    const step = goal && stepForTask(target?.id ?? ownRoot, goal, byId)
    const closesGoal = goal !== undefined && (goal.id === target?.id || (!target && goal.id === ownRoot))
    if (closesGoal || (target && step?.id === target.id))
      return { result: `clm_task: stepped issue ${target?.id ?? ownRoot} stays open until the Stop hook passes its rubric and checkpoints it.` }
  }
  const audit = status === 'done' && input.evidence ? `cited ${input.evidence.ref}: ${input.evidence.quote}` : undefined
  const note = [input.note?.trim(), audit].filter((line): line is string => Boolean(line)).join('\n')
  const createdTask = input.id === undefined && title ? await createChildTask(io, origin, title, status, note, ownRoot) : undefined
  const taskId = input.id ?? createdTask
  if (!taskId) return { result: 'clm_task: task creation did not return an issue id.' }
  if (input.id !== undefined)
    await io.append([{ op: 'status', issue: taskId, status }, ...(note ? [{ op: 'note' as const, issue: taskId, text: note }] : [])], origin)
  if (taskId === focus.stack.at(-1) && (status === 'done' || status === 'dropped')) {
    const currentEvents = await io.readAll()
    const currentFocus = focusOf(currentEvents, origin.session)
    const currentIssues = snapshot(currentEvents).filter(issue => issue.origin.session === origin.session)
    const lastSeq = currentEvents.filter(event => event.origin.session === origin.session).reduce((n, event) => Math.max(n, event.seq), 0)
    const composed = compose(currentFocus, { intent: 'continue', target: null, title: null, rule: null }, currentIssues, () => issueId(origin.session, lastSeq + 1))
    await io.append([{ op: 'focus', stack: composed.next.stack, pending: composed.next.pending, intent: 'continue' }], origin)
  }
  const current = await sessionIssues(io, { issue: taskId })
  const actualStatus = current[0]?.status ?? status
  const context: string[] = []
  if (status === 'doing') {
    try {
      const currentEvents = await io.readAll()
      const currentIssues = snapshot(currentEvents).filter(issue => issue.origin.session === origin.session)
      const currentById = new Map(currentIssues.map(issue => [issue.id, issue]))
      const goal = outermostSteppedRootOf(taskId, currentById)
      const step = goal && stepForTask(taskId, goal, currentById)
      if (goal && step) {
        if (step.stepped && step.id !== goal.id)
          io.log(`clm stepped: nested goal issue=${step.id} is a step of outer goal issue=${goal.id}; no nested worktree will start`, { to: 'debug' })
        let worktree = goal.worktree
        if (!worktree) worktree = await ensureGoalWorktree(io, origin, goal)
        if (worktree) context.push(STEPPED_WORKTREE_CONTEXT(worktree))
        if (input.method !== undefined) {
          const method = input.method.trim()
          const alreadyFailed = currentById.get(step.id)?.methods?.some(item => item.text === method && item.failed) ?? false
          try {
            await io.append([{ op: 'method', issue: step.id, text: method, failed: false }], origin)
            context.push(`Method for issue ${step.id}: ${method}.${alreadyFailed ? ' This methodology has failed before; it remains counted as failed if it fails again.' : ''}`)
          } catch (err) {
            const details = `issue=${step.id} argv=[] exitCode=unavailable stderr=${JSON.stringify(String(err))}`
            io.log(`clm stepped: method tracker write failed ${details}`, { to: 'debug' })
            context.push(`The method for issue ${step.id} could not be recorded (${details}); the Stop check will use the last recorded method or its default.`)
          }
        }
      }
    } catch (err) {
      const details = `issue=${taskId} argv=[] exitCode=unavailable stderr=${JSON.stringify(String(err))}`
      io.log(`clm stepped: step setup failed ${details}`, { to: 'debug' })
      context.push(`Stepped-goal setup for issue ${taskId} failed (${details}); the Stop hook will release the session if it cannot verify the step.`)
    }
  }
  const rubric = status === 'doing' ? await settleStepRubric(io, origin, taskId) : undefined
  return { result: `clm_task: ${taskId} ${actualStatus}.${[...context, rubric].filter(Boolean).map(text => `\n${text}`).join('')}` }
}

/** A step of a stepped goal started without a rubric gets one from the debate; the tool result carries it or why it is missing. */
async function settleStepRubric(io: PanelIo, origin: Origin, taskId: string): Promise<string | undefined> {
  try {
    const issues = snapshot(await io.readAll()).filter(issue => issue.origin.session === origin.session)
    const byId = new Map(issues.map(issue => [issue.id, issue]))
    const step = byId.get(taskId)
    const root = outermostSteppedRootOf(taskId, byId)
    const goalStep = root && stepForTask(taskId, root, byId)
    if (!step || !root || goalStep?.id !== taskId) return undefined
    const citationHint = step.rubric?.some(item => item.kind === 'evidence')
      ? '\nFor each evidence item, include a <clm-step-citations> JSON array in your final response with {"id":"<rubric id>","ref":"<transcript row ref>","quote":"<verbatim quote>"}.'
      : ''
    if (step.rubric) return `Rubric for this step:\n${rubricText(step.rubric)}${citationHint}`
    const items = await debateRubric(io, {
      goal: root.title, step: step.title, notes: step.notes, cwd: root.worktree?.dir ?? origin.cwd,
      siblings: issues.filter(issue => issue.parent === step.parent && issue.id !== step.id).map(issue => issue.title),
    })
    if (typeof items === 'string') {
      const reason = `issue=${taskId} argv=[] exitCode=unavailable stderr=${JSON.stringify(items)}`
      io.log(`clm stepped: rubric debate failed ${reason}`, { to: 'debug' })
      return `No rubric settled for issue ${taskId} (${reason}); the step has no done check yet.`
    }
    try { await io.append([{ op: 'rubric', issue: taskId, items }], origin) }
    catch (err) {
      const reason = `issue=${taskId} argv=[] exitCode=unavailable stderr=${JSON.stringify(String(err))}`
      io.log(`clm stepped: rubric tracker write failed ${reason}`, { to: 'debug' })
      return `The rubric for issue ${taskId} could not be stored (${reason}); the step has no done check yet.`
    }
    const evidenceHint = items.some(item => item.kind === 'evidence')
      ? '\nFor each evidence item, include a <clm-step-citations> JSON array in your final response with {"id":"<rubric id>","ref":"<transcript row ref>","quote":"<verbatim quote>"}.'
      : ''
    return `Rubric for this step, settled after two review rounds:\n${rubricText(items)}${evidenceHint}`
  } catch (err) {
    const reason = `issue=${taskId} argv=[] exitCode=unavailable stderr=${JSON.stringify(String(err))}`
    io.log(`clm stepped: rubric setup failed ${reason}`, { to: 'debug' })
    return `No rubric settled for issue ${taskId} (${reason}); the step has no done check yet.`
  }
}

export async function mirrorModelTask(io: Pick<PanelIo, 'captureOrigin' | 'readAll' | 'append'>, event: ModelTaskCall): Promise<Mirrored> {
  const origin = await io.captureOrigin()
  const issues = snapshot(await io.readAll())
  // The deny text names clm's issue id, so a TaskUpdate may carry either id.
  const byTask = (taskId: string) => issues.find(issue => issue.origin.session === origin.session && (issue.taskId === taskId || issue.id === taskId))
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
    ...(issue.priority === undefined ? {} : { priority: issue.priority }), ...(issue.ready === undefined ? {} : { ready: issue.ready }),
    ...(issue.claimedBy === undefined ? {} : { claimedBy: issue.claimedBy }),
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
