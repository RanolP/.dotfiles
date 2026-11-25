import { syncPanel, type PanelIo } from './panel'
import { parseLog, type Origin, type TrackerEvent } from './tracker'

export type ProjectionIo = {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  toolCall: PanelIo['toolCall']
  log: PanelIo['log']
}

// Same per-session promise chain as clm/hooks/events.ts serialized.
const chains = new Map<string, Promise<void>>()
const serialized = <T>(session: string, run: () => Promise<T>): Promise<T> => {
  const result = (chains.get(session) ?? Promise.resolve()).then(run, run)
  const tail = result.then(() => undefined, () => undefined)
  chains.set(session, tail)
  void tail.then(() => { if (chains.get(session) === tail) chains.delete(session) })
  return result
}

export const projectSession = (io: ProjectionIo, home: string, session: string): Promise<void> => serialized(session, async () => {
  const sourcePath = `${home}/.claude-work/tracker/events/${session}.jsonl`
  const linksPath = `${home}/.claude-work/task-panel/${session}.jsonl`
  const statePath = `${home}/.claude-work/task-panel/${session}.state.json`
  const read = async (path: string) => await io.exists(path) ? io.read(path) : ''
  const events = parseLog(await read(sourcePath)).filter(event => event.origin.session === session)
  const state: unknown = JSON.parse((await read(statePath)) || '0')
  if (typeof state !== 'number' || !Number.isSafeInteger(state) || state < 0) throw new Error(`Invalid task-panel watermark: ${statePath}`)
  const fresh = events.filter(event => event.seq > state)
  const origin: Origin | undefined = fresh.at(-1)?.origin
  if (!origin) return
  const previous = await read(linksPath)
  const links = parseLog(previous)
  // Link sequence numbers are local to this file; negative numbers keep them out of syncPanel's fresh tracker seq set.
  const merged = [...events, ...links.map(event => ({ ...event, seq: -event.seq }))]
  await syncPanel({
    readAll: async () => merged,
    sessionId: async () => session,
    serialize: serialized,
    toolCall: io.toolCall,
    log: io.log,
    logEvent: async (event, fields) => io.log(`task-panel: ${event} ${fields.reason ?? ''}`, { to: 'debug' }),
    writeEvents: async (payloads, here) => {
      const lastSeq = links.reduce((n, event) => Math.max(n, event.seq), 0)
      // A link follows even a source event with a future timestamp, preserving snapshot's timestamp-first ordering.
      const ts = new Date(merged.reduce((latest, event) => Math.max(latest, Date.parse(event.ts) + 1), Date.now())).toISOString()
      const written: TrackerEvent[] = payloads.flatMap((payload, index) => payload.op === 'task'
        ? [{ ...payload, origin: here, seq: lastSeq + index + 1, ts }] : [])
      const body = previous && !previous.endsWith('\n') ? `${previous}\n` : previous
      await io.write(linksPath, `${body}${written.map(event => JSON.stringify(event)).join('\n')}\n`)
      return written
    },
  }, origin, fresh)
  await io.write(statePath, JSON.stringify(events.reduce((n, event) => Math.max(n, event.seq), state)))
})
