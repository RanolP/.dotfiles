// The tracker behind the ledger's 한 일 / 할 일 / 미결 질문 sections. State is
// global (every session, every repository) but written as one append-only log
// per session, so each file has a single writer session; that session's own
// concurrent writes (parallel tool calls) are serialized per session in
// register.ts `serialized`, since `$.fs` offers only a read-then-rewrite
// "append". Log contents are cached by the metadata returned from `$.fs.list`,
// so an unchanged session file is parsed once.

import { CONFIRM_ITEMS, readEvidence, storedItems, type Evidence } from './evidence'
import type { Worktree } from './worktree'

export const STATUSES = ['todo', 'doing', 'ready-to-land', 'done', 'question', 'uncertain', 'dropped'] as const
export type IssueStatus = (typeof STATUSES)[number]
export type AssumptionStatus = 'live' | 'merged' | 'rejected'
export type AssumptionLabel = string[][]
export type LabelVisibility = 'main' | 'branch' | 'invalid'
export const isStatus = (v: unknown): v is IssueStatus => typeof v === 'string' && (STATUSES as readonly string[]).includes(v)
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
export const isAssumptionLabel = (value: unknown): value is AssumptionLabel => Array.isArray(value)
  && value.every(environment => Array.isArray(environment) && environment.every(id => typeof id === 'string'))

/** A step's done state: a command that exits 0, or a criterion a cited transcript quote must prove. */
export type RubricItem =
  | { id: string; kind: 'command'; argv: string[]; cwd?: string }
  | { id: string; kind: 'evidence'; criterion: string }
export type Verdict = 'pass' | 'fail'
export type Attempt = { method: string; verdict: Verdict; ts: string }
export type Method = { text: string; failed: boolean; failures?: number }
export type StepSpan = { startFp?: string; endFp?: string; startToolUseId?: string; endToolUseId?: string }
export type StepResult = { intent: string; finding: string; decision: string; files: string[]; source: 'model' | 'judge' | 'fold'; ts: string; span?: StepSpan }

export type Origin = { session: string; repo: string; branch?: string; cwd: string }
type Base = { ts: string; seq: number; issue: string; origin: Origin }
type Create = { op: 'create'; title: string; status: IssueStatus; note?: string; taskId?: string; label?: AssumptionLabel; hypothesis?: true }
export type Intent = 'continue' | 'handoff' | 'interleave' | 'pending' | 'question'
export type FocusState = { stack: string[]; pending: string[] }
export type TrackerEvent = Base & (
  | Create
  | { op: 'status'; status: IssueStatus; startToolUseId?: string }
  | { op: 'retitle'; title: string }
  | { op: 'progress'; done: number; total: number }
  | { op: 'task'; taskId: string }
  | { op: 'note'; text: string }
  | { op: 'plan'; priority?: number; ready?: boolean }
  | { op: 'claim'; by: string | null }
  // Links `issue` to `origin.session`, so it is injected there whatever its repo.
  | { op: 'link' }
  | { op: 'parent'; parent: string | null; planBatch?: true }
  | { op: 'label'; label?: AssumptionLabel }
  | { op: 'resolve'; decision: 'close' | 'keep'; onto?: string | null }
  | { op: 'focus'; stack: string[]; pending: string[]; intent: Intent; rule?: string }
  // Stepped goal: the root is planned into steps, each with a rubric, attempts and methodologies.
  | { op: 'stepped' }
  | { op: 'planned'; mode: 'inline' }
  | { op: 'result'; intent: string; finding: string; decision: string; files: string[]; source: StepResult['source']; span?: StepSpan }
  | { op: 'rubric'; items: RubricItem[] }
  | { op: 'attempt'; method: string; verdict: Verdict }
  | { op: 'method'; text: string; failed: boolean }
  | ({ op: 'worktree' } & Worktree)
  | { op: 'checkpoint'; sha: string }
  | { op: 'land' }
)
export type Payload =
  | { op: 'create'; issue?: string; title: string; status: IssueStatus; note?: string; taskId?: string; label?: AssumptionLabel; hypothesis?: true }
  | { op: 'status'; issue: string; status: IssueStatus; startToolUseId?: string }
  | { op: 'retitle'; issue: string; title: string }
  | { op: 'progress'; issue: string; done: number; total: number }
  | { op: 'task'; issue: string; taskId: string }
  | { op: 'note'; issue: string; text: string }
  | { op: 'plan'; issue: string; priority?: number; ready?: boolean }
  | { op: 'claim'; issue: string; by: string | null }
  | { op: 'link'; issue: string }
  | { op: 'parent'; issue: string; parent: string | null; planBatch?: true }
  | { op: 'label'; issue: string; label?: AssumptionLabel }
  | { op: 'resolve'; issue: string; decision: 'close' | 'keep'; onto?: string | null }
  | { op: 'focus'; stack: string[]; pending: string[]; intent: Intent; rule?: string }
  | { op: 'stepped'; issue: string }
  | { op: 'planned'; issue: string; mode: 'inline' }
  | { op: 'result'; issue: string; intent: string; finding: string; decision: string; files: string[]; source: StepResult['source']; span?: StepSpan }
  | { op: 'rubric'; issue: string; items: RubricItem[] }
  | { op: 'attempt'; issue: string; method: string; verdict: Verdict }
  | { op: 'method'; issue: string; text: string; failed: boolean }
  | ({ op: 'worktree'; issue: string } & Worktree)
  | { op: 'checkpoint'; issue: string; sha: string }
  | { op: 'land'; issue: string }

