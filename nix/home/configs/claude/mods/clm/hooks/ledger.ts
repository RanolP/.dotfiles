import type { SessionMessage } from 'claude-code'

import type { SentAt } from './address'
import { readEvidence, sentStamp, type Evidence } from './evidence'
import { estTokens, isUserTyped, stripReminders } from './fold'
import { isTrackerSection, parseOps, sectionLines, shownNote, type Issue, type Payload } from './tracker'

export const SECTIONS = ['목표', '사용자 지시', '한 일', '할 일', '미결 질문', '핵심 사실·경로'] as const
export const EMPTY_LEDGER = SECTIONS.map(s => `## ${s}\n- (none yet)`).join('\n\n')
const OVERSIZE_MARK = '출력 과다:'
const OVERSIZE_KEEP = 5
const FOLDED_MARK = '요약 없이 접힘:'
const FOLDED_KEEP = 3

// --- ledger text ---------------------------------------------------------

const sectionsOf = (ledger: string) => ledger.split(/^(?=## )/m)
const isSection = (part: string, name: string) => part.trimEnd() === `## ${name}` || part.startsWith(`## ${name}\n`)

/** Keeps the newest `keep` distinct `mark` lines (those already there, then `lines`) at the end of 핵심 사실·경로. */
function rememberLines(ledger: string, mark: string, keep: number, lines: readonly string[]): string {
  if (lines.length === 0) return ledger
  return sectionsOf(ledger)
    .map(p => {
      if (!isSection(p, '핵심 사실·경로')) return p
      const body = p.trimEnd().split('\n')
      const marked = [...new Set([...body.filter(l => l.includes(mark)), ...lines])].slice(-keep)
      return `${[...body.filter(l => !l.includes(mark) && l.trim() !== '- (none yet)'), ...marked].join('\n')}\n\n`
    })
    .join('')
    .trimEnd()
}
/** Records commands whose output had to be cut, newest five only. */
export const rememberOversize = (ledger: string, lines: readonly string[]) => rememberLines(ledger, OVERSIZE_MARK, OVERSIZE_KEEP, lines)

// A tool result withheld on the escape path lives in a file; the row keeps
// this pointer, and once the row is folded away the ledger keeps the path.
const PRESERVED_MARK = '보존된 출력:'
const PRESERVED_KEEP = 10
export const withheldPointer = (path: string) => `[clm escape: full tool result at ${path}]`
const WITHHELD_POINTER = /^\[clm escape: full tool result at (.+)\]$/
/** One `보존된 출력` line per withheld result among `dropped`. */
export const withheldLines = (dropped: readonly SessionMessage[]) =>
  dropped.flatMap(m => (m.toolResults ?? []).flatMap(r => {
    const path = WITHHELD_POINTER.exec(r.text)?.[1]
    return path === undefined ? [] : [`- ${PRESERVED_MARK} ${path}`]
  }))
/** The `보존된 출력` lines a ledger already holds. */
export const preservedLines = (ledger: string) => ledger.split('\n').filter(l => l.includes(PRESERVED_MARK))
/** Records the files of withheld results whose rows were folded away, newest ten only. */
export const rememberPreserved = (ledger: string, lines: readonly string[]) => rememberLines(ledger, PRESERVED_MARK, PRESERVED_KEEP, lines)

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ')
export const oversizeLines = (tail: readonly SessionMessage[], cuts: Record<string, number>) =>
  tail.flatMap(m => m.toolUses).filter(u => cuts[u.tool_use_id] !== undefined)
    .map(u => `- ${OVERSIZE_MARK} ${clip(oneLine(`${u.tool} ${JSON.stringify(u.input ?? {})}`), 70)}`)

// The merged half of the ledger: the sections the merge model rewrites, 목표
// alone. Legacy 사용자 지시 are carried only until clause migration; 핵심 사실·경로 by
// rememberFacts, so each of their lines traces to a quote; the other three
// sections come from the tracker.
const INSTRUCTIONS = '사용자 지시'
const FACTS = '핵심 사실·경로'
export const NOTE_SECTIONS = SECTIONS.filter(s => !isTrackerSection(s) && s !== INSTRUCTIONS && s !== FACTS)
const STORED_SECTIONS = SECTIONS.filter(s => !isTrackerSection(s))
const EMPTY_NOTES = STORED_SECTIONS.map(s => `## ${s}\n- (none yet)`).join('\n\n')
export const notesOf = (ledger: string) =>
  sectionsOf(ledger).filter(p => STORED_SECTIONS.some(s => isSection(p, s))).join('').trimEnd() || EMPTY_NOTES
/** The stored notes with the merge model's sections taken from `merged`. */
export const withNotes = (stored: string, merged: string) =>
  STORED_SECTIONS.map(s => (sectionsOf(NOTE_SECTIONS.includes(s) ? merged : stored).find(p => isSection(p, s))?.trimEnd() ?? `## ${s}\n- (none yet)`)).join('\n\n')
/** The notes the merge model rewrites. */
export const mergeableNotes = (notes: string) =>
  sectionsOf(notes).filter(p => NOTE_SECTIONS.some(s => isSection(p, s))).join('').trimEnd()
// A ledger written before the tracker existed holds merged items in the
// tracker sections; they carry no `[id]`, and the merge model turns them into
// create ops once so they are not lost on the first fold after the upgrade.
export const legacyItems = (ledger: string) =>
  sectionsOf(ledger).filter(p => [...SECTIONS].some(s => isTrackerSection(s) && isSection(p, s)))
    .flatMap(p => p.split('\n').slice(1)).filter(l => /^\s*- /.test(l) && l.trim() !== '- (none yet)' && !/\[[^\]\s]+-\d+\]\s*$/.test(l))

export function composeLedger(notes: string, issues: readonly Issue[]): string {
  const parts = sectionsOf(notes)
  return SECTIONS.map(s =>
    isTrackerSection(s) ? `## ${s}\n${sectionLines(issues, s).join('\n')}` : (parts.find(p => isSection(p, s))?.trimEnd() ?? `## ${s}\n- (none yet)`),
  ).join('\n\n')
}

// A ledger written before instructions were stored as JSON strings holds
// free-form lines (`"..." (UI 검증)`, `PR 병합에 대해: "..."`); each is kept
// verbatim, and only a fully quoted line is unquoted.
export const WITHDRAWN_PREFIX = '(withdrawn) '
const storedInstructionValue = (raw: string): string => {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'string') return value
  } catch {
    // Quoted but not valid JSON: strip the outer quotes only.
  }
  return raw.slice(1, -1)
}
const instructionValue = (line: string): string | undefined => {
  const raw = line.trim().replace(/^-\s*/, '')
  if (!raw || raw === '(none yet)' || raw.startsWith('[additional user instructions in ')) return undefined
  if (!raw.startsWith(WITHDRAWN_PREFIX)) return storedInstructionValue(raw)
  return `${WITHDRAWN_PREFIX}${JSON.stringify(storedInstructionValue(raw.slice(WITHDRAWN_PREFIX.length)))}`
}
/** The one key two spellings of an instruction share: whitespace runs, line breaks included, collapse to one space. */
export const instructionKey = (text: string) => text.replace(/\s+/g, ' ').trim()
const sectionOf = (notes: string, name: string) => sectionsOf(notes).find(p => isSection(p, name))
export const sectionBody = (notes: string, name: string): string => sectionOf(notes, name)?.split('\n').slice(1).join('\n').trim() ?? ''
export const instructionValues = (notes: string): string[] =>
  (sectionOf(notes, INSTRUCTIONS) ?? '').split('\n').slice(1).map(instructionValue).filter((v): v is string => v !== undefined)
