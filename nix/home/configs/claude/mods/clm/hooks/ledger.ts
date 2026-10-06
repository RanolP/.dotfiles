import type { SessionMessage } from 'claude-code'

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

// The merged half of the ledger: the sections the merge model rewrites. 사용자
// 지시 is kept beside them in the notes but owned by preserveInstructions, and
// the other three sections come from the tracker.
const INSTRUCTIONS = '사용자 지시'
export const NOTE_SECTIONS = SECTIONS.filter(s => !isTrackerSection(s) && s !== INSTRUCTIONS)
const STORED_SECTIONS = SECTIONS.filter(s => !isTrackerSection(s))
const EMPTY_NOTES = STORED_SECTIONS.map(s => `## ${s}\n- (none yet)`).join('\n\n')
export const notesOf = (ledger: string) =>
  sectionsOf(ledger).filter(p => STORED_SECTIONS.some(s => isSection(p, s))).join('').trimEnd() || EMPTY_NOTES
/** The notes the merge model rewrites: everything but the instruction section. */
export const mergeableNotes = (notes: string) =>
  sectionsOf(notes).filter(p => NOTE_SECTIONS.some(s => isSection(p, s))).join('').trimEnd()
// A ledger written before the tracker existed holds merged items in the
// tracker sections; they carry no `[id]`, and the merge model turns them into
// create ops once so they are not lost on the first fold after the upgrade.
export const legacyItems = (ledger: string) =>
  sectionsOf(ledger).filter(p => [...SECTIONS].some(s => isTrackerSection(s) && isSection(p, s)))
    .flatMap(p => p.split('\n').slice(1)).filter(l => /^\s*- /.test(l) && l.trim() !== '- (none yet)' && !/\[[^\]\s]+-\d+\]\s*$/.test(l))

export function composeLedger(notes: string, issues: readonly Issue[], stale = 0): string {
  const parts = sectionsOf(notes)
  return SECTIONS.map(s =>
    isTrackerSection(s) ? `## ${s}\n${sectionLines(issues, s, stale).join('\n')}` : (parts.find(p => isSection(p, s))?.trimEnd() ?? `## ${s}\n- (none yet)`),
  ).join('\n\n')
}

// A ledger written before instructions were stored as JSON strings holds
// free-form lines (`"..." (UI 검증)`, `PR 병합에 대해: "..."`); each is kept
// verbatim, and only a fully quoted line is unquoted.
const instructionValue = (line: string): string | undefined => {
  const raw = line.trim().replace(/^-\s*/, '')
  if (!raw || raw === '(none yet)' || raw.startsWith('[additional user instructions in ')) return undefined
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value === 'string') return value
  } catch {
    // Quoted but not valid JSON: strip the outer quotes only.
  }
  return raw.slice(1, -1)
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

export const INSTRUCTION_CLIP = 2000
export type PreservedInstructions = { notes: string; fullNotes: string }
/**
 * Owns 사용자 지시: the earlier instructions (`prior`, from the ledger file),
 * plus every prompt in `dropped`, minus the `withdrawn` ones, each once by
 * instructionKey. `fullNotes` keeps every line whole for the ledger file;
 * `notes` clips a line over INSTRUCTION_CLIP chars and the section over `cap`,
 * each with a pointer to that file.
 */
