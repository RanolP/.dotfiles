import type { BuiltinToolInputs, EngineInterface, Register, SessionMessage } from 'claude-code'

import { boardHtml } from './board'
import {
  buildCleared, fingerprint, isLedgerRow, isPrompt, isSystemRow, ledgerRowSeq, ledgerRowText, liveRows, planClear, protectedIndex, sum, visibleTokens,
  type Boundary, type ClearPlan,
} from './fold'
import {
  composeLedger, EMPTY_LEDGER, fallbackLedger, instructionValues, issueList, legacyItems, MERGE_SYSTEM, mergeableNotes, normalizeLedger, notesOf, oversizeLines, parseChanges, parseMerge,
  preservedLines, preserveInstructions, rememberOversize, rememberPreserved, renderTurns, withheldLines, withheldPointer,
  WITHDRAWN_PREFIX,
} from './ledger'
import {
  archivedDone, describe, injected, normalizeRemote, parseLog, parseOps, snapshot, staleOpenCount, toEvents,
  type Issue, type Origin, type Payload, type TrackerEvent,
} from './tracker'

// clm replaces the engine's compaction for the main conversation. When the
// rows outgrow a token budget, a cheap model folds the turns about to go into a
// ledger (goal, user instructions, work done, work left, open questions, key
// facts), and this plugin's `session.compact` hook rewrites the transcript to
// [first request, ledger row, newest turns]. The engine summarizer never runs:
// every main-session compaction, /compact and the engine's own threshold
// included, is answered here, and the ahead-of-time `precompute` is refused.
//
// 한 일, 할 일 and 미결 질문 are not merged text: they are rendered from the
// tracker (tracker.ts), and the merge model only emits ops against it, so an
// item it forgets to repeat stays where it was.
//
// Interactive sessions fold right after the turn that crossed the budget. A
// headless (-p / SDK) session refuses a plugin-raised compaction, so there the
// plan waits in the store for the next /compact or engine compaction.

const FAILS_BEFORE_FALLBACK = 3
const HYSTERESIS_FLOOR = 0.9

// --- options -------------------------------------------------------------

export type Opts = { budget: number; tailTarget: number; reserve: number }
/** Reads userConfig, naming every value it could not use and the value used instead. */
export function readOpts(o: Record<string, unknown>): { opts: Opts; problems: string[] } {
  const problems: string[] = []
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
  let budget = 32000
  if (o.budget !== undefined) {
    if (isInt(o.budget) && o.budget >= 2000) budget = o.budget
    else {
      budget = typeof o.budget === 'number' && Number.isFinite(o.budget) && o.budget > 0 ? Math.max(2000, Math.round(o.budget)) : 32000
      problems.push(`budget=${JSON.stringify(o.budget)} must be an integer of at least 2000; using ${budget}`)
    }
  }
  const half = Math.floor(budget / 2)
  let tailTarget = half
  if (o.tailTarget !== undefined && o.tailTarget !== 0) {
    if (isInt(o.tailTarget) && o.tailTarget > 0 && o.tailTarget < budget) tailTarget = o.tailTarget
    else problems.push(`tailTarget=${JSON.stringify(o.tailTarget)} must be a positive integer under the budget (${budget}); using ${half}`)
  }
  const defReserve = Math.min(2048, Math.floor(budget / 4))
  let reserve = defReserve
  if (o.reserve !== undefined && o.reserve !== 0) {
    if (isInt(o.reserve) && o.reserve > 0 && o.reserve < budget) reserve = o.reserve
    else problems.push(`reserve=${JSON.stringify(o.reserve)} must be a positive integer under the budget (${budget}); using ${defReserve}`)
  }
  return { opts: { budget, tailTarget, reserve }, problems }
}

// --- session state -------------------------------------------------------

// A fold's `ops` wait here and reach the tracker only in session.compact, when
// the fold is applied, so a planned fold that never lands (a headless session,
// a re-fold) cannot leave issues behind for the next one to duplicate. The
// tracker writes at call time are mirrorModelTask, for the model's own task
// calls, and stepOnce, for the steps each tool call shows.
type Pending = {
  notes: string; fullNotes: string; ops: Payload[]; seq: number; keepFp?: string; keepFrom: number; dropFps: string[]
  cuts: Record<string, number>; keptTurns: number; fallback: boolean; foldMs?: number
}
// `foldTokens` is the usage reading taken when the last fold landed: the
// engine keeps reporting it until the next API response, so an equal reading
// describes the transcript before that fold and is ignored.
export type Meta = { seq: number; lastClear?: string; lastFoldAt?: number; foldDurationsMs?: Record<string, number>; foldTokens?: number; boundary?: Boundary; lastSkip?: string; fails: number; ratio?: number; overhead?: number; lastObserved?: number }
const sid = ($: EngineInterface) => $.session.id()
const metaKey = async ($: EngineInterface) => `ledger:${await sid($)}`
const pendingKey = async ($: EngineInterface) => `pending:${await sid($)}`
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumberRecord = (v: unknown): v is Record<string, number> => isRecord(v) && Object.values(v).every(n => typeof n === 'number')
const optional = (v: unknown, type: 'number' | 'string') => v === undefined || typeof v === type
const isMeta = (v: unknown): v is Partial<Meta> =>
  isRecord(v) && optional(v.seq, 'number') && optional(v.fails, 'number') && optional(v.ratio, 'number') && optional(v.overhead, 'number')
  && optional(v.foldTokens, 'number') && optional(v.lastFoldAt, 'number') && (v.foldDurationsMs === undefined || isNumberRecord(v.foldDurationsMs)) && optional(v.lastClear, 'string') && (v.boundary === undefined || isRecord(v.boundary))
const isPending = (v: unknown): v is Pending =>
  isRecord(v) && typeof v.notes === 'string' && typeof v.fullNotes === 'string' && Array.isArray(v.ops) && typeof v.seq === 'number'
  && optional(v.keepFp, 'string') && typeof v.keepFrom === 'number' && Array.isArray(v.dropFps) && v.dropFps.every(f => typeof f === 'string')
  && isRecord(v.cuts) && typeof v.keptTurns === 'number' && typeof v.fallback === 'boolean' && optional(v.foldMs, 'number')
async function readMeta($: EngineInterface): Promise<Meta> {
  const stored = await $.store.get(await metaKey($))
  return { seq: 0, fails: 0, ...(isMeta(stored) ? stored : {}) }
}
const writeMeta = async ($: EngineInterface, m: Meta) => $.store.set(await metaKey($), m)

