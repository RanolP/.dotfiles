// Copied from nix/home/configs/claude/mods/clm/hooks/tracker.ts.
import type { Worktree } from './worktree'
import { CONFIRM_ITEMS } from './evidence'

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
  | { op: 'retract-note' }
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
  | { op: 'retract-note'; issue: string }
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
    else if (e.op === 'retract-note') i.notes = []
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

export const DONE_SHOWN = 5
/** Ids of this session's done issues older than its newest DONE_SHOWN completions. */
export function archivedDone(issues: readonly Issue[], session: string): Set<string> {
  const done = issues.filter(i => i.status === 'done' && i.origin.session === session)
    .sort((a, b) => (b.doneOrder ?? 0) - (a.doneOrder ?? 0))
  return new Set(done.slice(DONE_SHOWN).map(i => i.id))
}

export const shownNote = (i: Pick<Issue, 'notes'>) => i.notes.findLast(n => !n.startsWith(CONFIRM_ITEMS))
