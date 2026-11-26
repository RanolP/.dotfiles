// Pure parsers for the files other mods write. Each takes file text and returns
// display rows; nothing here reads, writes or evaluates beyond the file's own fields.
import type { WayseekerRows } from '../types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

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