export type Issue = {
  id: string
  title: string
  status: IssueStatus
  progress?: { done: number; total: number }
  origin: Origin
  notes: string[]
  linked: string[]
  taskId?: string
  parent?: string
  updated: string
  /** Position of the event that last made this issue done, in snapshot order; later is larger. */
  doneOrder?: number
  /** The root of a stepped goal: its children are planned steps. */
  stepped?: true
  planMode?: 'inline' | 'planner'
  planRevision?: number
  result?: StepResult
  startToolUseId?: string
  /** The latest settled rubric; a later `rubric` op replaces it whole. */
  rubric?: RubricItem[]
  attempts?: Attempt[]
  /** One entry per method text; each failed rollback adds one failure count, while later declarations cannot clear it. */
  methods?: Method[]
  /** Most recently declared strategy, including a repeated declaration of a failed strategy. */
  activeMethod?: string
  /** The goal's isolated checkout, stored on its stepped root. */
  worktree?: Worktree
  /** Successful checkpoint commits, stored on each step. */
  checkpoints?: Array<{ sha: string; ts: string }>
  /** The one-time landing commands were already handed back to the main agent. */
  landCommandsShown?: boolean
  priority?: number
  ready?: boolean
  claimedBy?: string
  label?: AssumptionLabel
  hypothesis?: true
  resolution?: 'closed'
}

export const assumptionStatusOfIssue = (issue: Pick<Issue, 'status'>): AssumptionStatus =>
  issue.status === 'dropped' ? 'rejected' : issue.status === 'done' ? 'merged' : 'live'