async function basePath($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  return `${home ?? '.'}/.claude-work/plans/clm-${await sid($)}`
}
const ledgerPath = async ($: EngineInterface) => `${await basePath($)}.md`
const logPath = async ($: EngineInterface) => `${await basePath($)}.log.jsonl`
async function readText($: EngineInterface, p: string): Promise<string | undefined> {
  return (await $.fs.exists(p)) ? await $.fs.read(p) : undefined
}

export type LogEvent = 'clear' | 'skip-not-shrinking' | 'merge-invalid' | 'merge-timeout' | 'ops-rejected' | 'fallback' | 'truncation' | 'escape' | 'panel-relink'
type LogFields = { tokensBefore?: number; tokensAfter?: number; keptTurns?: number; ratio?: number; reason?: string }
const LOG_KEEP = 200
async function logEvent($: EngineInterface, event: LogEvent, f: LogFields) {
  try {
    const p = await logPath($)
    const lines = ((await readText($, p)) ?? '').split('\n').filter(Boolean)
    lines.push(JSON.stringify({ ts: new Date().toISOString(), event, ...f }))
    await $.fs.write(p, `${lines.slice(-LOG_KEEP).join('\n')}\n`)
  } catch { /* the log must never stop a fold */ }
}

const RATIO_MIN = 1, RATIO_MAX = 4
const shownChanges = new Map<string, Set<string>>()
const changeHash = (line: string): string => {
  let h = 2166136261
  for (let i = 0; i < line.length; i++) h = Math.imul(h ^ line.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16)
}
// clm-prompt
const TURN_CHANGE_SYSTEM = 'Summarize only concrete non-task context changes from the finished coding turn. Reply with <changes>, at most three short Korean lines, or <changes></changes> when nothing changed.'
/** The engine's live context tokens, when it has a reading. */
async function usageReading($: EngineInterface): Promise<number | undefined> {
  try {
    const { tokens } = (await $.session.usage()).context
    return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : undefined
  } catch {
    return undefined
  }
}
const freshReal = (reading: number | undefined, meta: Meta) => (reading !== meta.foldTokens ? reading : undefined)
const clampRatio = (n: number) => Math.round(Math.min(RATIO_MAX, Math.max(RATIO_MIN, n)) * 1000) / 1000

async function skip($: EngineInterface, why: string) {
  $.ui.log(`clm: fold skipped, ${why}`, { to: 'debug' })
  await writeMeta($, { ...(await readMeta($)), lastSkip: why })
}

// --- tracker I/O -----------------------------------------------------------

async function trackerDir($: EngineInterface): Promise<string> {
  return `${(await $.env.get('HOME')) ?? '.'}/.claude-work/tracker/events`
}
const logFile = async ($: EngineInterface, session: string) => `${await trackerDir($)}/${session}.jsonl`

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', ...args], { cwd, timeoutMs: 5000 })
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined
  } catch {
    return undefined
  }
}

/** repo is the origin remote, else the worktree's top level, else the cwd. */
async function captureOrigin($: EngineInterface): Promise<Origin> {
  const session = await $.session.id()
  const cwd = await $.session.cwd()
  const remote = await git($, cwd, ['remote', 'get-url', 'origin'])
  const repo = remote ? normalizeRemote(remote) : ((await git($, cwd, ['rev-parse', '--show-toplevel'])) ?? cwd)
  const branch = await git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return { session, repo, ...(branch ? { branch } : {}), cwd }
}

type CachedLog = { size: number; mtimeMs: number; events: TrackerEvent[] }
const trackerCache = new Map<string, CachedLog>()
async function readAll($: EngineInterface): Promise<TrackerEvent[]> {
  const dir = await trackerDir($)
  if (!(await $.fs.exists(dir))) return []
  const out: TrackerEvent[] = []
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
    try {
      const cached = trackerCache.get(f.name)
      const events = cached && cached.size === f.size && cached.mtimeMs === f.mtimeMs
        ? cached.events
        : parseLog(await $.fs.read(dir + '/' + f.name))
      trackerCache.set(f.name, { size: f.size, mtimeMs: f.mtimeMs, events })
      out.push(...events)
    } catch (err) {
      $.ui.log(`clm tracker: could not read ${f.name} (${String(err).slice(0, 120)})`, { to: 'debug' })
    }
  }
  return out
}

// Each session's log is a read-then-rewrite; parallel tool calls (two
// TaskCreate in one response) would otherwise both read the same lastSeq and
// the second write would drop the first's events. Every write of one session
// runs on this chain, one after another.
const writeChains = new Map<string, Promise<unknown>>()
function serialized<T>(session: string, run: () => Promise<T>): Promise<T> {
  const result = (writeChains.get(session) ?? Promise.resolve()).then(run, run)
  writeChains.set(session, result.then(() => undefined, () => undefined))
  return result
}

/** Writes events to this session's log; only this session ever writes that file. Callers hold `serialized`. */
async function writeEvents($: EngineInterface, payloads: readonly Payload[], o: Origin): Promise<TrackerEvent[]> {
  const p = await logFile($, o.session)
  const prev = (await $.fs.exists(p)) ? await $.fs.read(p) : ''
  const lastSeq = parseLog(prev).reduce((n, e) => Math.max(n, e.seq), 0)
  const events = toEvents(payloads, o, lastSeq, new Date().toISOString())
  const body = prev && !prev.endsWith('\n') ? `${prev}\n` : prev
  await $.fs.write(p, `${body}${events.map(e => JSON.stringify(e)).join('\n')}\n`)
  return events
}

// `project` is false where the caller projects later, once its own writes are
// done. `knownTitles` drops a model-derived create whose title an open or done
// issue of this session already carries: per-tool-call steps and the fold read
// overlapping turns, and whichever lands second must not add the step again.
async function append($: EngineInterface, payloads: readonly Payload[], origin?: Origin, project = true, knownTitles = false): Promise<TrackerEvent[]> {
  if (payloads.length === 0) return []
  const o = origin ?? (await captureOrigin($))
  return serialized(o.session, async () => {
    const before = snapshot(await readAll($))
    const titles = new Set(knownTitles ? before.filter(i => i.origin.session === o.session && i.status !== 'dropped').map(i => i.title.trim()) : [])
    const fresh = payloads.filter(p => (p.op !== 'status' || before.find(i => i.id === p.issue)?.status !== p.status)
      && !(p.op === 'create' && titles.has(p.title.trim())))
    if (fresh.length === 0) return []
    const events = await writeEvents($, fresh, o)
    try {
      for (const l of describe(events, before)) $.ui.log(l)
    } catch { /* display notices never block tracker writes */ }
    if (project) await syncPanelSafely($, o, events)
    return events
  })
}

