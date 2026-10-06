import type { SessionMessage } from 'claude-code'

import { isPrompt } from './fold'
import { isTrackerSection, parseOps, sectionLines, type Issue, type Payload } from './tracker'

export const SECTIONS = ['목표', '사용자 지시', '한 일', '할 일', '미결 질문', '핵심 사실·경로'] as const
export const EMPTY_LEDGER = SECTIONS.map(s => `## ${s}\n- (none yet)`).join('\n\n')
const OVERSIZE_MARK = '출력 과다:'
const OVERSIZE_KEEP = 5

// --- ledger text ---------------------------------------------------------

const sectionsOf = (ledger: string) => ledger.split(/^(?=## )/m)
const isSection = (part: string, name: string) => part.trimEnd() === `## ${name}` || part.startsWith(`## ${name}\n`)

/** Adds lines at the end of one section, replacing its "(none yet)" placeholder. */
export function appendToSection(ledger: string, section: string, lines: readonly string[]): string {
  if (lines.length === 0) return ledger
  return sectionsOf(ledger)
    .map(p => (isSection(p, section) ? `${[...p.trimEnd().split('\n').filter(l => l.trim() !== '- (none yet)'), ...lines].join('\n')}\n\n` : p))
    .join('')
    .trimEnd()
}

/** Records commands whose output had to be cut, newest five only. */
export function rememberOversize(ledger: string, lines: readonly string[]): string {
  if (lines.length === 0) return ledger
  return sectionsOf(ledger)
    .map(p => {
      if (!isSection(p, '핵심 사실·경로')) return p
      const body = p.trimEnd().split('\n')
      const keep = [...body.filter(l => l.includes(OVERSIZE_MARK)), ...lines].slice(-OVERSIZE_KEEP)
      return `${[...body.filter(l => !l.includes(OVERSIZE_MARK) && l.trim() !== '- (none yet)'), ...keep].join('\n')}\n\n`
    })
    .join('')
    .trimEnd()
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ')
export const oversizeLines = (tail: readonly SessionMessage[], cuts: Record<string, number>) =>
  tail.flatMap(m => m.toolUses).filter(u => cuts[u.tool_use_id] !== undefined)
    .map(u => `- ${OVERSIZE_MARK} ${clip(oneLine(`${u.tool} ${JSON.stringify(u.input ?? {})}`), 70)}`)

// The merged half of the ledger; the other three sections come from the tracker.
export const NOTE_SECTIONS = SECTIONS.filter(s => !isTrackerSection(s))
const EMPTY_NOTES = NOTE_SECTIONS.map(s => `## ${s}\n- (none yet)`).join('\n\n')
export const notesOf = (ledger: string) =>
  sectionsOf(ledger).filter(p => NOTE_SECTIONS.some(s => isSection(p, s))).join('').trimEnd() || EMPTY_NOTES
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

// Deterministic stand-in when the merge model keeps failing: the dropped
// prompts verbatim into the notes, and one done issue per dropped turn naming
// the tools it used.
export function fallbackLedger(prevNotes: string, dropped: readonly SessionMessage[]): { notes: string; ops: Payload[] } {
  const turns: { prompt?: string; tools: string[] }[] = []
  for (const m of dropped) {
    if (isPrompt(m) || turns.length === 0) turns.push({ prompt: isPrompt(m) ? m.text : undefined, tools: [] })
    turns[turns.length - 1]!.tools.push(...m.toolUses.map(u => u.tool))
  }
  const asks = turns.flatMap(t => (t.prompt ? [`- "${oneLine(t.prompt)}"`] : []))
  const ops = turns.map((t): Payload => ({
    op: 'create', status: 'done',
    title: `turn ${t.prompt ? `"${clip(oneLine(t.prompt), 60)}"` : '(first request, continued)'}: tools ${t.tools.length ? [...new Set(t.tools)].join(', ') : 'none'}`,
  }))
  return { notes: appendToSection(prevNotes, '사용자 지시', asks), ops }
}

export const MERGE_SYSTEM = [
  'You keep the working ledger of a coding session whose oldest turns are about to be deleted.',
  'You receive the current notes, the open issues of the session\'s tracker, and the turns being removed.',
  'Reply with two parts and nothing else: no preamble, no code fence.',
  `First the updated notes, using exactly these level-2 headings, each once, in this order: ${NOTE_SECTIONS.map(s => `"## ${s}"`).join(', ')}.`,
  '- 목표: what the session is trying to achieve, updated if the turns changed it.',
  '- 사용자 지시: every instruction the user gave, copied word for word inside quotes. Never paraphrase. Keep earlier ones unless the user withdrew them.',
  `- 핵심 사실·경로: file paths with line numbers, ids, versions, numbers and decisions a later step will need. Keep lines starting with "${OVERSIZE_MARK}" as they are.`,
  'Then `<ops>` holding a JSON array of tracker changes the removed turns show, and `</ops>`. Each op is one of:',
  '  {"op":"create","title":"<one line>","status":"todo|doing|done|question","note":"<evidence: the command or check and what it printed>"}',
  '  {"op":"status","issue":"<id from the issues>","status":"todo|doing|done|question|dropped"}',
  '  {"op":"note","issue":"<id from the issues>","text":"<one line>"}',
  'Create an issue for each step finished (status done, with its evidence as note), each step still ahead (todo), and each question still waiting for an answer (question, the note naming who must answer).',
  'Move an existing issue with a status op once the turns show it changed; never re-create it. Issues you do not mention stay as they are. Items listed under <legacy> have no issue yet: create one for each that still holds.',
  'Write `<ops>[]</ops>` when nothing changed. Drop small talk and anything later turns replaced. Keep the notes under 600 words.',
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
/** Splits a merge reply into notes and validated ops, or says why it is unusable. */
export function parseMerge(reply: string, known: ReadonlySet<string>, maxTokens: number): { notes: string; ops: Payload[]; rejected: number } | string {
  const m = /<ops>([\s\S]*?)<\/ops>/.exec(reply)
  if (!m) return 'reply has no <ops>…</ops> block'
  const notes = normalizeLedger(reply.slice(0, m.index))
  const heads = [...notes.matchAll(/^##\s+(.+?)\s*$/gm)].map(h => h[1]!)
  if (heads.join('|') !== NOTE_SECTIONS.join('|')) return `headers were [${heads.join(', ')}], expected the ${NOTE_SECTIONS.length} note sections in order`
  if (Math.ceil(notes.length / 4) > maxTokens) return `notes are ~${Math.ceil(notes.length / 4)}t, over the ${maxTokens}t cap`
  const ops = parseOps(normalizeLedger(m[1]!), known)
  return typeof ops === 'string' ? ops : { notes, ...ops }
}
export const issueList = (issues: readonly Issue[]) =>
  issues.length ? issues.map(i => `${i.id} | ${i.status} | ${i.title}${i.notes.length ? ` — ${i.notes.at(-1)}` : ''}`).join('\n') : '(none)'
