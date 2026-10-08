// The tracker behind the ledger's 한 일 / 할 일 / 미결 질문 sections. State is
// global (every session, every repository) but written as one append-only log
// per session, so each file has a single writer session; that session's own
// concurrent writes (parallel tool calls) are serialized per session in
// register.ts `serialized`, since `$.fs` offers only a read-then-rewrite
// "append". Log contents are cached by the metadata returned from `$.fs.list`,
// so an unchanged session file is parsed once.

import { readEvidence, type Evidence } from './evidence'

export const STATUSES = ['todo', 'doing', 'done', 'question', 'dropped'] as const
export type IssueStatus = (typeof STATUSES)[number]
export const isStatus = (v: unknown): v is IssueStatus => typeof v === 'string' && (STATUSES as readonly string[]).includes(v)

export type Origin = { session: string; repo: string; branch?: string; cwd: string }
type Base = { ts: string; seq: number; issue: string; origin: Origin }
type Create = { op: 'create'; title: string; status: IssueStatus; note?: string; taskId?: string }
export type TrackerEvent = Base & (
  | Create
  | { op: 'status'; status: IssueStatus }
  | { op: 'retitle'; title: string }
  | { op: 'progress'; done: number; total: number }
  | { op: 'task'; taskId: string }
  | { op: 'note'; text: string }
  // Links `issue` to `origin.session`, so it is injected there whatever its repo.
  | { op: 'link' }
)
export type Payload =
  | Create
  | { op: 'status'; issue: string; status: IssueStatus }
  | { op: 'retitle'; issue: string; title: string }
  | { op: 'progress'; issue: string; done: number; total: number }
  | { op: 'task'; issue: string; taskId: string }
  | { op: 'note'; issue: string; text: string }
  | { op: 'link'; issue: string }

export type Issue = {
  id: string
  title: string
  status: IssueStatus
  progress?: { done: number; total: number }
  origin: Origin
  notes: string[]
  linked: string[]
  taskId?: string
  updated: string
  /** Position of the event that last made this issue done, in snapshot order; later is larger. */
  doneOrder?: number
}

export const issueId = (session: string, seq: number) => `${session.slice(0, 8)}-${seq}`

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
  let n = 0
  for (const e of [...events].sort(order)) {
    n += 1
    if (e.op === 'create') {
      if (!issues.has(e.issue))
        issues.set(e.issue, {
          id: e.issue, title: e.title, status: e.status, origin: e.origin, notes: e.note ? [e.note] : [], linked: [],
          ...(e.taskId ? { taskId: e.taskId } : {}), updated: e.ts, ...(e.status === 'done' ? { doneOrder: n } : {}),
        })
      continue
    }
    const i = issues.get(e.issue)
    if (!i) continue
    if (e.op === 'status') {
      i.status = e.status
      if (e.status === 'done') i.doneOrder = n
    }
    else if (e.op === 'retitle') i.title = e.title
    else if (e.op === 'progress') i.progress = { done: e.done, total: e.total }
    else if (e.op === 'task') i.taskId = e.taskId
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
      case 'retitle': return { ...base, issue: p.issue, op: 'retitle', title: p.title }
      case 'progress': return { ...base, issue: p.issue, op: 'progress', done: p.done, total: p.total }
      case 'task': return { ...base, issue: p.issue, op: 'task', taskId: p.taskId }
      case 'note': return { ...base, issue: p.issue, op: 'note', text: p.text }
      case 'link': return { ...base, issue: p.issue, op: 'link' }
    }
  })
}

export const isOpen = (i: Issue) => i.status === 'todo' || i.status === 'doing' || i.status === 'question'

// The ledger's 한 일 and the task panel show only a session's newest
// completions; the tracker log keeps every issue as the searchable history.
// An older one moved back to todo or doing is no longer done, so it shows again.
export const DONE_SHOWN = 5
/** Ids of this session's done issues older than its newest DONE_SHOWN completions. */
export function archivedDone(issues: readonly Issue[], session: string): Set<string> {
  const done = issues.filter(i => i.status === 'done' && i.origin.session === session)
    .sort((a, b) => (b.doneOrder ?? 0) - (a.doneOrder ?? 0))
  return new Set(done.slice(DONE_SHOWN).map(i => i.id))
}