export async function sessionIssues($: EngineInterface, query: { issue?: string; status?: Issue['status'] } = {}): Promise<Issue[]> {
  const session = (await captureOrigin($)).session
  return snapshot(await readAll($)).filter(i => i.origin.session === session
    && (query.issue === undefined || i.id === query.issue)
    && (query.status === undefined || i.status === query.status))
}

export async function trackIssue($: EngineInterface, input: { title: string; status: Issue['status']; issue?: string }): Promise<Issue> {
  const origin = await captureOrigin($)
  if (input.issue !== undefined) {
    const before = (await sessionIssues($, { issue: input.issue }))[0]
    if (!before) throw new Error(`clm issue ${input.issue} does not belong to this session`)
    if (before.status !== input.status) await append($, [{ op: 'status', issue: input.issue, status: input.status }], origin)
    const updated = (await sessionIssues($, { issue: input.issue }))[0]
    if (!updated) throw new Error('clm tracker did not return the tracked issue')
    return updated
  }
  const title = input.title.trim()
  if (!title) throw new Error('clm issue title must not be empty')
  const events = await append($, [{ op: 'create', title, status: input.status }], origin)
  const issueId = events[0]?.issue
  const issue = issueId ? (await sessionIssues($, { issue: issueId }))[0] : undefined
  if (!issue) throw new Error('clm tracker did not return the tracked issue')
  return issue
}

const PANEL_STATUS: Record<Issue['status'], 'pending' | 'in_progress' | 'completed' | 'deleted'> = {
  todo: 'pending', doing: 'in_progress', done: 'completed', dropped: 'deleted', question: 'pending',
}
const panelSubject = (i: Issue) => `${i.status === 'question' ? '질문: ' : ''}${i.title}${i.progress ? ` (${i.progress.done}/${i.progress.total})` : ''}`
const panelDescription = (i: Issue) => i.notes.at(-1) ?? i.title
const TASK_STATUS: Record<string, Issue['status'] | undefined> = {
  pending: 'todo', in_progress: 'doing', completed: 'done', deleted: 'dropped',
}

type ModelTaskCall =
  | ({ tool: 'TaskCreate' } & BuiltinToolInputs['TaskCreate'])
  | ({ tool: 'TaskUpdate' } & BuiltinToolInputs['TaskUpdate'])
// What a model task call became in the tracker: the issues it wrote, with
// their state afterwards, and the fields the tracker has no place for; or the
// panel task id no issue of this session carries.
type Mirrored = { recorded: Issue[]; unrecorded: string[] } | { unknownTask: string }

/** Turns the model's TaskCreate / TaskUpdate into tracker ops, appended now so the notice shows at call time. */
async function mirrorModelTask($: EngineInterface, e: ModelTaskCall): Promise<Mirrored> {
  const origin = await captureOrigin($)
  const issues = snapshot(await readAll($))
  const byTask = (taskId: string) => issues.find(i => i.origin.session === origin.session && i.taskId === taskId)
  const recordedAs = async (id: string | undefined, unrecorded: string[]): Promise<Mirrored> => {
    const after = id === undefined ? undefined : snapshot(await readAll($)).find(i => i.id === id)
    return { recorded: after ? [after] : [], unrecorded }
  }
  if (e.tool === 'TaskCreate') {
    const title = e.subject.trim(), note = e.description.trim()
    if (!title) return { recorded: [], unrecorded: [] }
    const events = await append($, [{ op: 'create', title, status: 'todo', ...(note ? { note } : {}) }], origin)
    return recordedAs(events[0]?.issue, e.metadata ? ['metadata'] : [])
  }
  const issue = byTask(e.taskId)
  if (!issue) return { unknownTask: e.taskId }
  const status = e.status ? TASK_STATUS[e.status] : undefined
  const named = (ids: readonly string[] | undefined) => (ids ?? []).map(t => byTask(t)?.id ?? `task ${t}`)
  const blockedBy = named(e.addBlockedBy), blocks = named(e.addBlocks)
  const subject = e.subject?.trim(), description = e.description?.trim()
  const ops: Payload[] = [
    ...(subject && subject !== issue.title ? [{ op: 'retitle' as const, issue: issue.id, title: subject }] : []),
    ...(description ? [{ op: 'note' as const, issue: issue.id, text: description }] : []),
    ...(blockedBy.length ? [{ op: 'note' as const, issue: issue.id, text: `blocked by ${blockedBy.join(', ')}` }] : []),
    ...(blocks.length ? [{ op: 'note' as const, issue: issue.id, text: `blocks ${blocks.join(', ')}` }] : []),
    ...(status ? [{ op: 'status' as const, issue: issue.id, status }] : []),
  ]
  await append($, ops, origin)
  return recordedAs(issue.id, [...(e.owner ? ['owner'] : []), ...(e.metadata ? ['metadata'] : [])])
}

// clm-prompt
function mirrorDeny(m: Mirrored): string {
  if ('unknownTask' in m)
    return `clm 트래커에 작업 ${m.unknownTask}이(가) 없다. 이 작업 변경은 답변 본문에 적어라; clm이 다음 정리 때 트래커에 옮긴다.`
  const lines = m.recorded.map(i => `clm이 트래커에 기록했다: ${i.id} '${i.title}' → ${i.status}`)
  if (m.unrecorded.length) lines.push(`${m.unrecorded.join(', ')}은(는) 트래커에 칸이 없다. 필요하면 답변 본문에 적어라.`)
  return lines.length ? lines.join('\n') : '이 작업 변경은 답변 본문에 적어라; clm이 다음 정리 때 트래커에 옮긴다.'
}