export const withdrawnInstructionKeys = (notes: string): Set<string> => new Set(instructionValues(notes).flatMap(value => {
  if (!value.startsWith(WITHDRAWN_PREFIX)) return []
  const raw = value.slice(WITHDRAWN_PREFIX.length)
  return [instructionKey(value), instructionKey(storedInstructionValue(raw))]
}))

/** Rebuilds the stored note sections in ledger order, taking `name`'s body from `body`. */
function withSection(notes: string, name: string, body: string): string {
  return STORED_SECTIONS.map(s => (s === name ? `## ${s}\n${body}` : (sectionOf(notes, s)?.trimEnd() ?? `## ${s}\n- (none yet)`))).join('\n\n')
}

// --- key facts -------------------------------------------------------------

export const FACT_KEEP = 25
export type Fact = { text: string; evidence: Evidence[]; kind?: 'constraint' | 'learned' }
const CONSTRAINT_FACT = '[constraint] '
const isMarked = (line: string) => line.includes(OVERSIZE_MARK) || line.includes(PRESERVED_MARK) || line.includes(FOLDED_MARK)
const factBody = (line: string) => line.trim().replace(/^-\s*/, '')
/** The fact lines a ledger holds, the harness's oversize and preserved-output lines aside. */
export const factLines = (notes: string) =>
  (sectionOf(notes, FACTS) ?? '').split('\n').slice(1).filter(l => /^\s*- /.test(l) && l.trim() !== '- (none yet)' && !isMarked(l)).map(factBody)
