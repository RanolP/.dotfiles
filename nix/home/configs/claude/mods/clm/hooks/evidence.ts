import type { SessionMessage } from 'claude-code'

import { isUserTyped, stripReminders } from './fold'
import type { Payload } from './tracker'

// A summary claim (a done step, a key fact, a user instruction) stands only on
// a verbatim quote from one row of the folded range. The rows a quote may come
// from are the user's messages and tool results: the assistant's own prose is
// where a recommendation ("closing it is fine") turns into a recorded "closed",
// so it carries no ref and cannot be cited. A user-role row the harness wrote
// (a reminder, a skill body, a command expansion, an agent's hand-back) is not
// the user speaking, so only a prompt the user typed carries a ref, and the
// system reminders inside it are cut before it is rendered or quoted.

export type Evidence = { ref: string; quote: string }
export type SourceKind = 'user' | 'tool_result'
export type Source = { kind: SourceKind; text: string; tool?: string; isError?: boolean }
export type Sources = ReadonlyMap<string, Source>

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const TEXT_CLIP = 4000, RESULT_CLIP = 1500, INPUT_CLIP = 600
// A quote proves something only when it is long enough to be specific: four
// words, or, for CJK text whose words run long or unspaced, eight characters.
const MIN_WORDS = 4, MIN_CJK_CHARS = 8
const CJK = /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
const tooShort = (quote: string) => quote.split(' ').length < MIN_WORDS && !(CJK.test(quote) && quote.replace(/\s/g, '').length >= MIN_CJK_CHARS)
// A subagent's report or a message relay is another model's prose, so it proves no step done.
const RELAY_TOOLS = new Set(['Agent', 'Task', 'SendMessage'])


/** The ref of a user row: its 1-based position in the rendered range. */
export const rowRef = (i: number) => `m${i + 1}`

/**
 * Renders rows for a model with a ref on every citable row, and returns each
 * ref's text exactly as rendered (clipped), which is what a quote is checked
 * against. Over `cap`, whole oldest rows go, so every kept ref is shown whole.
 */
export function renderRange(rows: readonly SessionMessage[], cap = 120_000): { text: string; sources: Map<string, Source> } {
  const toolOf = new Map(rows.flatMap(m => m.toolUses.map(u => [u.tool_use_id, u.tool] as const)))
  const rendered = rows.map((m, i) => {
    const sources: [string, Source][] = []
    let head = `[${m.role}]`
    const shown = m.role === 'user' ? stripReminders(m.text) : m.text
    if (shown) {
      const text = clip(shown, TEXT_CLIP)
      if (m.role === 'assistant') head = `[assistant] ${text}`
      else if (isUserTyped(m)) {
        head = `[user ${rowRef(i)}] ${text}`
        sources.push([rowRef(i), { kind: 'user', text }])
      } else head = `[harness] ${text}`
    }
    const parts = [head]
    for (const u of m.toolUses) parts.push(`  -> ${u.tool} ${clip(JSON.stringify(u.input ?? {}), INPUT_CLIP)}`)
    for (const r of m.toolResults ?? []) {
      const text = clip(r.text, RESULT_CLIP)
      parts.push(`  <- [${r.tool_use_id}] ${r.isError ? 'error ' : ''}${text}`)
      sources.push([r.tool_use_id, { kind: 'tool_result', text, tool: toolOf.get(r.tool_use_id), isError: r.isError }])
    }
    return { text: parts.join('\n'), sources }
  })
  const kept: typeof rendered = []
  let used = 0
  for (let i = rendered.length - 1; i >= 0; i--) {
    const row = rendered[i]!
    if (kept.length && used + row.text.length + 1 > cap) break
    kept.unshift(row)
    used += row.text.length + 1
  }
  const cut = kept.length < rendered.length ? '…[older part cut]\n' : ''
  return { text: cut + kept.map(r => r.text).join('\n'), sources: new Map(kept.flatMap(r => r.sources)) }
}

