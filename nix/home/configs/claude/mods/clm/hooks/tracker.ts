// The tracker behind the ledger's 한 일 / 할 일 / 미결 질문 sections. State is
// global (every session, every repository) but written as one append-only log
// per session, so each file has a single writer and the read-then-rewrite
// "append" `$.fs` allows never races. Nothing is cached: the issues are
// recomputed from every log on each read, which stays cheap because issues
// live for a session or two.

export const STATUSES = ['todo', 'doing', 'done', 'question', 'dropped'] as const
export type IssueStatus = (typeof STATUSES)[number]
export const isStatus = (v: unknown): v is IssueStatus => typeof v === 'string' && (STATUSES as readonly string[]).includes(v)

export type Origin = { session: string; repo: string; branch?: string; cwd: string }
type Base = { ts: string; seq: number; issue: string; origin: Origin }
type Create = { op: 'create'; title: string; status: IssueStatus; note?: string; taskId?: string }
export type TrackerEvent = Base & (
  | Create
  | { op: 'status'; status: IssueStatus }
  | { op: 'note'; text: string }
  // Links `issue` to `origin.session`, so it is injected there whatever its repo.
  | { op: 'link' }
)
export type Payload =
  | Create
  | { op: 'status'; issue: string; status: IssueStatus }
  | { op: 'note'; issue: string; text: string }
  | { op: 'link'; issue: string }

export type Issue = {
  id: string
  title: string
  status: IssueStatus
  origin: Origin
  notes: string[]
  linked: string[]
  taskId?: string
  updated: string
}

export const issueId = (session: string, seq: number) => `${session.slice(0, 6)}-${seq}`

// --- pure ------------------------------------------------------------------

/** Parses one log, skipping lines a torn write or a hand edit left unreadable. */
export function parseLog(text: string): TrackerEvent[] {
  const out: TrackerEvent[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as TrackerEvent
      if (typeof e?.issue === 'string' && typeof e.seq === 'number' && typeof e.ts === 'string' && e.origin) out.push(e)
    } catch { /* skipped */ }
  }
  return out
}

const order = (a: TrackerEvent, b: TrackerEvent) =>
  a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.origin.session < b.origin.session ? -1 : a.origin.session > b.origin.session ? 1 : a.seq - b.seq

/** Folds every session's events, in (ts, session, seq) order, into the issues. */
export function snapshot(events: readonly TrackerEvent[]): Issue[] {
  const issues = new Map<string, Issue>()
  for (const e of [...events].sort(order)) {
    if (e.op === 'create') {
      if (!issues.has(e.issue))
        issues.set(e.issue, { id: e.issue, title: e.title, status: e.status, origin: e.origin, notes: e.note ? [e.note] : [], linked: [], ...(e.taskId ? { taskId: e.taskId } : {}), updated: e.ts })
      continue
    }
    const i = issues.get(e.issue)
    if (!i) continue
    if (e.op === 'status') i.status = e.status
    else if (e.op === 'note') i.notes.push(e.text)
    else if (!i.linked.includes(e.origin.session)) i.linked.push(e.origin.session)
    i.updated = e.ts
  }
  return [...issues.values()]
}

/** Turns payloads into events for one session, numbering on from `lastSeq`. */
export function toEvents(payloads: readonly Payload[], origin: Origin, lastSeq: number, ts: string): TrackerEvent[] {
  let seq = lastSeq
  return payloads.map((p): TrackerEvent => {
    seq += 1
    const base = { ts, seq, origin }
    switch (p.op) {
      case 'create': return { ...base, issue: issueId(origin.session, seq), ...p }
      case 'status': return { ...base, issue: p.issue, op: 'status', status: p.status }
      case 'note': return { ...base, issue: p.issue, op: 'note', text: p.text }
      case 'link': return { ...base, issue: p.issue, op: 'link' }
    }
  })
}

export const isOpen = (i: Issue) => i.status === 'todo' || i.status === 'doing' || i.status === 'question'

/**
 * What one session's ledger carries: open issues from its repository, every
 * issue linked to it, and the issues it finished itself (its 한 일).
 */
export function injected(issues: readonly Issue[], here: { session: string; repo: string }): Issue[] {
  return issues.filter(i =>
    i.linked.includes(here.session) ||
    (isOpen(i) && i.origin.repo === here.repo) ||
    (i.status === 'done' && i.origin.session === here.session))
}

/** Same repository whatever the transport: `git@host:o/r.git` and `https://host/o/r` match. */
export function normalizeRemote(url: string): string {
  return url.trim()
    .replace(/^[a-z+]+:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
}

// --- fold ops and ledger sections ------------------------------------------

/** Ledger section -> the statuses it lists; these sections are rendered, never merged. */
export const TRACKER_SECTIONS: Record<string, readonly IssueStatus[]> = { '한 일': ['done'], '할 일': ['doing', 'todo'], '미결 질문': ['question'] }
export const isTrackerSection = (s: string) => s in TRACKER_SECTIONS

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const flat = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim()

export const issueLine = (i: Issue) =>
  `- ${i.status === 'doing' ? '(doing) ' : ''}${i.title}${i.notes.length ? ` — ${i.notes[i.notes.length - 1]}` : ''} [${i.id}]`

export function sectionLines(issues: readonly Issue[], section: string): string[] {
  const want = TRACKER_SECTIONS[section] ?? []
  const lines = issues.filter(i => want.includes(i.status))
    .sort((a, b) => want.indexOf(a.status) - want.indexOf(b.status) || (a.updated < b.updated ? -1 : a.updated > b.updated ? 1 : 0))
    .map(issueLine)
  return lines.length ? lines : ['- (none yet)']
}

/**
 * Reads the merge model's `<ops>` array. Each op is checked on its own: one
 * naming an issue the model was not shown, or a status outside the set, is
 * dropped and counted; the rest still land.
 */
export function parseOps(raw: string, known: ReadonlySet<string>): { ops: Payload[]; rejected: number } | string {
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch (err) {
    return `ops are not JSON (${String(err).slice(0, 80)})`
  }
  if (!Array.isArray(list)) return 'ops are not a JSON array'
  const text = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? clip(flat(v), n) : undefined)
  const ops: Payload[] = []
  let rejected = 0
  for (const o of list as Record<string, unknown>[]) {
    const title = text(o?.title, 200), note = text(o?.note ?? o?.text, 300)
    if (o?.op === 'create' && title && isStatus(o.status) && o.status !== 'dropped')
      ops.push({ op: 'create', title, status: o.status, ...(note ? { note } : {}) })
    else if (o?.op === 'status' && typeof o.issue === 'string' && known.has(o.issue) && isStatus(o.status))
      ops.push({ op: 'status', issue: o.issue, status: o.status })
    else if (o?.op === 'note' && typeof o.issue === 'string' && known.has(o.issue) && note)
      ops.push({ op: 'note', issue: o.issue, text: note })
    else rejected++
  }
  return { ops, rejected }
}

/** TaskUpdate's statuses in the tracker's words. */
export const TASK_STATUS: Record<string, IssueStatus> = { pending: 'todo', in_progress: 'doing', completed: 'done', deleted: 'dropped' }