export const constraintFactLines = (notes: string) => factLines(notes).filter(line => line.startsWith(CONSTRAINT_FACT))
export const learnedFactLines = (notes: string) => factLines(notes).filter(line => !line.startsWith(CONSTRAINT_FACT))
/** One fact line: the claim, then the quote that carries it. */
export const factLine = (f: Fact) => `${f.kind === 'constraint' ? CONSTRAINT_FACT : ''}${f.text} — quote: ${JSON.stringify(clip(f.evidence[0]?.quote.replace(/\s+/g, ' ').trim() ?? '', 120))}`
/**
 * Owns 핵심 사실·경로: the facts already there minus `retracted` (matched by
 * instructionKey), then `added`, newest FACT_KEEP; the harness's marked lines
 * stay after them for rememberOversize and rememberPreserved.
 */
export function rememberFacts(notes: string, added: readonly Fact[], retracted: readonly string[] = []): string {
  const gone = new Set(retracted.map(r => instructionKey(factBody(r))))
  const marked = (sectionOf(notes, FACTS) ?? '').split('\n').slice(1).filter(isMarked)
  const prior = factLines(notes).filter(line => !gone.has(instructionKey(line)))
  const constraints = [...prior.filter(line => line.startsWith(CONSTRAINT_FACT)), ...added.filter(fact => fact.kind === 'constraint').map(factLine)]
  const learned = [...prior.filter(line => !line.startsWith(CONSTRAINT_FACT)), ...added.filter(fact => fact.kind !== 'constraint').map(factLine)].slice(-FACT_KEEP)
  const facts = [...new Set([...constraints, ...learned])]
  const lines = [...facts.map(f => `- ${f}`), ...marked]
  return withSection(notes, FACTS, lines.length ? lines.join('\n') : '- (none yet)')
}

// A prompt that carries no instruction: the harness's echo of a `!` shell
// command or a slash command, and a bare go-ahead. It stays in the transcript
// and stays citable; it just has nothing to keep under 사용자 지시. Length is no
// test: 하지마, 멈춰 and push are whole instructions.
const WRAPPER_ROW = /^\s*<(?:bash-(?:input|stdout|stderr)|local-command-[\w-]+|command-[\w-]+)>/
const ACKS = new Set(['ㄱ', 'ㄱㄱ', 'ㄱㄱㄱ', 'ㅇㅇ', 'ㅇㅋ', '응', '네', '넵', 'ok', 'go', 'yes', 'y', '지금?', '현황?', '빨리 하쇼'])
export const isDirective = (text: string) => {
  const t = text.trim()
  return t !== '' && !ACKS.has(t.toLowerCase()) && !WRAPPER_ROW.test(t)
}

export type PreservedInstructions = { notes: string; fullNotes: string }
/**
 * Owns 사용자 지시: the earlier instructions (`prior`, from the ledger file),
 * plus every prompt in `dropped`, each once by instructionKey. Visible notes
 * omit `withdrawn` instructions; `fullNotes` keeps them marked for the ledger file.
 */