// The model's task calls are recorded in the tracker (and through it the
// panel) at call time; the deny tells the model what was recorded.
async function denyModelTask($: EngineInterface, e: ModelTaskCall): Promise<{ deny: string }> {
  try {
    return { deny: mirrorDeny(await mirrorModelTask($, e)) }
  } catch (err) {
    $.ui.log(`clm tracker: ${e.tool} mirror failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    // clm-prompt
    return { deny: 'clm이 이 작업 변경을 기록하지 못했다. 변경 내용을 답변 본문에 적어라; clm이 다음 정리 때 트래커에 옮긴다.' }
  }
}

async function createTask($: EngineInterface, issue: Issue): Promise<string> {
  const r = await $.tool.call({ tool: 'TaskCreate', subject: panelSubject(issue), description: panelDescription(issue) })
  if ('deny' in r || r.isError) throw new Error('TaskCreate was refused')
  return r.result.task.id
}

async function updateTask($: EngineInterface, taskId: string, issue: Issue, status = PANEL_STATUS[issue.status]): Promise<void> {
  const r = await $.tool.call({
    tool: 'TaskUpdate', taskId, subject: panelSubject(issue), description: panelDescription(issue), status,
  })
  if ('deny' in r || r.isError) throw new Error('TaskUpdate was refused')
  // A missing task can come back as success: false with no isError.
  if (!r.result.success) throw new Error(`TaskUpdate failed: ${r.result.error ?? 'success: false'}`)
}

// One pass over one snapshot: an issue without a task gets one (a dropped or
// archived one never needs it), a projected issue is updated only when it was
// touched by `events` or moved into or out of the archive by them, and the new
// task ids land in one write that does not project again. An archived done
// issue leaves the panel through the same deleted status a dropped one uses.
async function syncPanel($: EngineInterface, origin: Origin, events: readonly TrackerEvent[]): Promise<void> {
  const all = await readAll($)
  const fresh = new Set(events.map(e => e.seq))
  const issues = snapshot(all).filter(i => i.origin.session === origin.session)
  const archived = archivedDone(issues, origin.session)
  const archivedBefore = archivedDone(snapshot(all.filter(e => e.origin.session !== origin.session || !fresh.has(e.seq))), origin.session)
  const touched = new Set([
    ...events.map(e => e.issue),
    ...[...archived].filter(id => !archivedBefore.has(id)),
    ...[...archivedBefore].filter(id => !archived.has(id)),
  ])
  const panelStatus = (i: Issue) => (archived.has(i.id) ? 'deleted' : PANEL_STATUS[i.status])
  const links: Payload[] = []
  for (const issue of issues) {
    if (issue.taskId ? !touched.has(issue.id) || (archived.has(issue.id) && archivedBefore.has(issue.id)) : panelStatus(issue) === 'deleted') continue
    try {
      let taskId = issue.taskId
      if (!taskId) {
        taskId = await createTask($, issue)
        links.push({ op: 'task', issue: issue.id, taskId })
      } else {
        try {
          await updateTask($, taskId, issue, panelStatus(issue))
        } catch (err) {
          const oldTaskId = taskId
          taskId = await createTask($, issue)
          links.push({ op: 'task', issue: issue.id, taskId })
          await logEvent($, 'panel-relink', { reason: issue.id + ': ' + oldTaskId + ' -> ' + taskId + ' (' + String(err).slice(0, 120) + ')' })
          if (panelStatus(issue) !== 'pending') await updateTask($, taskId, issue, panelStatus(issue))
        }
      }
      if (!issue.taskId && panelStatus(issue) !== 'pending') await updateTask($, taskId, issue, panelStatus(issue))
    } catch (err) {
      $.ui.log(`clm task panel: ${issue.id} not projected (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
  }
  if (links.length) await writeEvents($, links, origin)
}

async function syncPanelSafely($: EngineInterface, origin: Origin, events: readonly TrackerEvent[]): Promise<void> {
  try {
    if (origin.session === await sid($)) await syncPanel($, origin, events)
  } catch (err) {
    $.ui.log(`clm task panel: projection failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}
const projectPanel = ($: EngineInterface, origin: Origin, events: readonly TrackerEvent[]) =>
  serialized(origin.session, () => syncPanelSafely($, origin, events))

// `/clm board` reads every session's log, writes a self-contained page and opens it.
async function openBoard($: EngineInterface) {
  const [events, here] = await Promise.all([readAll($), captureOrigin($)])
  const issues = snapshot(events).map(i => ({
    id: i.id, title: i.title, status: i.status, repo: i.origin.repo, ...(i.origin.branch ? { branch: i.origin.branch } : {}), updated: i.updated,
  }))
  const path = `${await basePath($)}.board.html`
  await $.fs.write(path, boardHtml(issues, here.repo, new Date().toISOString()))
  const r = await $.process.run(['open', path], { timeoutMs: 5000 })
  if (r.exitCode !== 0) $.ui.log(`clm: could not open the board at ${path} (exit ${r.exitCode}: ${r.stderr.slice(0, 160)})`)
  else $.ui.log(`clm: board opened (${path})`)
}

// --- folding -------------------------------------------------------------

// `finished` is this session's archived done issues, shown to the merge model
// only, so it does not re-create them from the turns being folded.
type TrackerView = { issues: Issue[]; stale: number; finished: Issue[]; doneTitles: Set<string> }
type Fold = { plan: ClearPlan; notes: string; fullNotes: string; ops: Payload[]; seq: number; fallback: boolean }

// The issues one session's ledger shows, with `ops` previewed on top when the
// fold has not appended them yet; ids then match what append assigns.
async function trackerView($: EngineInterface, here: Origin, ops: readonly Payload[] = []): Promise<TrackerView> {
  const events = await readAll($)
  const lastSeq = events.reduce((n, e) => (e.origin.session === here.session ? Math.max(n, e.seq) : n), 0)
  const all = snapshot([...events, ...toEvents(ops, here, lastSeq, new Date().toISOString())])
  const archived = archivedDone(all, here.session)
  const done = all.filter(i => i.status === 'done' && i.origin.session === here.session)
  return {
    issues: injected(all, here), stale: staleOpenCount(all, here),
    finished: done.filter(i => archived.has(i.id)), doneTitles: new Set(done.map(i => i.title.trim())),
  }
}

/**
 * Plans a fold of `rows` and merges the dropped turns into the ledger. Returns
 * the reason instead when there is nothing to fold, the merge failed and
 * `mustFold` is off, or the result would not be smaller. Updates `meta.fails`;
 * the caller writes `meta`.
 */
// `calibrate` is false on the escape retry, whose usage reading predates the
// withheld rows and so would inflate the ratio and overhead.
async function fold($: EngineInterface, opts: Opts, rows: readonly SessionMessage[], meta: Meta, mustFold: boolean, reading?: number, calibrate = true): Promise<Fold | string> {
  const observed = freshReal(reading ?? await usageReading($), meta)
  const calib = calibrate ? observed : undefined
  const estimated = sum(rows)
  const overhead = meta.overhead ?? 0
  // The ratio needs an overhead baseline (system prompt, tools) to subtract;
  // the first reading only sets that baseline, below.
  const ratio = calib === undefined || meta.overhead === undefined ? (meta.ratio ?? 1) : clampRatio(calib / Math.max(1, overhead + estimated))
  if (calib !== undefined) {
    if (meta.overhead !== undefined) meta.ratio = ratio
    meta.lastObserved = calib
  }
  const prev = (await readText($, await ledgerPath($))) ?? EMPTY_LEDGER
  const plan = planClear(rows, Math.max(0, (opts.tailTarget - overhead) / ratio), Math.ceil(prev.length / 4) + 60)
  if (!plan) return 'nothing left to fold'

  const here = await captureOrigin($)
  const view = await trackerView($, here)
  let notes = notesOf(prev)
  // Taken before the merge, which may drop them, so a withheld file keeps its pointer.
  const kept = [...preservedLines(notes), ...withheldLines(plan.dropped)]
  const storedInstructions = instructionValues(notes)
  const instructions = storedInstructions.filter(i => !i.startsWith(WITHDRAWN_PREFIX))
  let ops: Payload[] = []
  let withdrawn: string[] = []
  let fallback = false
  if (plan.dropped.length > 0) {
    const legacy = legacyItems(prev)
    const r = await $.model.complete({
      model: 'haiku',
      system: MERGE_SYSTEM,
      prompt: [
        `<notes>\n${mergeableNotes(notes)}\n</notes>`,
        `<instructions>\n${instructions.map(i => JSON.stringify(i)).join('\n') || '(none)'}\n</instructions>`,
        `<issues>\n${issueList(view.issues)}\n</issues>`,
        ...(view.finished.length ? [`<finished_earlier>\n${view.finished.map(i => `- ${i.title}`).join('\n')}\n</finished_earlier>`] : []),
        ...(legacy.length ? [`<legacy>\n${legacy.join('\n')}\n</legacy>`] : []),
        `<removed_turns>\n${renderTurns(plan.dropped)}\n</removed_turns>`,
      ].join('\n\n'),
      maxTokens: 4096,
      timeoutMs: 120_000,
    })
    const withdrawable = [...instructions, ...plan.dropped.filter(isPrompt).map(m => m.text)]
    const merged = r.isAnswered ? parseMerge(r.text, new Set(view.issues.map(i => i.id)), Math.max(500, Math.floor(opts.budget / 4)), withdrawable) : 'merge model gave no text (' + r.reason + ')'
    const bad = typeof merged === 'string' ? merged : undefined
    if (typeof merged !== 'string') {
      notes = merged.notes
      ops = merged.ops
      withdrawn = merged.withdrawn
      meta.fails = 0
      if (merged.rejected) await logEvent($, 'ops-rejected', { ratio, reason: `${merged.rejected} op(s) failed validation; ${ops.length} kept` })
    } else {
      meta.fails += 1
      await logEvent($, !r.isAnswered && r.reason === 'aborted' ? 'merge-timeout' : 'merge-invalid', { ratio, reason: `${bad} (failure ${meta.fails} in a row)` })
      if (!mustFold && meta.fails < FAILS_BEFORE_FALLBACK) return `merged ledger rejected: ${bad}`
      // A merge that never succeeds must not block folding forever.
      ;({ notes, ops } = fallbackLedger(notes, plan.dropped))
      fallback = true
      meta.fails = 0
      $.ui.log(`clm: merge failed (${bad}); folded with a mechanical ledger instead`, { to: 'debug' })
      await logEvent($, 'fallback', { ratio, reason: bad })
    }
  }
  // Backstop for the merge model: a step already recorded as done is never created twice.
  ops = ops.filter(o => !(o.op === 'create' && o.status === 'done' && view.doneTitles.has(o.title.trim())))
  const preserved = preserveInstructions(notes, storedInstructions, plan.dropped, await ledgerPath($), withdrawn)
  notes = rememberPreserved(rememberOversize(preserved.notes, oversizeLines(plan.tail, plan.cuts)), kept)
  const fullNotes = rememberPreserved(rememberOversize(preserved.fullNotes, oversizeLines(plan.tail, plan.cuts)), kept)

  const seq = meta.seq + 1
  const currentView = await trackerView($, here, ops)
  const text = ledgerRowText(seq, new Date().toISOString(), await ledgerPath($), composeLedger(notes, currentView.issues, currentView.stale))
  const tokensBefore = Math.max(estimated, observed ?? 0)
  const tokensAfter = sum(buildCleared(plan, { role: 'user', text, toolUses: [] }))
  if (tokensAfter >= tokensBefore) {
    const why = `the fold would not shrink the context (${tokensBefore} -> ${tokensAfter} est. tokens)`
    $.ui.log(`clm: ${why}`)
    await logEvent($, 'skip-not-shrinking', { tokensBefore, tokensAfter, keptTurns: plan.keptTurns, ratio, reason: why })
    return why
  }
  if (Object.keys(plan.cuts).length)
    await logEvent($, 'truncation', { keptTurns: plan.keptTurns, ratio, reason: `cut ${Object.keys(plan.cuts).length} tool result(s) to ~${Object.values(plan.cuts)[0]}t each` })
  if (calib !== undefined) meta.overhead = Math.max(0, calib - estimated)
  return { plan, notes, fullNotes, ops, seq, fallback }
}

async function maybeClear($: EngineInterface, opts: Opts) {
  const meta = await readMeta($)
  const rows = liveRows(await $.session.messages(), meta.boundary)
  const reading = await usageReading($)
  const observed = freshReal(reading, meta)
  const used = Math.max(sum(rows), observed ?? 0)
  // The tail target is the lower post-fold bound; wait until the context is
  // near the ceiling before folding again, so suffix-cache busts stay rare.
  const trigger = Math.max(opts.budget - opts.reserve, Math.floor(opts.budget * HYSTERESIS_FLOOR))
  if (used <= trigger) return
  const startedAt = await $.clock.now()
  const f = await fold($, opts, rows, meta, false, reading)
  const foldMs = Math.max(0, (await $.clock.now()) - startedAt)
  await writeMeta($, meta)
  if (typeof f === 'string') return skip($, f)
  const pending: Pending = {
    notes: f.notes, fullNotes: f.fullNotes, ops: f.ops, seq: f.seq, keepFp: f.plan.tail[0] && fingerprint(f.plan.tail[0]),
    keepFrom: rows.length - f.plan.tail.length, dropFps: f.plan.dropped.map(fingerprint),
    cuts: f.plan.cuts, keptTurns: f.plan.keptTurns, fallback: f.fallback, foldMs,
  }
  await $.store.set(await pendingKey($), pending)
  try {
    // Answered by this plugin's own session.compact hook below, which applies
    // the pending plan; the engine summarizer is never reached.
    await $.session.compact({})
  } catch (err) {
    $.ui.log(`clm: fold deferred to the next compaction (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}

async function showTurnChanges($: EngineInterface, e: { answer: string }) {
  if (!e.answer.trim()) return
  const session = await sid($)
  const meta = await readMeta($)
  const rows = liveRows(await $.session.messages(), meta.boundary)
  const hasToolUse = rows.slice(-8).some(m => m.toolUses.length > 0 || (m.toolResults?.length ?? 0) > 0)
  if (!hasToolUse && e.answer.trim().length < 200) return
  try {
    const ledger = mergeableNotes(notesOf((await readText($, await ledgerPath($))) ?? EMPTY_LEDGER))
    // clm-prompt
    const prompt = `<ledger_goal_and_key_facts>\n${ledger}\n</ledger_goal_and_key_facts>\n<finished_turn>\n${renderTurns(rows.slice(-8), 20000)}\n</finished_turn>`
    const r = await $.model.complete({ model: 'haiku', system: TURN_CHANGE_SYSTEM, prompt, maxTokens: 300, timeoutMs: 15000 })
    if (!r.isAnswered) return
    const seen = shownChanges.get(session) ?? new Set<string>()
    shownChanges.set(session, seen)
    for (const line of parseChanges(r.text)) {
      const key = changeHash(line)
      if (seen.has(key)) continue
      seen.add(key)
      $.ui.log('맥락 갱신: ' + line)
    }
  } catch (err) {
    $.ui.log(`clm: turn context refresh failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}

// --- per-tool-call steps ----------------------------------------------------

// Each main-loop tool call moves the tracker, and through append the notices
// and the task panel, while the turn runs; the fold no longer holds every step
// back until it lands. The tool.call hook only schedules this: the model call
// runs detached, one at a time per session, and calls arriving meanwhile
// collapse into one rerun over everything after the watermark.
// clm-prompt
export const STEP_SYSTEM = [
  'You keep the task tracker of a coding session up to date while it works.',
  'You receive the tracker\'s issues, the session rows added since your last update, and the tool call that just finished.',
  'Reply with `<ops>` holding a JSON array of tracker changes those rows show, and `</ops>`, nothing else. Each op is one of:',
  '  {"op":"create","title":"<one line>","status":"todo|doing|done|question","note":"<evidence: the command or check and what it printed>"}',
  '  {"op":"status","issue":"<id from the issues>","status":"todo|doing|done|question|dropped"}',
  '  {"op":"progress","issue":"<id from the issues>","done":<integer>,"total":<positive integer>}',
  '  {"op":"note","issue":"<id from the issues>","text":"<one line>"}',
  'Create an issue for each step the assistant announced (todo), started (doing) or finished with evidence (done), and each question waiting for the user (question).',
  'Move an existing issue with a status op once the rows show it changed; never re-create it.',
  'Write `<ops>[]</ops>` when no task changed.',
].join('\n')
const steppedKey = async ($: EngineInterface) => `stepped:${await sid($)}`
const stepRuns = new Map<string, { queued?: string }>()

const renderCall = ({ tool, agentId: _a, tool_use_id: _t, ...input }: { tool: string; agentId?: string; tool_use_id?: string }, r: { deny?: string; isError?: boolean; text?: string; result?: unknown }) => {
  const out = r.deny !== undefined ? `denied: ${r.deny}` : `${r.isError ? 'error ' : ''}${r.text ?? JSON.stringify(r.result ?? null)}`
  return `-> ${tool} ${JSON.stringify(input).slice(0, 600)}\n<- ${out.slice(0, 1500)}`
}

async function stepOnce($: EngineInterface, call: string): Promise<void> {
  const meta = await readMeta($)
  const rows = liveRows(await $.session.messages(), meta.boundary)
  const key = await steppedKey($)
  const mark = await $.store.get(key)
  const fresh = rows.slice(typeof mark === 'string' ? rows.map(fingerprint).lastIndexOf(mark) + 1 : 0)
  const here = await captureOrigin($)
  const view = await trackerView($, here)
  const r = await $.model.complete({
    model: 'haiku',
    system: STEP_SYSTEM,
    prompt: [`<issues>\n${issueList(view.issues)}\n</issues>`, `<new_rows>\n${renderTurns(fresh, 20000)}\n</new_rows>`, `<tool_call>\n${call}\n</tool_call>`].join('\n\n'),
    maxTokens: 1024,
    timeoutMs: 30_000,
  })
  const body = r.isAnswered ? /<ops>([\s\S]*?)<\/ops>/.exec(r.text)?.[1] : undefined
  const ops = body === undefined ? undefined : parseOps(normalizeLedger(body) || '[]', new Set(view.issues.map(i => i.id)))
  if (ops === undefined || typeof ops === 'string') {
    $.ui.log(`clm steps: no update (${r.isAnswered ? (ops ?? 'reply has no <ops>') : r.reason})`, { to: 'debug' })
    return
  }
  await append($, ops.ops, here, true, true)
  // Advanced only once the ops landed, so a fold covers whatever a failed step left out.
  const last = rows.at(-1)
  if (last) await $.store.set(key, fingerprint(last))
}

async function trackSteps($: EngineInterface, call: string): Promise<void> {
  const session = await sid($)
  const running = stepRuns.get(session)
  if (running) {
    running.queued = call
    return
  }
  const run: { queued?: string } = {}
  stepRuns.set(session, run)
  try {
    for (let next: string | undefined = call; next !== undefined; next = run.queued) {
      run.queued = undefined
      await stepOnce($, next)
    }
  } finally {
    stepRuns.delete(session)
  }
}

/** True when every row the fold drops lies at or before the per-tool-call watermark, so its steps were already emitted. */
async function steppedThrough($: EngineInterface, rows: readonly SessionMessage[], keepFrom: number): Promise<boolean> {
  const mark = await $.store.get(await steppedKey($))
  return typeof mark === 'string' && rows.map(fingerprint).lastIndexOf(mark) >= keepFrom - 1
}

const WITHHELD = '.withheld-'

// The files stay while a row or the ledger file points at them, so a resumed
// session can still read them; once neither does, nothing can reach them.
/** Removes this session's withheld-result files that neither a row in `live` nor `ledger` names. */
async function pruneWithheld($: EngineInterface, live: readonly SessionMessage[], ledger = ''): Promise<void> {
  try {
    const base = await basePath($)
    const dir = base.slice(0, base.lastIndexOf('/'))
    const prefix = base.slice(dir.length + 1) + WITHHELD
    if (!(await $.fs.exists(dir))) return
    const pointed = [ledger, ...live.flatMap(m => (m.toolResults ?? []).map(r => r.text))].join('\n')
    const stale = (await $.fs.list(dir))
      .filter(f => f.kind === 'file' && f.name.startsWith(prefix) && !pointed.includes(`${dir}/${f.name}`))
      .map(f => `${dir}/${f.name}`)
    if (stale.length === 0) return
    const r = await $.process.run(['rm', '-f', '--', ...stale], { timeoutMs: 5000 })
    if (r.exitCode !== 0) $.ui.log(`clm escape: could not remove ${stale.length} withheld file(s) (exit ${r.exitCode}: ${r.stderr.slice(0, 160)})`, { to: 'debug' })
  } catch (err) {
    $.ui.log(`clm escape: withheld-file cleanup failed (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}

// After a failed fold, the oldest tool results move to files, one at a time,
// until the rows fit the budget; each row keeps a pointer to its file. A
// changed row is rebuilt without its handle, which would map it back to the
// engine's original message.
async function withholdOldestResults($: EngineInterface, rows: readonly SessionMessage[], opts: Opts): Promise<readonly SessionMessage[] | undefined> {
  if (!rows.some(m => m.toolResults?.length)) return undefined
  await pruneWithheld($, rows, (await readText($, await ledgerPath($))) ?? '')
  const current = [...rows]
  const limit = opts.budget - opts.reserve
  const base = await basePath($)
  let n = 0
  for (const [rowIndex, row] of rows.entries()) {
    let updated = row
    for (const result of row.toolResults ?? []) {
      const index = n++
      if (result.text.startsWith('[clm escape:')) continue
      const path = `${base}${WITHHELD}${index}-${result.tool_use_id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.txt`
      try {
        await $.fs.write(path, result.text)
      } catch (err) {
        $.ui.log('clm escape: could not preserve tool result at ' + path + ' (' + String(err).slice(0, 160) + ')', { to: 'debug' })
        continue
      }
      updated = {
        role: updated.role, text: updated.text, toolUses: updated.toolUses,
        toolResults: (updated.toolResults ?? []).map(r => (r.tool_use_id === result.tool_use_id ? { ...r, text: withheldPointer(path) } : r)),
      }
      current[rowIndex] = updated
      if (sum(current) <= limit) return current
    }
  }
  return current
}

export function report(ledger: string | undefined, rows: readonly SessionMessage[], opts: Opts, meta: Meta, logTail: readonly string[]): string {
  const used = Math.round(visibleTokens(rows) * (meta.ratio ?? 1))
  return [
    `clm budget: ${used}/${opts.budget} tokens (${Math.round((used / opts.budget) * 100)}%); folds above ${opts.budget - opts.reserve}, tail target ${opts.tailTarget}, ratio ${meta.ratio ?? 1}`,
    `rows: ${rows.filter(m => !isSystemRow(m)).length} kept, ${rows.filter(isSystemRow).length} hidden system rows`,
    `last fold: ${meta.lastClear ?? 'never'} (ledger #${meta.seq})${meta.lastSkip ? `; last skip: ${meta.lastSkip}` : ''}`,
    '',
    ledger ?? '(no ledger yet)',
    '',
    'recent decisions:',
    ...(logTail.length ? logTail : ['(none)']),
  ].join('\n')
}

const GUIDE = [
  'Memory ledger (clm): when this conversation outgrows its budget, the harness folds the older turns into one row that starts with "[clm ledger".',
  'That row records the goal, the user\'s instructions verbatim, what was done with its evidence, what is left, open questions and key facts; the turns it replaced are gone.',
  'Rely on it as your own memory of that work.',
  'Describe task changes in the conversation; clm records them in the tracker and task panel.',
].join('\n')

export const register: Register = (on, options) => {
  const { opts, problems } = readOpts(options as Record<string, unknown>)

  on('engine.create', async ($, e, next) => {
    const built = await next(e)
    return {
      ...built,
      clm: {
        track: () => { throw new Error('clm.track is handled by the clm plugin') },
        issues: () => { throw new Error('clm.issues is handled by the clm plugin') },
      },
    }
  })

  on('clm.track', async ($, e) => ({ value: await trackIssue($, e) }))
  on('clm.issues', async ($, e) => ({ value: await sessionIssues($, e ?? {}) }))

  on('session.start', async ($, e, next) => {
    for (const p of problems) $.ui.log(`clm: option ${p}`)
    await $.command.register({
      name: 'clm',
      description: 'Show the clm ledger, budget use and recent decisions; `board` opens the issue board in the browser, `link <id>` brings another repo\'s issue into this session (shown to you only).',
      immediate: true,
    })
    return next(e)
  })

  // Printed through ui.log, which the engine draws as a notice and never sends
  // to the model; a command's `text` is a transcript row and may be.
  on('command.run', { command: 'clm' }, async ($, e) => {
    // `$.command.run` documents a left-out args as "", yet the test kit hands it over undefined.
    const [sub, arg] = (e.args ?? '').trim().split(/\s+/)
    if (sub === 'board') {
      await openBoard($)
      return {}
    }
    if (sub === 'link') {
      const issue = arg ? snapshot(await readAll($)).find(i => i.id === arg) : undefined
      if (!issue) {
        $.ui.log(arg ? `clm: no issue ${arg}; /clm board lists them` : 'clm: usage /clm link <issue id>')
        return {}
      }
      await append($, [{ op: 'link', issue: issue.id }])
      $.ui.log(`clm: ${issue.id} "${issue.title}" (${issue.origin.repo}) is linked to this session and shows in its ledger from the next fold`)
      return {}
    }
    if (sub) {
      $.ui.log('clm: usage /clm, /clm board, /clm link <issue id>')
      return {}
    }
    const meta = await readMeta($)
    const rows = liveRows(await $.session.messages(), meta.boundary)
    const log = ((await readText($, await logPath($))) ?? '').split('\n').filter(Boolean).slice(-5)
    $.ui.log(report(await readText($, await ledgerPath($)), rows, opts, meta, log))
    return {}
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined) return res
    try {
      void showTurnChanges($, e).catch(err => $.ui.log(`clm: turn context refresh failed (${String(err).slice(0, 160)})`, { to: 'debug' }))
      await maybeClear($, opts)
    } catch (err) {
      $.ui.log(`clm: fold failed, ${String(err).slice(0, 200)}`, { to: 'debug' })
    }
    return res
  })

  // The main conversation's every compaction ends here and never reaches
  // next(e), the engine summarizer: a pending plan is applied, otherwise the
  // fold is planned and merged on the spot. Subagents keep the engine's.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.trigger === 'precompute') return { skip: 'clm replaces compaction' }
    // Without a transcript there is nothing to rewrite; a pending plan waits.
    if (!Array.isArray(e.messages)) return { skip: 'clm: the compaction carried no transcript' }
    const compactStartedAt = await $.clock.now()
    const all = e.messages
    const meta = await readMeta($)
    let workingRows = liveRows(all, meta.boundary)
    let first = protectedIndex(workingRows)
    const key = await pendingKey($)
    const stored = await $.store.get(key)
    const pending = isPending(stored) ? stored : undefined
    if (stored !== undefined) await $.store.delete(key)

    let use: (Omit<Pending, 'keepFp' | 'keepFrom' | 'dropFps'> & { keepFrom: number }) | undefined
    if (pending) {
      const keepFrom = pending.keepFrom
      const row = keepFrom < workingRows.length ? workingRows[keepFrom] : undefined
      const expectedDropped = workingRows.slice(first + 1, keepFrom).filter(m => !isLedgerRow(m) && !isSystemRow(m)).map(fingerprint)
      const sameDropped = expectedDropped.length === pending.dropFps.length
        && expectedDropped.every((fp, i) => fp === pending.dropFps[i])
      const sameKept = pending.keepFp === undefined
        ? keepFrom === workingRows.length
        : row !== undefined && fingerprint(row) === pending.keepFp
      if (keepFrom >= first + 1 && keepFrom <= workingRows.length && sameKept && sameDropped) use = { ...pending, keepFrom }
    }
    let escaped = false
    if (!use) {
      let f: Fold | string
      try {
        f = await fold($, opts, workingRows, meta, true)
      } catch (err) {
        f = 'fold failed: ' + String(err).slice(0, 160)
      }
      if (typeof f === 'string' && (e.trigger === 'auto' || e.trigger === 'manual')) {
        const prefix = all.slice(0, all.length - workingRows.length)
        const escapedRows = await withholdOldestResults($, workingRows, opts)
        if (escapedRows) {
          escaped = true
          workingRows = escapedRows
          first = protectedIndex(workingRows)
          try {
            f = await fold($, opts, workingRows, meta, true, undefined, false)
          } catch (err) {
            f = 'escape retry failed: ' + String(err).slice(0, 160)
          }
        }
        if (typeof f === 'string') {
          await logEvent($, 'escape', { reason: e.trigger + ': ' + f })
          // The engine summarizes the withheld rows, so the escape still shrinks what it reads.
          return next(escapedRows ? { ...e, messages: [...prefix, ...escapedRows] } : e)
        }
      }
      await writeMeta($, meta)
      if (typeof f === 'string') {
        $.ui.log(`clm: ${e.trigger} compaction left the conversation as it is: ${f}`)
        return { messages: all }
      }
      use = { notes: f.notes, fullNotes: f.fullNotes, ops: f.ops, seq: f.seq, cuts: f.plan.cuts, keptTurns: f.plan.keptTurns, fallback: f.fallback, keepFrom: workingRows.length - f.plan.tail.length, foldMs: 0 }
    }

    const here = await captureOrigin($)
    const covered = await steppedThrough($, workingRows, use.keepFrom)
    const appended = await append($, covered ? [] : use.ops, here, false, true)
    const currentView = await trackerView($, here)
    const ledger = composeLedger(use.notes, currentView.issues, currentView.stale)
    const fileLedger = composeLedger(use.fullNotes, currentView.issues, currentView.stale)
    const text = ledgerRowText(use.seq, new Date().toISOString(), await ledgerPath($), ledger)
    const ledgerRow: SessionMessage = { role: 'user', text, toolUses: [] }
    const messages = buildCleared({ head: workingRows.slice(0, first + 1), tail: workingRows.slice(use.keepFrom), cuts: use.cuts }, ledgerRow)
    const tokensBefore = sum(workingRows)
    const tokensAfter = sum(messages)
    await $.fs.write(await ledgerPath($), fileLedger + '\n')
    // On the escape path the pre-fold rows still name every withheld file;
    // otherwise a file named by neither a kept row nor the ledger is unreachable.
    await pruneWithheld($, escaped ? workingRows : messages, fileLedger)
    const offset = messages.findIndex(m => m.text === text)
    const foldedAt = await $.clock.now()
    await writeMeta($, {
      ...meta, seq: use.seq, lastClear: new Date().toISOString(), lastFoldAt: foldedAt,
      foldDurationsMs: { ...meta.foldDurationsMs, [String(use.seq)]: (use.foldMs ?? 0) + Math.max(0, foldedAt - compactStartedAt) },
      foldTokens: await usageReading($), lastSkip: undefined, boundary: { fp: fingerprint(ledgerRow), offset },
    })
    await logEvent($, 'clear', { tokensBefore, tokensAfter, keptTurns: use.keptTurns, ratio: meta.ratio ?? 1, reason: `${e.trigger}${use.fallback ? ', fallback ledger' : ''}` })
    await projectPanel($, here, appended)
    return { messages, tokensBefore, tokensAfter }
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && next.origin.plugin !== 'clm' && e.tool !== 'TaskCreate' && e.tool !== 'TaskUpdate') {
      const call = renderCall(e, r)
      void trackSteps($, call).catch(err => $.ui.log(`clm steps: ${String(err).slice(0, 160)}`, { to: 'debug' }))
    }
    return r
  })
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => (e.agentId !== undefined || next.origin.plugin === 'clm' ? next(e) : denyModelTask($, e)))
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => (e.agentId !== undefined || next.origin.plugin === 'clm' ? next(e) : denyModelTask($, e)))
  on('tool.describe', { tool: 'TaskCreate' }, ($, e) => ({ ...e, isDeferred: true }))
  on('tool.describe', { tool: 'TaskUpdate' }, ($, e) => ({ ...e, isDeferred: true }))
  on('prompt.attachment', { type: 'todo_reminder' }, () => ({ text: null }))

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const seq = ledgerRowSeq(e.props.text)
    if (e.props.isExpanded || e.props.from !== undefined || e.props.task !== undefined || seq === undefined) return next(e)
    const durationMs = (await readMeta($)).foldDurationsMs?.[seq]
    const text = durationMs === undefined ? '* clm compacted' : `* clm compacted in ${(durationMs / 1000).toFixed(1)} s`
    const { Text } = $.ui.resolve(e)
    return Text({ children: [text] })
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.includes('bare')) return r
    return { ...r, sections: [...r.sections, { id: 'clm:guide', text: GUIDE, scope: 'session' as const }] }
  })
}