export function labelVisibility(label: AssumptionLabel | undefined, status: (id: string) => AssumptionStatus | undefined): LabelVisibility {
  if (label === undefined) return 'main'
  const known = label.map(environment => environment.filter(id => status(id) !== undefined))
  if (known.some(environment => environment.length === 0)) return 'main'
  const surviving = known.filter(environment => !environment.some(id => status(id) === 'rejected'))
  if (!surviving.length) return 'invalid'
  return surviving.some(environment => environment.every(id => status(id) === 'merged')) ? 'main' : 'branch'
}
export function effectiveIssueLabel(issue: Issue, byId: ReadonlyMap<string, Issue>): AssumptionLabel | undefined {
  const ancestors: string[] = []
  const seen = new Set<string>()
  let parent = issue.parent ? byId.get(issue.parent) : undefined
  while (parent && !seen.has(parent.id)) { if (parent.hypothesis) ancestors.push(parent.id); seen.add(parent.id); parent = parent.parent ? byId.get(parent.parent) : undefined }
  if (!ancestors.length) return issue.label
  return (issue.label ?? [[]]).map(environment => [...new Set([...environment, ...ancestors])])
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
          ...(e.taskId ? { taskId: e.taskId } : {}), ...(e.label ? { label: e.label.map(environment => [...environment]) } : {}),
          ...(e.hypothesis ? { hypothesis: true } : {}), updated: e.ts, ...(e.status === 'done' ? { doneOrder: n } : {}),
        })
      continue
    }
    if (e.op === 'focus') continue
    const i = issues.get(e.issue)
    if (!i) continue
    if (e.op === 'status') {
      i.status = e.status
      if (e.status === 'doing' && e.startToolUseId) i.startToolUseId = e.startToolUseId
      if (e.status === 'done') i.doneOrder = n
      if (e.status === 'dropped' && i.parent) {
        const root = issues.get(i.parent)
        if (root?.planMode) root.planRevision = (root.planRevision ?? 0) + 1
      }
    }
    else if (e.op === 'retitle') {
      i.title = e.title
      if (i.parent) {
        const root = issues.get(i.parent)
        if (root?.planMode) root.planRevision = (root.planRevision ?? 0) + 1
      }
    }
    else if (e.op === 'progress') i.progress = { done: e.done, total: e.total }
    else if (e.op === 'task') i.taskId = e.taskId
    else if (e.op === 'note') i.notes.push(e.text)
    else if (e.op === 'plan') {
      if (e.priority !== undefined) i.priority = e.priority
      if (e.ready !== undefined) i.ready = e.ready
    }
    else if (e.op === 'claim') {
      if (e.by === null) delete i.claimedBy
      else i.claimedBy = e.by
    }
    else if (e.op === 'parent') {
      if (e.parent === null) delete i.parent
      else {
        i.parent = e.parent
        const root = issues.get(e.parent)
        if (root?.planMode) root.planRevision = e.planBatch ? root.planRevision ?? 1 : (root.planRevision ?? 0) + 1
      }
    }
    else if (e.op === 'label') {
      if (e.label === undefined) delete i.label
      else i.label = e.label.map(environment => [...environment])
    }
    else if (e.op === 'resolve') {
      if (e.decision === 'close') { i.status = 'dropped'; i.resolution = 'closed' }
      else {
        delete i.resolution
        delete i.label
        if (e.onto === undefined || e.onto === null) delete i.parent
        else i.parent = e.onto
      }
    }
    else if (e.op === 'stepped') { i.stepped = true; i.planMode = 'planner' }
    else if (e.op === 'planned') i.planMode = e.mode
    else if (e.op === 'result') i.result = {
      intent: e.intent, finding: e.finding, decision: e.decision, files: [...e.files], source: e.source, ts: e.ts,
      ...(e.span ? { span: { ...e.span } } : {}),
    }
    else if (e.op === 'rubric') i.rubric = e.items.map(item => ({ ...item }))
    else if (e.op === 'attempt') (i.attempts ??= []).push({ method: e.method, verdict: e.verdict, ts: e.ts })
    else if (e.op === 'method') {
      const methods = (i.methods ??= [])
      i.activeMethod = e.text
      const known = methods.find(m => m.text === e.text)
      if (known) {
        if (e.failed) {
          known.failures = (known.failures ?? (known.failed ? 1 : 0)) + 1
          known.failed = true
        }
      } else methods.push({ text: e.text, failed: e.failed, ...(e.failed ? { failures: 1 } : {}) })
    }
    else if (e.op === 'worktree') {
      i.worktree = { dir: e.dir, baseSha: e.baseSha, originBranch: e.originBranch, repoRoot: e.repoRoot, worktreesRoot: e.worktreesRoot, headSha: e.headSha }
    }
    else if (e.op === 'checkpoint') {
      (i.checkpoints ??= []).push({ sha: e.sha, ts: e.ts })
      const root = i.parent === undefined ? undefined : issues.get(i.parent)
      if (root?.worktree) root.worktree = { ...root.worktree, headSha: e.sha }
    }
    else if (e.op === 'land') {
      i.landCommandsShown = true
    }
    else if (e.op === 'link' && !i.linked.includes(e.origin.session)) i.linked.push(e.origin.session)
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
      case 'create': return {
        ...base, issue: p.issue ?? issueId(origin.session, seq), op: 'create', title: p.title, status: p.status,
        ...(p.note === undefined ? {} : { note: p.note }), ...(p.taskId === undefined ? {} : { taskId: p.taskId }),
        ...(p.label === undefined ? {} : { label: p.label.map(environment => [...environment]) }), ...(p.hypothesis ? { hypothesis: true } : {}),
      }
      case 'status': return { ...base, issue: p.issue, op: 'status', status: p.status, ...(p.startToolUseId ? { startToolUseId: p.startToolUseId } : {}) }
      case 'retitle': return { ...base, issue: p.issue, op: 'retitle', title: p.title }
      case 'progress': return { ...base, issue: p.issue, op: 'progress', done: p.done, total: p.total }
      case 'task': return { ...base, issue: p.issue, op: 'task', taskId: p.taskId }
      case 'note': return { ...base, issue: p.issue, op: 'note', text: p.text }
      case 'plan': return {
        ...base, issue: p.issue, op: 'plan',
        ...(p.priority === undefined ? {} : { priority: p.priority }), ...(p.ready === undefined ? {} : { ready: p.ready }),
      }
      case 'claim': return { ...base, issue: p.issue, op: 'claim', by: p.by }
      case 'link': return { ...base, issue: p.issue, op: 'link' }
      case 'parent': return { ...base, issue: p.issue, op: 'parent', parent: p.parent, ...(p.planBatch ? { planBatch: true as const } : {}) }
      case 'label': return { ...base, issue: p.issue, op: 'label', ...(p.label === undefined ? {} : { label: p.label.map(environment => [...environment]) }) }
      case 'resolve': return { ...base, issue: p.issue, op: 'resolve', decision: p.decision, ...(p.onto === undefined ? {} : { onto: p.onto }) }
      case 'stepped': return { ...base, issue: p.issue, op: 'stepped' }
      case 'planned': return { ...base, issue: p.issue, op: 'planned', mode: p.mode }
      case 'result': return { ...base, issue: p.issue, op: 'result', intent: p.intent, finding: p.finding, decision: p.decision, files: [...p.files], source: p.source, ...(p.span ? { span: { ...p.span } } : {}) }
      case 'rubric': return { ...base, issue: p.issue, op: 'rubric', items: p.items.map(item => ({ ...item })) }
      case 'attempt': return { ...base, issue: p.issue, op: 'attempt', method: p.method, verdict: p.verdict }
      case 'method': return { ...base, issue: p.issue, op: 'method', text: p.text, failed: p.failed }
      case 'worktree': return { ...base, ...p }
      case 'checkpoint': return { ...base, issue: p.issue, op: 'checkpoint', sha: p.sha }
      case 'land': return { ...base, issue: p.issue, op: 'land' }
      // Focus snapshots are session metadata, so the log's issue key is the session id.
      case 'focus': return { ...base, issue: origin.session, op: 'focus', stack: [...p.stack], pending: [...p.pending], intent: p.intent, ...(p.rule === undefined ? {} : { rule: p.rule }) }
    }
  })
}