export function carryLegacyInstructions(
  notes: string, prior: readonly string[], dropped: readonly SessionMessage[], _pointer: string,
  withdrawn: readonly string[] = [],
): PreservedInstructions {
  const gone = new Set(withdrawn.map(instructionKey))
  const seen = new Map<string, { text: string; withdrawn: boolean }>()
  for (const raw of [...prior, ...dropped.filter(isUserTyped).map(m => stripReminders(m.text))]) {
    const alreadyWithdrawn = raw.startsWith(WITHDRAWN_PREFIX)
    const text = alreadyWithdrawn ? storedInstructionValue(raw.slice(WITHDRAWN_PREFIX.length)) : raw
    const key = instructionKey(text)
    // Applied to the stored lines too, so noise an older fold kept leaves.
    if (!key || !isDirective(text)) continue
    const previous = seen.get(key)
    if (previous) {
      seen.delete(key)
      seen.set(key, { text, withdrawn: alreadyWithdrawn || gone.has(key) })
      continue
    }
    seen.set(key, { text, withdrawn: alreadyWithdrawn || gone.has(key) })
  }
  const records = [...seen.values()]
  const visible = records.filter(v => !v.withdrawn).map(v => v.text)
  const full = records.map(v => v.withdrawn ? `- ${WITHDRAWN_PREFIX}${JSON.stringify(v.text)}` : `- ${JSON.stringify(v.text)}`)
  const body = (lines: readonly string[]) => (lines.length ? lines.join('\n') : '- (none yet)')
  const stored = withSection(notes, INSTRUCTIONS, body(full))
  return { notes: withSection(notes, INSTRUCTIONS, body(visible.map(v => `- ${JSON.stringify(v)}`))), fullNotes: stored }
}

export type AgeDecayTopic = { sourceTokens: number; currentTokens: number; floorTokens: number; seq: number }

/** Allocates a fixed ledger budget by topic age while leaving unsqueezed entries untouched. */
export function ageDecayTargets(topics: readonly AgeDecayTopic[], budget: number): number[] {
  if (!topics.length) return []
  const current = topics.map(topic => Math.max(0, topic.currentTokens))
  if (current.reduce((sum, value) => sum + value, 0) <= budget) return current
  const floors = topics.map((topic, index) => Math.max(0, Math.min(current[index] ?? 0, topic.floorTokens)))
  const newestSeq = Math.max(...topics.map(topic => topic.seq))
  const newest = topics.flatMap((topic, index) => topic.seq === newestSeq ? [index] : [])
  const oldFloors = floors.reduce((sum, value, index) => sum + (newest.includes(index) ? 0 : value), 0)
  const newestCurrent = newest.reduce((sum, index) => sum + (current[index] ?? 0), 0)
  if (oldFloors + newestCurrent > budget) {
    const room = Math.max(0, budget - oldFloors)
    const total = newest.reduce((sum, index) => sum + (topics[index]?.sourceTokens ?? 0), 0)
    return floors.map((floor, index) => {
      const topic = topics[index]
      if (!newest.includes(index) || !topic) return floor
      return total > 0 ? Math.floor(room * topic.sourceTokens / total) : 0
    })
  }
  const valueAt = (topic: AgeDecayTopic, index: number, d: number) => {
    const age = topics.filter(other => other.seq > topic.seq).length
    return Math.max(floors[index] ?? 0, Math.min(current[index] ?? 0, topic.sourceTokens * (1 + age) ** -d))
  }
  const totalAt = (d: number) => {
    let total = 0
    topics.forEach((topic, index) => { total += valueAt(topic, index, d) })
    return total
  }
  let low = 0
  let high = 1
  while (totalAt(high) > budget && high < 1024) high *= 2
  if (totalAt(high) > budget) return floors
  for (let i = 0; i < 64; i++) {
    const mid = (low + high) / 2
    if (totalAt(mid) > budget) low = mid
    else high = mid
  }
  return topics.map((topic, index) => Math.floor(valueAt(topic, index, high)))
}