/** Reads a model's `evidence` field leniently: anything but `{ref, quote}` strings is skipped. */
export function readEvidence(v: unknown): Evidence[] {
  if (!Array.isArray(v)) return []
  return v.flatMap(e => (typeof e === 'object' && e !== null && typeof e.ref === 'string' && typeof e.quote === 'string' ? [{ ref: e.ref, quote: e.quote }] : []))
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * Why `e` fails as evidence from `admissible` rows of `sources`, or undefined
 * when it holds. `forDone` also refuses a failed tool result and a subagent's
 * or relay's report, which show no step of this session executing.
 */
export function evidenceProblem(e: Evidence, sources: Sources, admissible: readonly SourceKind[], forDone = false): string | undefined {
  const source = sources.get(e.ref)
  if (!source) return `ref ${e.ref} is not a citable row of the folded range`
  if (!admissible.includes(source.kind)) return `ref ${e.ref} is a ${source.kind}, not ${admissible.join(' or ')}`
  if (forDone && source.isError) return `ref ${e.ref} is a failed tool result, which proves no done`
  if (forDone && source.tool && RELAY_TOOLS.has(source.tool)) return `ref ${e.ref} is a ${source.tool} report, which proves no done`
  const quote = squash(e.quote)
  if (tooShort(quote)) return `quote ${JSON.stringify(e.quote)} is too short to cite (under ${MIN_WORDS} words)`
  if (!squash(source.text).includes(quote)) return `quote ${JSON.stringify(clip(e.quote, 80))} is not in ${e.ref}`
  return undefined
}

/** The evidence items that hold, and one problem line per item that does not. */
export function checkEvidence(list: readonly Evidence[], sources: Sources, admissible: readonly SourceKind[] = ['user', 'tool_result'], forDone = false): { held: Evidence[]; problems: string[] } {
  const held: Evidence[] = [], problems: string[] = []
  for (const e of list) {
    const p = evidenceProblem(e, sources, admissible, forDone)
    if (p) problems.push(p)
    else held.push(e)
  }
  return { held, problems }
}

export const isDoneClaim = (o: Payload) => (o.op === 'create' || o.op === 'status') && o.status === 'done'

/** A done claim that lost its evidence: a create keeps the step as `doing`; a status move to done becomes a move to doing. */
export const downgrade = (o: Payload): Payload => (o.op === 'create' || o.op === 'status' ? { ...o, status: 'doing' } : o)

/** Appends the first held quote to a done create's note, so 한 일 shows what proved it. */
export function citeNote(o: Payload, held: readonly Evidence[]): Payload {
  const first = held[0]
  if (o.op !== 'create' || !first) return o
  const cite = `quote: ${JSON.stringify(clip(squash(first.quote), 120))}`
  return { ...o, note: o.note ? `${o.note} (${cite})` : cite }
}

/**
 * Applies the mechanical check to tracker ops: a done claim with no held
 * evidence is downgraded. Returns the ops (aligned with `evidence` by index,
 * now holding only the held items) and one line per rejection.
 */
export function gateOps(ops: readonly Payload[], evidence: readonly Evidence[][], sources: Sources): { ops: Payload[]; evidence: Evidence[][]; rejections: string[] } {
  const out: Payload[] = [], kept: Evidence[][] = [], rejections: string[] = []
  ops.forEach((o, i) => {
    if (!isDoneClaim(o)) {
      out.push(o)
      kept.push([])
      return
    }
    const { held, problems } = checkEvidence(evidence[i] ?? [], sources, undefined, true)
    if (held.length) {
      out.push(citeNote(o, held))
      kept.push(held)
      return
    }
    rejections.push(`${describeOp(o)}: done downgraded to doing (${problems.join('; ') || 'no evidence'})`)
    out.push(downgrade(o))
    kept.push([])
  })
  return { ops: out, evidence: kept, rejections }
}

export const describeOp = (o: Payload, title?: string): string => {
  switch (o.op) {
    case 'create': return `create "${o.title}" as ${o.status}${o.note ? ` (note: ${o.note})` : ''}`
    case 'status': return `issue ${o.issue}${title ? ` "${title}"` : ''} moves to ${o.status}`
    case 'retitle': return `issue ${o.issue} is retitled "${o.title}"`
    case 'progress': return `issue ${o.issue} progress ${o.done}/${o.total}`
    case 'note': return `issue ${o.issue} gets note "${o.text}"`
    case 'task': return `issue ${o.issue} links panel task ${o.taskId}`
    case 'link': return `issue ${o.issue} is linked`
  }
}