/** The latest main-agent focus snapshot for one session. */
export function focusOf(events: readonly TrackerEvent[], session: string): FocusState {
  let latest: TrackerEvent | undefined
  for (const event of events) {
    if (event.op === 'focus' && event.issue === session && event.origin.session === session && (!latest || latest.op !== 'focus' || event.seq > latest.seq))
      latest = event
  }
  return latest?.op === 'focus' ? { stack: [...latest.stack], pending: [...latest.pending] } : { stack: [], pending: [] }
}

export const isOpen = (i: Issue) => i.status === 'todo' || i.status === 'doing' || i.status === 'ready-to-land' || i.status === 'question' || i.status === 'uncertain'

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
export const TRACKER_SECTIONS: Record<string, readonly IssueStatus[]> = { '한 일': ['done'], '할 일': ['doing', 'ready-to-land', 'todo'], '미결 질문': ['question'], 'uncertain': ['uncertain'] }
export const isTrackerSection = (s: string) => s in TRACKER_SECTIONS

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const flat = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim()

/** The issue's last note meant for people: a confirm question's stored item list is data, not a note to show. */
export const shownNote = (i: Pick<Issue, 'notes'>) => i.notes.findLast(n => !n.startsWith(CONFIRM_ITEMS))

export const issueLine = (i: Issue) => {
  const note = shownNote(i)
  return `- ${i.status === 'doing' ? '(doing) ' : ''}${i.title}${i.progress ? ` (${i.progress.done}/${i.progress.total})` : ''}${note ? ` — ${note}` : ''} [${i.id}]`
}

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
export function parseOps(raw: string, known: ReadonlySet<string>, knownAssumptions: ReadonlySet<string> = known): { ops: Payload[]; evidence: Evidence[][]; rejected: number } | string {
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
    if (o?.op === 'label' && o.label !== undefined && isAssumptionLabel(o.label) === false) return 'ops contain an invalid label'
    if (o?.op === 'label' && isAssumptionLabel(o.label) && o.label.some(environment => environment.some(id => !knownAssumptions.has(id))))
      { rejected++; continue }
    const before = ops.length
    const title = text(o?.title, 200), note = text(o?.note ?? o?.text, 300)
    // `uncertain` and `ready-to-land` stay parseable in stored events, but no fold op may produce them.
    if (o?.op === 'create' && title && isStatus(o.status) && o.status !== 'dropped' && o.status !== 'uncertain' && o.status !== 'ready-to-land')
      ops.push({ op: 'create', title, status: o.status, ...(note ? { note } : {}) })
    else if (o?.op === 'status' && typeof o.issue === 'string' && known.has(o.issue) && isStatus(o.status) && o.status !== 'uncertain' && o.status !== 'ready-to-land')
      ops.push({ op: 'status', issue: o.issue, status: o.status })
    else if (o?.op === 'retitle' && typeof o.issue === 'string' && known.has(o.issue) && title)
      ops.push({ op: 'retitle', issue: o.issue, title })
    else if (o?.op === 'progress' && typeof o.issue === 'string' && known.has(o.issue) && integer(o.done) && integer(o.total) && o.total >= 1 && o.done >= 0 && o.done <= o.total)
      ops.push({ op: 'progress', issue: o.issue, done: o.done, total: o.total })
    else if (o?.op === 'note' && typeof o.issue === 'string' && known.has(o.issue) && note)
      ops.push({ op: 'note', issue: o.issue, text: note })
    else if (o?.op === 'label' && typeof o.issue === 'string' && known.has(o.issue) && (o.label === undefined || isAssumptionLabel(o.label)))
      ops.push({ op: 'label', issue: o.issue, ...(o.label === undefined ? {} : { label: o.label }) })
    else if (o?.op === 'assumption' && typeof o.id === 'string' && known.has(o.id) && (o.status === 'merged' || o.status === 'rejected'))
      ops.push({ op: 'status', issue: o.id, status: o.status === 'merged' ? 'done' : 'dropped' })
    else if (o?.op === 'resolve' && typeof o.id === 'string' && known.has(o.id) && (o.decision === 'close' || o.decision === 'keep')
      && (o.onto === undefined || o.onto === null || (typeof o.onto === 'string' && known.has(o.onto))))
      ops.push({ op: 'resolve', issue: o.id, decision: o.decision, ...(o.onto === undefined ? {} : { onto: o.onto }) })
    else rejected++
    if (ops.length > before) evidence.push(readEvidence(o?.evidence))
  }
  return { ops, evidence, rejected }
}