export function ageDecayPlan(topics: readonly AgeDecayTopic[], budget: number): { targets: number[]; rewrite: number[] } {
  const targets = ageDecayTargets(topics, budget)
  return { targets, rewrite: targets.flatMap((target, index) => target < (topics[index]?.currentTokens ?? Infinity) ? [index] : []) }
}

// Deterministic stand-in when the merge model keeps failing: the notes stay as
// they were (carryLegacyInstructions adds the dropped prompts) plus one marked line
// saying turns were folded unsummarized. No reviewer saw those turns, so they
// add no tracker item: an open item would read as work still pending.
export function fallbackLedger(prevNotes: string, dropped: readonly SessionMessage[]): string {
  const turns = dropped.filter(isUserTyped).length
  const tools = [...new Set(dropped.flatMap(m => m.toolUses.map(u => u.tool)))]
  return rememberLines(prevNotes, FOLDED_MARK, FOLDED_KEEP, [`- ${FOLDED_MARK} ${turns} prompt(s), tools ${tools.length ? tools.join(', ') : 'none'}; the prompts are under 사용자 지시`])
}

const EVIDENCE_FIELD = '"evidence":[{"ref":"<ref>","quote":"<text copied exactly from that row>"}]'
// clm-prompt
export const MERGE_SYSTEM = [
  'You convert the oldest turns of a coding session into tracker changes and typed clauses before those turns are deleted.',
  'You receive registered predicates, live clauses, open tracker issues and the turns being removed.',
  'In <removed_turns> a user message is headed `[user mN]` and a tool result `<- [id]`; mN and id are refs you cite. Write a ref as that bare key and nothing else: `m4` for the row headed `[user m4 2026-10-15 14:03 KST]`, `toolu_01AbC` for the row headed `<- [toolu_01AbC]`. Assistant rows carry no ref: they show what the assistant said or proposed, and the tool results and the user\'s words show what actually happened.',
  'A row whose send time is known carries it in its header after the role and ref, as `YYYY-MM-DD HH:MM KST`.',
  'When a message you cite or summarize uses a relative time expression (내일, 어제 밤, 2시간 뒤), write the absolute KST date right after the original words as `<original>(=YYYY-MM-DD)`, computed from that message\'s own header time; for a sub-day expression write `<original>(=YYYY-MM-DD HH:MM)`. Keep the expression as written when its message carries no time.',
  'Return one JSON object with an ops array. Each op is one of:',
  `  {"op":"create","title":"<one line>","status":"todo|doing|done|question","note":"<one line>",${EVIDENCE_FIELD}}`,
  `  {"op":"status","issue":"<id from the issues>","status":"todo|doing|done|question|dropped",${EVIDENCE_FIELD}}`,
  '  {"op":"retitle","issue":"<id from the issues>","title":"<new one line title>"}',
  '  {"op":"progress","issue":"<id from the issues>","done":<integer>,"total":<positive integer>}',
  '  {"op":"note","issue":"<id from the issues>","text":"<one line>"}',
  `  {"clause":"<restricted Prolog>","kind":"fact","text":"<one Korean sentence>",${EVIDENCE_FIELD}}`,
  '  {"clause":"goal(\'issue-id\', slug).","kind":"goal","text":"<one Korean sentence>","issue":"<issue id>"}',
  '  {"retract":"<C-id from live_clauses>"} when a newer fact or goal makes it stale.',
  'Every done (a create with status done, or a status op to done) and every fact carries evidence: the ref of one user message or tool result, and a quote copied character for character from that row.',
  'A done needs a row showing the state-changing action ran and its outcome: a tool result (the merge output, the passing test count, the written file) or the user saying it happened. A step the assistant proposed, recommended or asked about, and a read-only check of the current state, is todo or question.',
  'A fact stands when the cited row states it. Mark a stable constraint or preference discovered in tool output as kind constraint; mark a lesson from a failure or user correction as kind learned.',
  'A constraint carries a quote from a tool result. A learned item carries the failed result or the user correction verbatim as its quote.',
  'Every id, number and date in one claim comes from the same row and names the same object as that row; a `(=...)` date beside a relative expression comes from that row\'s header time plus the expression.',
  'A clause with kind instruction is outside your authority. Use only fact and goal.',
  'Create an issue for each step finished (done, with evidence), each step still ahead (todo), and each question still waiting for an answer (question, the note naming who must answer).',
  'For each existing issue changed by the turns, write an update using its existing id so its history stays attached. Omit an op for each unchanged issue. Items listed under <legacy> have no issue yet: create one for each that still holds.',
  'When the user abandons or suspends a direction, or redirects the session to another goal, move every open issue that served only that direction to dropped, citing as evidence the user message that redirects.',
  'When the user resumes a dropped direction, move that dropped issue back to todo or doing by its id; it keeps its id and history that way.',
  'Keep the recorded state of each step listed under <finished_earlier>.',
  'An open option becomes a tracker create op with status question, not a fact.',
  'Write {"ops":[]} when nothing changed. Write titles, notes and clause text in Korean, keeping code identifiers, paths and commands verbatim.',
  'Reply with the JSON object and nothing else.',
].join('\n')

