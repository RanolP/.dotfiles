import {
  describe, normalizeRemote, parseLog, toEvents,
  type Origin, type Payload, type TrackerEvent,
} from './tracker'
import { snapshot } from './tracker'
import { describeOp } from './evidence'

export type LogEvent = 'clear' | 'skip-not-shrinking' | 'merge-invalid' | 'merge-timeout' | 'ops-rejected' | 'fallback' | 'truncation' | 'escape' | 'panel-relink'
  | 'evidence-rejected' | 'review-rejected' | 'review-failed' | 'review-dropped' | 'escape-instructions-lost' | 'ledger-over-budget' | 'rewind'
export type LogFields = { tokensBefore?: number; tokensAfter?: number; keptTurns?: number; ratio?: number; durationMs?: number; summaryMs?: number; reason?: string }

type FsEntry = { name: string; kind: string; size: number; mtimeMs: number; isLink: boolean }
export type EventsIo = {
  sessionId: () => Promise<string>
  cwd: () => Promise<string>
  run: (args: string[], options: { cwd?: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  exists: (path: string) => Promise<boolean>
  list: (path: string) => Promise<FsEntry[]>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  log: (text: string, options?: { to?: 'transcript' | 'debug' }) => void
  trackerDirectory: () => Promise<string>
  trackerLogPath: (session: string) => Promise<string>
  generalLogPath: () => Promise<string>
  project: (origin: Origin, events: readonly TrackerEvent[]) => Promise<void>
}

const trackerCache = new Map<string, { size: number; mtimeMs: number; events: TrackerEvent[] }>()
const writeChains = new Map<string, Promise<unknown>>()
const LOG_KEEP = 200

export async function captureOrigin(io: EventsIo): Promise<Origin> {
  const session = await io.sessionId()
  const cwd = await io.cwd()
  const git = async (args: string[]) => {
    try {
      const result = await io.run(['git', ...args], { cwd, timeoutMs: 5000 })
      return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : undefined
    } catch {
      return undefined
    }
  }
  const remote = await git(['remote', 'get-url', 'origin'])
  const repo = remote ? normalizeRemote(remote) : ((await git(['rev-parse', '--show-toplevel'])) ?? cwd)
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  return { session, repo, ...(branch ? { branch } : {}), cwd }
}

export async function readAll(io: EventsIo): Promise<TrackerEvent[]> {
  const dir = await io.trackerDirectory()
  if (!(await io.exists(dir))) return []
  const out: TrackerEvent[] = []
  for (const file of await io.list(dir)) {
    if (file.kind !== 'file' || !file.name.endsWith('.jsonl')) continue
    try {
      const cached = trackerCache.get(file.name)
      const events = cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs
        ? cached.events
        : parseLog(await io.read(`${dir}/${file.name}`))
      trackerCache.set(file.name, { size: file.size, mtimeMs: file.mtimeMs, events })
      out.push(...events)
    } catch (err) {
      io.log(`clm tracker: could not read ${file.name} (${String(err).slice(0, 120)})`, { to: 'debug' })
    }
  }
  return out
}

export function serialized<T>(session: string, run: () => Promise<T>): Promise<T> {
  const result = (writeChains.get(session) ?? Promise.resolve()).then(run, run)
  writeChains.set(session, result.then(() => undefined, () => undefined))
  return result
}

export async function writeEvents(io: EventsIo, payloads: readonly Payload[], origin: Origin): Promise<TrackerEvent[]> {
  const path = await io.trackerLogPath(origin.session)
  const previous = (await io.exists(path)) ? await io.read(path) : ''
  const lastSeq = parseLog(previous).reduce((n, event) => Math.max(n, event.seq), 0)
  const events = toEvents(payloads, origin, lastSeq, new Date().toISOString())
  const body = previous && !previous.endsWith('\n') ? `${previous}\n` : previous
  await io.write(path, `${body}${events.map(event => JSON.stringify(event)).join('\n')}\n`)
  return events
}

export async function append(
  io: EventsIo, payloads: readonly Payload[], origin?: Origin, project = true, knownTitles = false,
): Promise<TrackerEvent[]> {
  if (payloads.length === 0) return []
  const captured = origin ?? (await captureOrigin(io))
  return serialized(captured.session, async () => {
    const before = snapshot(await readAll(io))
    const titles = new Set(knownTitles ? before.filter(issue => issue.origin.session === captured.session).map(issue => issue.title.trim()) : [])
    const known = payloads.filter(payload => payload.op === 'create' && titles.has(payload.title.trim()))
    if (known.length) io.log(`clm: create skipped, this session already has the title: ${known.map(payload => describeOp(payload)).join('; ')}`, { to: 'debug' })
    const fresh = payloads.filter(payload => (payload.op !== 'status' || before.find(issue => issue.id === payload.issue)?.status !== payload.status) && !known.includes(payload))
    if (fresh.length === 0) return []
    const events = await writeEvents(io, fresh, captured)
    try {
      for (const line of describe(events, before)) io.log(line)
    } catch { /* display notices never block tracker writes */ }
    if (project) await io.project(captured, events)
    return events
  })
}

export async function logEvent(io: EventsIo, event: LogEvent, fields: LogFields): Promise<void> {
  try {
    const path = await io.generalLogPath()
    const lines = ((await io.exists(path)) ? await io.read(path) : '').split('\n').filter(Boolean)
    lines.push(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }))
    await io.write(path, `${lines.slice(-LOG_KEEP).join('\n')}\n`)
  } catch { /* the log must never stop a fold */ }
}