export function preserveInstructions(
  notes: string, prior: readonly string[], dropped: readonly SessionMessage[], pointer: string,
  withdrawn: readonly string[] = [], cap = INSTRUCTION_CAP,
): PreservedInstructions {
  const gone = new Set(withdrawn.map(instructionKey))
  const seen = new Set<string>()
  const values: string[] = []
  for (const text of [...prior, ...dropped.filter(isPrompt).map(m => m.text)]) {
    const key = instructionKey(text)
    if (!key || seen.has(key) || gone.has(key)) continue
    seen.add(key)
    values.push(text)
  }
  const full = values.map(v => `- ${JSON.stringify(v)}`)
  const shown = values.map(v => v.length > INSTRUCTION_CLIP
    ? `- ${JSON.stringify(v.slice(0, INSTRUCTION_CLIP))}…[${v.length - INSTRUCTION_CLIP} chars cut, see ${pointer}]`
    : `- ${JSON.stringify(v)}`)
  const available = Math.max(0, cap - `## ${INSTRUCTIONS}\n`.length)
  let used = 0
  const kept: string[] = []
  for (const line of shown) {
    const extra = kept.length ? 1 : 0
    if (used + extra + line.length > available) break
    kept.push(line)
    used += extra + line.length
  }
  const overflow = shown.length > kept.length ? [`- [additional user instructions in ${pointer}]`] : []
  const body = (lines: readonly string[]) => (lines.length ? lines.join('\n') : '- (none yet)')
  return { notes: withSection(notes, INSTRUCTIONS, body([...kept, ...overflow])), fullNotes: withSection(notes, INSTRUCTIONS, body(full)) }
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
  const ops = turns.map((t): Payload => ({
    op: 'create', status: 'done',
    title: `turn ${t.prompt ? `"${clip(oneLine(t.prompt), 60)}"` : '(first request, continued)'}: tools ${t.tools.length ? [...new Set(t.tools)].join(', ') : 'none'}`,
  }))
  return { notes: prevNotes, ops }
}

export const MERGE_SYSTEM = [
  'You keep the working ledger of a coding session whose oldest turns are about to be deleted.',
  'You receive the current notes, the user\'s standing instructions, the open issues of the session\'s tracker, and the turns being removed.',
  'Reply with the updated notes and then `<ops>`, starting directly with the first heading and writing the notes as plain markdown.',
  `First the updated notes, using exactly these level-2 headings, each once, in this order: ${NOTE_SECTIONS.map(s => `"## ${s}"`).join(', ')}.`,
  '- 목표: what the session is trying to achieve, updated if the turns changed it.',
  `- 핵심 사실·경로: file paths with line numbers, ids, versions, numbers and decisions a later step will need. Keep lines starting with "${OVERSIZE_MARK}" as they are.`,
  'Then `<ops>` holding a JSON array of tracker changes the removed turns show, and `</ops>`. Each op is one of:',
  '  {"op":"create","title":"<one line>","status":"todo|doing|done|question","note":"<evidence: the command or check and what it printed>"}',
  '  {"op":"status","issue":"<id from the issues>","status":"todo|doing|done|question|dropped"}',
  '  {"op":"retitle","issue":"<id from the issues>","title":"<new one line title>"}',
  '  {"op":"progress","issue":"<id from the issues>","done":<integer>,"total":<positive integer>}',
  '  {"op":"note","issue":"<id from the issues>","text":"<one line>"}',
  // clm-prompt
  '  {"op":"withdraw","instruction":"<one line of <instructions>, copied exactly>"} when the removed turns show the user taking that instruction back.',
  'The harness keeps the user\'s instructions itself; the prompts in the removed turns are added to them for you, so the notes carry only the sections above.',
  'Create an issue for each step finished (status done, with its evidence as note), each step still ahead (todo), and each question still waiting for an answer (question, the note naming who must answer).',
  'Move an existing issue with a status op once the turns show it changed; never re-create it. Issues you do not mention stay as they are. Items listed under <legacy> have no issue yet: create one for each that still holds.',
  'Write `<ops>[]</ops>` when no task changed.',
  'Drop small talk and anything later turns replaced. Keep the notes under 600 words.',
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
/**
 * Splits a merge reply into notes, validated tracker ops and the instructions
 * it withdraws, or says why it is unusable. A withdraw naming no line of
 * `instructions` is dropped and counted as rejected.
 */
export function parseMerge(reply: string, known: ReadonlySet<string>, maxTokens: number, instructions: readonly string[] = []):
  { notes: string; ops: Payload[]; withdrawn: string[]; rejected: number } | string {
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
  const ops = parseOps(JSON.stringify(rawOps.filter(o => !isWithdraw(o))), known)
  return typeof ops === 'string' ? ops : { notes, ops: ops.ops, withdrawn, rejected: ops.rejected + withdraws.length - withdrawn.length }
}
export const issueList = (issues: readonly Issue[]) =>
  issues.length ? issues.map(i => `${i.id} | ${i.status} | ${i.title}${i.notes.length ? ` — ${i.notes.at(-1)}` : ''}`).join('\n') : '(none)'