// clm-prompt
export const SPLIT_MERGE_SYSTEM = [
  MERGE_SYSTEM,
  'You also receive numbered complete turns with estimated token counts. Return one JSON object with split and ops fields.',
  'Inside <queue_turns>, cite a user row by its bare mN key (`m4`) and a tool result by its bare id (`toolu_01AbC`) in the ops evidence, the same ref format as in <removed_turns>.',
  'Set split to the 1-based first turn of B. Turns before split form A, and A contains at least one whole turn about a finished topic. Choose a boundary where the turns from split onward form the topic still in progress.',
  'Summarize only A into ops. The caller keeps B from its numbered turn boundary verbatim.',
  'Reply with only JSON: {"split":2,"ops":[]}.',
].join('\n')

// clm-prompt
export const LESSON_SYSTEM = [
  'You extract durable lessons from coding-session turns that are about to be deleted, so a future session can reuse them.',
  'You receive <known_lessons>, lessons already recorded, and <dropped_turns>, the deleted turns rendered as `[user]`, `[assistant]`, `  -> tool input` and `  <- tool result` lines.',
  'Record a lesson of one of three kinds:',
  '- correction: the user corrected the assistant\'s behavior or assumption; state the behavior the user asked for.',
  '- failed-approach: an approach failed and a later step fixed it; state what failed and what worked.',
  '- fact: a verified, non-obvious fact about a tool, repository, or environment, confirmed by a tool result.',
  'Write each lesson as one self-contained English sentence that reads correctly without the turns.',
  'Set evidence to a verbatim substring copied character for character from one line of <dropped_turns>: the user\'s sentence for a correction, the tool result or user sentence that proves a failed-approach or fact. Copy the text after the line\'s header, and keep it short enough to stay inside that one line.',
  'Record only lessons that are new relative to <known_lessons>. Most turns teach nothing durable; reply with an empty lessons array for them.',
  'Reply with only JSON: {"lessons":[{"kind":"correction","lesson":"...","evidence":"..."}]}.',
].join('\n')

export function renderTurns(rows: readonly SessionMessage[], cap = 120_000, sentAt?: SentAt): string {
  const out = rows.map(m => {
    const head = `[${m.role}${sentStamp(m, sentAt)}]`
    const parts = [m.text ? `${head} ${clip(m.text, 4000)}` : head]
    for (const u of m.toolUses) parts.push(`  -> ${u.tool} ${clip(JSON.stringify(u.input ?? {}), 600)}`)
    for (const r of m.toolResults ?? []) parts.push(`  <- ${r.isError ? 'error ' : ''}${clip(r.text, 1500)}`)
    return parts.join('\n')
  }).join('\n')
  return out.length > cap ? `…[older part cut]\n${out.slice(out.length - cap)}` : out
}

