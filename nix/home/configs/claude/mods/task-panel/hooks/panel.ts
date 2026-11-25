// Copied from nix/home/configs/claude/mods/clm/hooks/panel.ts.
import { archivedDone, shownNote, snapshot, type Issue, type Origin, type Payload, type TrackerEvent } from './tracker'

type TaskToolCall =
  | { tool: 'TaskCreate'; subject: string; description: string }
  | { tool: 'TaskUpdate'; taskId: string; subject: string; description: string; status: 'pending' | 'in_progress' | 'completed' | 'deleted' }

export type PanelIo = {
  readAll: () => Promise<TrackerEvent[]>
  writeEvents: (payloads: readonly Payload[], origin: Origin) => Promise<TrackerEvent[]>
  logEvent: (event: 'panel-relink', fields: { reason?: string }) => Promise<void>
  serialize: <T>(session: string, run: () => Promise<T>) => Promise<T>
  sessionId: () => Promise<string>
  toolCall: (input: TaskToolCall) => Promise<
    | { deny: string }
    | { isError: true; result?: { task?: { id?: string }; success?: boolean; error?: string } }
    | { isError?: false; result: { task?: { id?: string }; success?: boolean; error?: string } }
  >
  log: (text: string, options?: { to?: 'transcript' | 'debug' }) => void
}

const panelStatus: Record<Issue['status'], 'pending' | 'in_progress' | 'completed' | 'deleted'> = {
  todo: 'pending', doing: 'in_progress', 'ready-to-land': 'pending', done: 'completed', dropped: 'deleted', question: 'pending',
}
const panelSubject = (issue: Issue) => `${issue.status === 'question' ? '질문: ' : ''}${issue.title}${issue.progress ? ` (${issue.progress.done}/${issue.progress.total})` : ''}`
const panelDescription = (issue: Issue) => shownNote(issue) ?? issue.title

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

