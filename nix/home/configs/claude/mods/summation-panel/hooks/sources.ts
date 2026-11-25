// Pure parsers for the files other mods write. Each takes file text and returns
// display rows; nothing here reads, writes or evaluates beyond the file's own fields.
import type { ClmIssueRow, ClmRows, WayseekerRows } from '../types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// clm's isOpen (mods/clm/hooks/tracker.ts): every status but done and dropped.
const OPEN = new Set(['todo', 'doing', 'ready-to-land', 'question', 'uncertain'])

/**
 * Reads clm's per-session event log (~/.claude-work/tracker/events/<session>.jsonl, one TrackerEvent per line,
 * written only by that session, so seq orders it). Issues created in another session's file are not in this one:
 * a focus on such an issue shows its id instead of its title.
 */
export function parseClmLog(text: string, session: string): ClmRows {
  const events: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const event: unknown = JSON.parse(line)
      if (isRecord(event) && typeof event.issue === 'string' && typeof event.op === 'string' && typeof event.seq === 'number') events.push(event)
    } catch { /* a torn write; clm's own parseLog skips it too */ }
  }
  events.sort((a, b) => (a.seq as number) - (b.seq as number))

  const issues = new Map<string, ClmIssueRow>()
  let stack: string[] = []
  let pending: string[] = []
  for (const e of events) {
    const id = e.issue as string
    const issue = issues.get(id)
    if (e.op === 'create' && !issue && typeof e.title === 'string' && typeof e.status === 'string') issues.set(id, { id, title: e.title, status: e.status })
    else if (e.op === 'focus' && id === session && Array.isArray(e.stack)) {
      stack = e.stack.filter((s): s is string => typeof s === 'string')
      pending = Array.isArray(e.pending) ? e.pending.filter((s): s is string => typeof s === 'string') : []
    }
    else if (!issue) continue
    else if (e.op === 'status' && typeof e.status === 'string') issue.status = e.status
    else if (e.op === 'retitle' && typeof e.title === 'string') issue.title = e.title
    else if (e.op === 'resolve' && e.decision === 'close') issue.status = 'dropped'
  }
  const top = stack.at(-1)
  return {
    focus: top === undefined ? null : issues.get(top) ?? { id: top, title: top, status: 'unknown' },
    stackDepth: stack.length,
    pending: pending.flatMap(id => issues.get(id) ?? []),
    open: [...issues.values()].filter(issue => OPEN.has(issue.status)),
  }
}

/**
 * Reads wayseeker's per-session file (~/.claude-work/plans/wayseeker-<session>.json), whose
 * "wayseeker:<session>:main" key holds the main thread's ledger. Shows each want and ask line no live reject
 * targets. wayseeker's own "open" (say.ts openItems) also drops a want whose fact holds and an ask already
 * answered, which takes its rule evaluator; this panel does not run it, so those can still show here.
 */
export function parseWayseekerState(text: string, session: string): WayseekerRows {
  const state: unknown = JSON.parse(text)
  if (!isRecord(state)) throw new Error('state is not a JSON object')
  const ledger = state[`wayseeker:${session}:main`]
  if (ledger === undefined) return { want: [], ask: [] }
  if (!isRecord(ledger) || !Array.isArray(ledger.utterances)) throw new Error('ledger has no utterances array')
  const lines = ledger.utterances.filter(isRecord).flatMap(u => {
    const act = u.act
    return typeof u.id === 'number' && isRecord(act) && typeof act.kind === 'string'
      ? [{ id: u.id, kind: act.kind, target: act.target, source: typeof u.source === 'string' ? u.source : `@${u.id}` }]
      : []
  })
  // Rejects point backward, so a newest-first pass settles a reject of a reject (wayseeker's liveIds).
  const dead = new Set<number>()
  for (const line of [...lines].sort((a, b) => b.id - a.id))
    if (line.kind === 'reject' && !dead.has(line.id) && typeof line.target === 'number') dead.add(line.target)
  const live = lines.filter(line => !dead.has(line.id))
  return {
    want: live.filter(line => line.kind === 'want').map(line => line.source),
    ask: live.filter(line => line.kind === 'ask').map(line => line.source),
  }
}