export const normalizeLedger = (text: string) => text.trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/, '$1').trim()
/** The turn-time `맥락 갱신` lines: at most three, one line each. */
export function parseChanges(reply: string): string[] {
  const body = /<changes>([\s\S]*?)(?:<\/changes>|$)/.exec(reply)?.[1] ?? ''
  return body.split('\n').map(line => line.trim()).filter(line => line && !/[<>]/.test(line)).slice(0, 3).map(line => clip(line, 80))
}
const isOp = (o: unknown, op: string): o is Record<string, unknown> => typeof o === 'object' && o !== null && 'op' in o && o.op === op
export type FoldClauseDraft = { clause: string; kind: 'fact' | 'goal'; text: string; evidence: Evidence[]; issue?: string; key?: number }
const isFoldClauseDraft = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
  && 'clause' in value && typeof value.clause === 'string' && 'text' in value && typeof value.text === 'string'
  && 'kind' in value && (value.kind === 'fact' || value.kind === 'goal')
export type Merge = { notes?: string; ops: Payload[]; evidence: Evidence[][]; facts: Fact[]; clauseOps: (FoldClauseDraft | { retract: string })[]; retracted: string[]; rejected: number }
/**
 * Splits a merge reply into notes, validated tracker ops (with the evidence
 * each cited), proposed facts and retracted facts, or says why it is unusable.
 * A retract naming no line of `facts` and a fact with no text are dropped and
 * counted as rejected. Evidence is only read here; the caller checks it.
 */
