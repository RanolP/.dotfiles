import type { SessionMessage } from 'claude-code'

import { readEvidence, stripReminders, type Evidence } from './evidence'
import { isPrompt } from './fold'
import { isTrackerSection, parseOps, sectionLines, type Issue, type Payload } from './tracker'

export const SECTIONS = ['목표', '사용자 지시', '한 일', '할 일', '미결 질문', '핵심 사실·경로'] as const
export const EMPTY_LEDGER = SECTIONS.map(s => `## ${s}\n- (none yet)`).join('\n\n')
const OVERSIZE_MARK = '출력 과다:'
const OVERSIZE_KEEP = 5
export const INSTRUCTION_CAP = 4000

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
// alone. 사용자 지시 is owned by preserveInstructions and 핵심 사실·경로 by
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
export const instructionValues = (notes: string): string[] =>
  (sectionOf(notes, INSTRUCTIONS) ?? '').split('\n').slice(1).map(instructionValue).filter((v): v is string => v !== undefined)

/** Rebuilds the stored note sections in ledger order, taking `name`'s body from `body`. */
function withSection(notes: string, name: string, body: string): string {
  return STORED_SECTIONS.map(s => (s === name ? `## ${s}\n${body}` : (sectionOf(notes, s)?.trimEnd() ?? `## ${s}\n- (none yet)`))).join('\n\n')
}

// --- key facts -------------------------------------------------------------

export const FACT_KEEP = 25
export type Fact = { text: string; evidence: Evidence[] }
const isMarked = (line: string) => line.includes(OVERSIZE_MARK) || line.includes(PRESERVED_MARK)
const factBody = (line: string) => line.trim().replace(/^-\s*/, '')
/** The fact lines a ledger holds, the harness's oversize and preserved-output lines aside. */
export const factLines = (notes: string) =>
  (sectionOf(notes, FACTS) ?? '').split('\n').slice(1).filter(l => /^\s*- /.test(l) && l.trim() !== '- (none yet)' && !isMarked(l)).map(factBody)
/** One fact line: the claim, then the quote that carries it. */
export const factLine = (f: Fact) => `${f.text} — quote: ${JSON.stringify(clip(f.evidence[0]?.quote.replace(/\s+/g, ' ').trim() ?? '', 120))}`
/**
 * Owns 핵심 사실·경로: the facts already there minus `retracted` (matched by
 * instructionKey), then `added`, newest FACT_KEEP; the harness's marked lines
 * stay after them for rememberOversize and rememberPreserved.
 */
export function rememberFacts(notes: string, added: readonly Fact[], retracted: readonly string[] = []): string {
  const gone = new Set(retracted.map(r => instructionKey(factBody(r))))
  const marked = (sectionOf(notes, FACTS) ?? '').split('\n').slice(1).filter(isMarked)
  const facts = [...new Set([...factLines(notes).filter(l => !gone.has(instructionKey(l))), ...added.map(factLine)])].slice(-FACT_KEEP)
  const lines = [...facts.map(f => `- ${f}`), ...marked]
  return withSection(notes, FACTS, lines.length ? lines.join('\n') : '- (none yet)')
}

export const INSTRUCTION_CLIP = 2000
export type PreservedInstructions = { notes: string; fullNotes: string }
/**
 * Owns 사용자 지시: the earlier instructions (`prior`, from the ledger file),
 * plus every prompt in `dropped`, each once by instructionKey. Visible notes
 * omit `withdrawn` instructions; `fullNotes` keeps them marked for the ledger file;
 * `notes` clips a line over INSTRUCTION_CLIP chars and the section over `cap`,
 * each with a pointer to that file.
 */