/**
 * What one session's ledger carries: its own open issues, every issue linked
 * to it, and the newest DONE_SHOWN issues it finished. Another session's
 * issue reaches it only through an explicit link, since a summary that mixes
 * sessions reports their work as this one's.
 */
export function injected(issues: readonly Issue[], here: { session: string }): Issue[] {
  const archived = archivedDone(issues, here.session)
  return issues.filter(i => !archived.has(i.id) && (
    i.linked.includes(here.session) ||
    (i.origin.session === here.session && (isOpen(i) || i.status === 'done'))))
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
  `- ${i.status === 'doing' ? '(doing) ' : ''}${i.title}${i.progress ? ` (${i.progress.done}/${i.progress.total})` : ''}${i.notes.length ? ` — ${i.notes[i.notes.length - 1]}` : ''} [${i.id}]`

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
export function parseOps(raw: string, known: ReadonlySet<string>): { ops: Payload[]; evidence: Evidence[][]; rejected: number } | string {
  let list: unknown
  try {
    list = JSON.parse(raw)
  } catch (err) {
    return `ops are not JSON (${String(err).slice(0, 80)})`
  }
  if (!Array.isArray(list)) return 'ops are not a JSON array'
  const text = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? clip(flat(v), n) : undefined)
  const integer = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
  const ops: Payload[] = []
  // Aligned with `ops` by index; the evidence never reaches the event log.
  const evidence: Evidence[][] = []
  let rejected = 0
  for (const o of list as Record<string, unknown>[]) {
    const before = ops.length
    const title = text(o?.title, 200), note = text(o?.note ?? o?.text, 300)
    if (o?.op === 'create' && title && isStatus(o.status) && o.status !== 'dropped')
      ops.push({ op: 'create', title, status: o.status, ...(note ? { note } : {}) })
    else if (o?.op === 'status' && typeof o.issue === 'string' && known.has(o.issue) && isStatus(o.status))
      ops.push({ op: 'status', issue: o.issue, status: o.status })
    else if (o?.op === 'retitle' && typeof o.issue === 'string' && known.has(o.issue) && title)
      ops.push({ op: 'retitle', issue: o.issue, title })
    else if (o?.op === 'progress' && typeof o.issue === 'string' && known.has(o.issue) && integer(o.done) && integer(o.total) && o.total >= 1 && o.done >= 0 && o.done <= o.total)
      ops.push({ op: 'progress', issue: o.issue, done: o.done, total: o.total })
    else if (o?.op === 'note' && typeof o.issue === 'string' && known.has(o.issue) && note)
      ops.push({ op: 'note', issue: o.issue, text: note })
    else rejected++
    if (ops.length > before) evidence.push(readEvidence(o?.evidence))
  }
  return { ops, evidence, rejected }
}

const statusText: Record<IssueStatus, string> = {
  doing: '착수', done: '완수', todo: '대기', question: '질문 대기', dropped: '중단',
}

/** Describes the notices caused by one append, using the state before it. */
export function describe(events: readonly TrackerEvent[], before: readonly Issue[]): string[] {
  const state = new Map(before.map(i => [i.id, { title: i.title, status: i.status }]))
  const out: string[] = []
  for (const e of events) {
    const current = state.get(e.issue)
    const title = current?.title ?? e.issue
    if (e.op === 'create') {
      state.set(e.issue, { title: e.title, status: e.status })
      out.push(`작업 '${e.title}' 추가`)
    } else if (e.op === 'status') {
      if (current?.status !== e.status) out.push(`작업 '${title}' ${statusText[e.status]}`)
      if (current) current.status = e.status
    } else if (e.op === 'progress') {
      out.push(`작업 '${title}' 진행 (${e.done}/${e.total})`)
    } else if (e.op === 'retitle') {
      out.push(`작업 '${title}' 재조정 -> '${e.title}'`)
      if (current) current.title = e.title
    } else if (e.op === 'task') {
      // Task ids are projection state, not a user-facing tracker change.
    } else if (e.op === 'note') {
      out.push(`작업 '${title}' 메모: ${clip((e.text.split(/\r?\n/, 1)[0] ?? '').trim(), 60)}`)
    } else {
      out.push(`작업 '${title}' 연결: ${e.origin.repo}`)
    }
  }
  return out
}