const statusText: Record<IssueStatus, string> = {
  doing: '착수', 'ready-to-land': '반영 대기', done: '완수', todo: '대기', question: '질문 대기', uncertain: '불확실', dropped: '중단',
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
    } else if (e.op === 'plan') {
      const fields = [e.priority === undefined ? undefined : `priority ${e.priority}`, e.ready === undefined ? undefined : `ready ${e.ready}`].filter(Boolean).join(', ')
      out.push(`작업 '${title}' 계획 갱신${fields ? ` (${fields})` : ''}`)
    } else if (e.op === 'claim') {
      out.push(`작업 '${title}' 담당: ${e.by ?? '(none)'}`)
    } else if (e.op === 'retitle') {
      out.push(`작업 '${title}' 재조정 -> '${e.title}'`)
      if (current) current.title = e.title
    } else if (e.op === 'task') {
      // Task ids are projection state, not a user-facing tracker change.
    } else if (e.op === 'parent') {
      out.push(`작업 '${title}' 상위 작업: ${e.parent ? state.get(e.parent)?.title ?? e.parent : '(none)'}`)
    } else if (e.op === 'focus') {
      out.push(`주 작업 초점 갱신 (${e.intent})`)
    } else if (e.op === 'stepped') {
      out.push(`작업 '${title}' 단계 목표로 지정`)
    } else if (e.op === 'planned') {
      out.push(`작업 '${title}' 인라인 계획으로 지정`)
    } else if (e.op === 'result') {
      // Step results render in the plan ledger rather than as duplicate notices.
    } else if (e.op === 'rubric') {
      out.push(`작업 '${title}' 완료 기준 ${e.items.length}개 확정`)
    } else if (e.op === 'attempt') {
      out.push(`작업 '${title}' 시도 ${e.verdict === 'pass' ? '통과' : '실패'}: ${clip(flat(e.method), 60)}`)
    } else if (e.op === 'method') {
      out.push(`작업 '${title}' 방법론 ${e.failed ? '실패 기록' : '기록'}: ${clip(flat(e.text), 60)}`)
    } else if (e.op === 'worktree' || e.op === 'checkpoint' || e.op === 'land') {
      // Execution metadata is persisted for the Stop hook, not shown as task progress.
    } else if (e.op === 'note' && e.text.startsWith(CONFIRM_ITEMS)) {
      out.push(`작업 '${title}' 확인 대기 ${storedItems(e.text)?.length ?? 0}건`)
    } else if (e.op === 'note') {
      out.push(`작업 '${title}' 메모: ${clip((e.text.split(/\r?\n/, 1)[0] ?? '').trim(), 60)}`)
    } else {
      out.push(`작업 '${title}' 연결: ${e.origin.repo}`)
    }
  }
  return out
}