export function preserveInstructions(
  notes: string, prior: readonly string[], dropped: readonly SessionMessage[], pointer: string,
  withdrawn: readonly string[] = [], cap = INSTRUCTION_CAP,
): PreservedInstructions {
  const gone = new Set(withdrawn.map(instructionKey))
  const seen = new Map<string, { text: string; withdrawn: boolean }>()
  for (const raw of [...prior, ...dropped.filter(isPrompt).map(m => stripReminders(m.text))]) {
    const alreadyWithdrawn = raw.startsWith(WITHDRAWN_PREFIX)
    const text = alreadyWithdrawn ? storedInstructionValue(raw.slice(WITHDRAWN_PREFIX.length)) : raw
    const key = instructionKey(text)
    if (!key) continue
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
  const shown = visible.map(v => v.length > INSTRUCTION_CLIP
    ? `- ${JSON.stringify(v.slice(0, INSTRUCTION_CLIP))}…[${v.length - INSTRUCTION_CLIP} chars cut, see ${pointer}]`
    : `- ${JSON.stringify(v)}`)
  const available = Math.max(0, cap - `## ${INSTRUCTIONS}\n`.length)
  let used = 0
  const newestFirst: string[] = []
  for (const line of [...shown].reverse()) {
    const extra = newestFirst.length ? 1 : 0
    if (used + extra + line.length > available) break
    newestFirst.push(line)
    used += extra + line.length
  }
  const kept = newestFirst.reverse()
  const overflow = shown.length > kept.length ? [`- [additional user instructions in ${pointer}]`] : []
  const body = (lines: readonly string[]) => (lines.length ? lines.join('\n') : '- (none yet)')
  return { notes: withSection(notes, INSTRUCTIONS, body([...overflow, ...kept])), fullNotes: withSection(notes, INSTRUCTIONS, body(full)) }
}

// Deterministic stand-in when the merge model keeps failing: the notes stay as
// they were (preserveInstructions adds the dropped prompts), and one done
// issue per dropped turn names the tools it used.
export function fallbackLedger(prevNotes: string, dropped: readonly SessionMessage[]): { notes: string; ops: Payload[] } {
  const turns: { prompt?: string; tools: string[] }[] = []
  for (const m of dropped) {
    if (isPrompt(m) || turns.length === 0) turns.push({ prompt: isPrompt(m) ? m.text : undefined, tools: [] })
    turns[turns.length - 1]!.tools.push(...m.toolUses.map(u => u.tool))
  }
  // No reviewer saw these turns, so a tool having run is recorded as doing, never done.
  const ops = turns.map((t): Payload => ({
    op: 'create', status: 'doing',
    title: `turn ${t.prompt ? `"${clip(oneLine(t.prompt), 60)}"` : '(first request, continued)'}: tools ${t.tools.length ? [...new Set(t.tools)].join(', ') : 'none'}`,
  }))
  return { notes: prevNotes, ops }
}

const EVIDENCE_FIELD = '"evidence":[{"ref":"<ref>","quote":"<text copied exactly from that row>"}]'
// clm-prompt
export const MERGE_SYSTEM = [
  'You keep the working ledger of a coding session whose oldest turns are about to be deleted.',
  'You receive the goal notes, the user\'s standing instructions, the recorded key facts, the open issues of this session\'s tracker, and the turns being removed.',
  'In <removed_turns> a user message is headed `[user mN]` and a tool result `<- [id]`; mN and id are refs you cite. Assistant rows carry no ref: they show what the assistant said or proposed, and the tool results and the user\'s words show what actually happened.',
  `Reply with the updated notes and then \`<ops>\`, starting directly with the heading ${NOTE_SECTIONS.map(s => `"## ${s}"`).join(', ')} and writing the notes as plain markdown.`,
  '- 목표: what the session is trying to achieve, updated if the turns changed it.',
  'Then `<ops>` holding a JSON array of changes the removed turns show, and `</ops>`. Each op is one of:',
  `  {"op":"create","title":"<one line>","status":"todo|doing|done|question","note":"<one line>",${EVIDENCE_FIELD}}`,
  `  {"op":"status","issue":"<id from the issues>","status":"todo|doing|done|question|dropped",${EVIDENCE_FIELD}}`,
  '  {"op":"retitle","issue":"<id from the issues>","title":"<new one line title>"}',
  '  {"op":"progress","issue":"<id from the issues>","done":<integer>,"total":<positive integer>}',
  '  {"op":"note","issue":"<id from the issues>","text":"<one line>"}',
  `  {"op":"fact","text":"<a file path with line number, id, version, number or decision a later step needs>",${EVIDENCE_FIELD}}`,
  '  {"op":"retract","fact":"<one line of <facts>, copied exactly>"} when the removed turns show that fact no longer holds.',
  '  {"op":"withdraw","instruction":"<one line of <instructions>, copied exactly>"} when the removed turns show the user taking that instruction back.',
  'Every done (a create with status done, or a status op to done) and every fact carries evidence: the ref of one user message or tool result, and a quote copied character for character from that row.',
  'A done needs a row showing the state-changing action ran and its outcome: a tool result (the merge output, the passing test count, the written file) or the user saying it happened. A step the assistant proposed, recommended or asked about, and a read-only check of the current state, is todo or question.',
  'Every id, number and date in one claim comes from the same row and names the same object as that row.',
  'The harness keeps the user\'s instructions itself; the prompts in the removed turns are added to them for you.',
  'Create an issue for each step finished (done, with evidence), each step still ahead (todo), and each question still waiting for an answer (question, the note naming who must answer).',
  'Move an existing issue with a status op once the turns show it changed; never re-create it. Issues you do not mention stay as they are. Items listed under <legacy> have no issue yet: create one for each that still holds.',
  'Steps listed under <finished_earlier> are already recorded; leave them as they are.',
  'Write `<ops>[]</ops>` when nothing changed.',
  'Drop small talk and anything later turns replaced. Keep the notes under 300 words.',
].join('\n')

export function renderTurns(rows: readonly SessionMessage[], cap = 120_000): string {
  const out = rows.map(m => {
    const parts = [m.text ? `[${m.role}] ${clip(m.text, 4000)}` : `[${m.role}]`]
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
type Withdraw = { op: 'withdraw'; instruction: string }
const isWithdraw = (o: unknown): o is Withdraw =>
  typeof o === 'object' && o !== null && 'op' in o && o.op === 'withdraw' && 'instruction' in o && typeof o.instruction === 'string'
const isOp = (o: unknown, op: string): o is Record<string, unknown> => typeof o === 'object' && o !== null && 'op' in o && o.op === op
export type Merge = { notes: string; ops: Payload[]; evidence: Evidence[][]; facts: Fact[]; retracted: string[]; withdrawn: string[]; rejected: number }
/**
 * Splits a merge reply into notes, validated tracker ops (with the evidence
 * each cited), proposed facts, retracted facts and withdrawn instructions, or
 * says why it is unusable. A withdraw naming no line of `instructions`, a
 * retract naming no line of `facts`, and a fact with no text are dropped and
 * counted as rejected. Evidence is only read here; the caller checks it.
 */
export function parseMerge(reply: string, known: ReadonlySet<string>, maxTokens: number, instructions: readonly string[] = [], facts: readonly string[] = []): Merge | string {
  const m = /<ops>([\s\S]*?)<\/ops>/.exec(reply)
  if (!m) return 'reply has no <ops>…</ops> block'
  const notes = normalizeLedger(reply.slice(0, m.index))
  const heads = [...notes.matchAll(/^##\s+(.+?)\s*$/gm)].map(h => h[1])
  if (heads.join('|') !== NOTE_SECTIONS.join('|')) return `headers were [${heads.join(', ')}], expected the ${NOTE_SECTIONS.length} note sections in order`
  if (Math.ceil(notes.length / 4) > maxTokens) return `notes are ~${Math.ceil(notes.length / 4)}t, over the ${maxTokens}t cap`
  let rawOps: unknown
  try { rawOps = JSON.parse(normalizeLedger(m[1] ?? '')) } catch (err) { return 'ops are not JSON (' + String(err).slice(0, 80) + ')' }
  if (!Array.isArray(rawOps)) return 'ops are not a JSON array'
  const current = new Set(instructions.map(instructionKey))
  const withdraws = rawOps.filter(isWithdraw)
  const withdrawn = withdraws.map(o => o.instruction).filter(t => current.has(instructionKey(t)))
  const factOps = rawOps.filter(o => isOp(o, 'fact'))
  const proposed = factOps.flatMap(o => (typeof o.text === 'string' && o.text.trim() ? [{ text: oneLine(o.text.trim()).slice(0, 300), evidence: readEvidence(o.evidence) }] : []))
  const knownFacts = new Set(facts.map(instructionKey))
  const retractOps = rawOps.filter(o => isOp(o, 'retract'))
  const retracted = retractOps.flatMap(o => (typeof o.fact === 'string' && knownFacts.has(instructionKey(o.fact.replace(/^\s*-\s*/, ''))) ? [o.fact] : []))
  const tracker = rawOps.filter(o => !isWithdraw(o) && !isOp(o, 'fact') && !isOp(o, 'retract'))
  const ops = parseOps(JSON.stringify(tracker), known)
  if (typeof ops === 'string') return ops
  const rejected = ops.rejected + withdraws.length - withdrawn.length + factOps.length - proposed.length + retractOps.length - retracted.length
  return { notes, ops: ops.ops, evidence: ops.evidence, facts: proposed, retracted, withdrawn, rejected }
}

// --- review -------------------------------------------------------------------

// clm-prompt
export const REVIEW_SYSTEM = [
  'You audit a ledger update before it replaces the conversation turns it summarizes. Treat each claim as unproven until its cited quote proves it.',
  'You receive <claims>, one JSON object per line with an id, the claim, the evidence it cites (a ref and a quote) and, where the cited row lies outside the range, that row\'s text as `source`; and <folded_range>, the turns, where a user message is headed `[user mN]`, a tool result `<- [id]`, and assistant rows carry no ref.',
  'Judge each claim against the row its ref names, in <folded_range> or in its `source`:',
  '- A claim that a step is done stands only when a cited row shows the state-changing action executed: a tool result with its outcome, or the user saying it happened. A proposal, a recommendation, a plan, or a read-only look at the current state (a PR shown OPEN, a status printed) supports todo or question, so reject the done.',
  '- Every id, number and date in the claim appears in the cited row for the same object; a date or number belonging to another PR, branch, ticket or file is a reject.',
  '- A fact stands when the cited row states it. Any other claim stands when the turns show it.',
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
  issues.length ? issues.map(i => `${i.id} | ${i.status} | ${i.title}${i.notes.length ? ` — ${i.notes.at(-1)}` : ''}`).join('\n') : '(none)'