export function parseMerge(reply: string, known: ReadonlySet<string>, maxTokens: number, facts: readonly string[] = []): Merge | string {
  const m = /<ops>([\s\S]*?)<\/ops>/.exec(reply)
  let notes: string | undefined
  let rawOps: unknown
  if (m) {
    notes = normalizeLedger(reply.slice(0, m.index))
    const heads = [...notes.matchAll(/^##\s+(.+?)\s*$/gm)].map(h => h[1])
    if (heads.join('|') !== NOTE_SECTIONS.join('|')) return `headers were [${heads.join(', ')}], expected the ${NOTE_SECTIONS.length} note sections in order`
    const notesTokens = estTokens({ role: 'user', text: notes, toolUses: [] })
    if (notesTokens > maxTokens) return `notes are ~${notesTokens}t, over the ${maxTokens}t cap`
    try { rawOps = JSON.parse(normalizeLedger(m[1] ?? '')) } catch (err) { return 'ops are not JSON (' + String(err).slice(0, 80) + ')' }
  } else {
    try {
      const value: unknown = JSON.parse(normalizeLedger(reply))
      rawOps = typeof value === 'object' && value !== null && 'ops' in value ? value.ops : undefined
    } catch (err) { return 'reply is not JSON (' + String(err).slice(0, 80) + ')' }
  }
  if (!Array.isArray(rawOps)) return 'ops are not a JSON array'
  const clauseDrafts: FoldClauseDraft[] = rawOps.filter(isFoldClauseDraft).map(o => ({
    clause: String(o.clause), kind: o.kind as 'fact' | 'goal', text: oneLine(String(o.text)).slice(0, 200), evidence: readEvidence(o.evidence),
    ...(typeof o.issue === 'string' ? { issue: o.issue } : {}), ...(typeof o.key === 'number' ? { key: o.key } : {}),
  }))
  const clauseRetracts = rawOps.flatMap(o => typeof o === 'object' && o !== null && 'retract' in o && typeof o.retract === 'string' ? [{ retract: o.retract }] : [])
  const factOps = rawOps.filter(o => isOp(o, 'fact'))
  const proposed = factOps.flatMap(o => (typeof o.text === 'string' && o.text.trim() ? [{
    text: oneLine(o.text.trim()).slice(0, 300), evidence: readEvidence(o.evidence),
    kind: o.kind === 'constraint' ? 'constraint' as const : 'learned' as const,
  }] : []))
  const legacyClauseFacts: FoldClauseDraft[] = proposed.map(fact => {
    let hash = 2166136261
    for (const char of fact.text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
    return { clause: `legacy_fact('F${(hash >>> 0).toString(16)}').`, kind: 'fact', text: fact.text, evidence: fact.evidence }
  })
  const knownFacts = new Set(facts.map(instructionKey))
  const retractOps = rawOps.filter(o => isOp(o, 'retract'))
  const retracted = retractOps.flatMap(o => (typeof o.fact === 'string' && knownFacts.has(instructionKey(o.fact.replace(/^\s*-\s*/, ''))) ? [o.fact] : []))
  const tracker = rawOps.filter(o => !isFoldClauseDraft(o) && !(typeof o === 'object' && o !== null && 'retract' in o) && !isOp(o, 'fact') && !isOp(o, 'retract'))
  const ops = parseOps(JSON.stringify(tracker), known)
  if (typeof ops === 'string') return ops
  const clauseFacts = clauseDrafts.filter(item => item.kind === 'fact').map(item => ({ text: item.text, evidence: item.evidence }))
  const rejected = ops.rejected + factOps.length - proposed.length + retractOps.length - retracted.length
  return { ...(notes === undefined ? {} : { notes }), ops: ops.ops, evidence: ops.evidence, facts: [...proposed, ...clauseFacts], clauseOps: [...clauseDrafts, ...legacyClauseFacts, ...clauseRetracts], retracted, rejected }
}

// --- review -------------------------------------------------------------------

// clm-prompt
export const REVIEW_SYSTEM = [
  'You audit a ledger update before it replaces the conversation turns it summarizes. Treat each claim as unproven until its cited quote proves it.',
  'You receive <claims>, one JSON object per line with an id, the claim, the evidence it cites (a ref and a quote) and, where the cited row lies outside the range, that row\'s text as `source`; and <folded_range>, the turns, where a user message is headed `[user mN]`, a tool result `<- [id]`, and assistant rows carry no ref; a claim cites the bare key, `mN` or the id; a row whose send time is known carries it in its header after the role and ref.',
  'Judge each claim against the row its ref names, in <folded_range> or in its `source`:',
  '- A claim that a step is done stands only when a cited row shows the state-changing action executed: a tool result with its outcome, or the user saying it happened. A proposal, a recommendation, a plan, or a read-only look at the current state (a PR shown OPEN, a status printed) supports todo or question, so reject the done.',
  '- Every id, number and date in the claim appears in the cited row for the same object; a date or number belonging to another PR, branch, ticket or file is a reject. A date written as `(=...)` beside a relative time expression stands when it equals the cited row\'s header time (`YYYY-MM-DD HH:MM KST`) plus that expression.',
  '- A move to dropped stands when the cited user message abandons, suspends or redirects away from that issue\'s direction.',
  '- A move out of dropped stands only when the cited user message resumes that issue\'s direction.',
  '- A fact stands when the cited row states it. Any other claim stands when the turns show it.',
  '- A constraint claim stands only when a tool result states the constraint or preference. A learned claim quotes the failed result or the user correction that supports it.',
  'Give every claim id exactly one verdict. Reply with only this JSON object:',
  '{"verdicts":[{"id":"<claim id>","accept":true,"reason":"<one line>"}]}',
].join('\n')

export type Verdict = { id: string; accept: boolean; reason: string }
/** Reads the reviewer's JSON object strictly: any other shape is a reason string, and the caller takes the failure path. */
export function parseReview(reply: string): Verdict[] | string {
  const body = normalizeLedger(reply)
  const start = body.indexOf('{'), end = body.lastIndexOf('}')
  if (start < 0 || end < start) return 'review reply holds no JSON object'
  let v: unknown
  try { v = JSON.parse(body.slice(start, end + 1)) } catch (err) { return `review is not JSON (${String(err).slice(0, 80)})` }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'review is not a JSON object'
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.verdicts)) return 'review lacks the verdicts array'
  const verdicts: Verdict[] = []
  for (const x of o.verdicts) {
    if (typeof x !== 'object' || x === null || typeof x.id !== 'string' || typeof x.accept !== 'boolean') return `review verdict ${JSON.stringify(x).slice(0, 80)} is not {id, accept, reason}`
    verdicts.push({ id: x.id, accept: x.accept, reason: typeof x.reason === 'string' ? x.reason : '' })
  }
  return verdicts
}

export const issueList = (issues: readonly Issue[]) =>
  issues.length ? issues.map(i => `${i.id} | ${i.status} | ${i.title}${shownNote(i) ? ` — ${shownNote(i)}` : ''}`).join('\n') : '(none)'
