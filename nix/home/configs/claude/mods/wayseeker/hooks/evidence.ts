// Copied from clm (hooks/evidence.ts, hooks/text.ts) so wayseeker imports nothing from clm: the quote check a
// rubric evidence item stands on. A quote may come only from a prompt the user typed or a tool result, never the
// assistant's own prose, with system reminders cut before it is rendered or quoted.
import type { SessionMessage } from 'claude-code'

import { isHarnessText, stripReminders } from './text'

const isBare = (m: SessionMessage) => m.toolUses.length === 0 && (m.toolResults ?? []).length === 0
// SessionMessage has no origin flag, so injected rows are identified by their text.
const SYSTEM_ROW = {
  taskNotification: /^\s*<task-notification>/,
  remindersOnly: /^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/,
  localCommand: /^\s*(?:<command-name>\/(?:clear|compact)<\/command-name>|<local-command-(?:stdout|stderr|caveat)>)/,
}
const isSystemRow = (m: SessionMessage): boolean => {
  if (!isBare(m)) return false
  if (m.role === 'assistant') return m.text.trim() === '' || m.text.trim() === '(no content)'
  return SYSTEM_ROW.taskNotification.test(m.text) || SYSTEM_ROW.remindersOnly.test(m.text) || SYSTEM_ROW.localCommand.test(m.text)
}
const isPrompt = (m: SessionMessage) => m.role === 'user' && m.text.trim() !== '' && (m.toolResults ?? []).length === 0 && !isSystemRow(m)
const isCompactSummary = (m: SessionMessage): boolean => (m as SessionMessage & { isCompactSummary?: boolean }).isCompactSummary === true
/** A prompt the user wrote: what may be quoted as the user. */
export const isUserTyped = (m: SessionMessage) => !isCompactSummary(m) && isPrompt(m) && !isHarnessText(stripReminders(m.text))

export type Evidence = { ref: string; quote: string }
export type SourceKind = 'user' | 'tool_result' | 'assistant'
// `full` is the row's text before display clipping, kept so a quote taken from
// past the clip still matches; it is itself capped so a held source stays small.
export type Source = { kind: SourceKind; text: string; full?: string; tool?: string; toolInput?: string; isError?: boolean }
export type Sources = ReadonlyMap<string, Source>

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const TEXT_CLIP = 4000, RESULT_CLIP = 1500, INPUT_CLIP = 600
export const FULL_CLIP = 20_000
/** The source fields for a row shown clipped to `n`: `full` only when the clip cut something. */
export const clippedSource = (raw: string, n: number) => {
  const text = clip(raw, n)
  return text === raw ? { text } : { text, full: raw.slice(0, FULL_CLIP) }
}
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
export function renderRange(rows: readonly SessionMessage[], cap = 120_000, refOffset = 0): { text: string; sources: Map<string, Source> } {
  const toolUseOf = new Map(rows.flatMap(m => m.toolUses.map(u => [u.tool_use_id, {
    tool: u.tool,
    input: clip(JSON.stringify(u.input ?? {}) ?? '{}', INPUT_CLIP),
  }] as const)))
  const rendered = rows.map((m, i) => {
    const sources: [string, Source][] = []
    let head = `[${m.role}]`
    const shown = m.role === 'user' ? stripReminders(m.text) : m.text
    if (shown) {
      const { text, full } = clippedSource(shown, TEXT_CLIP)
      if (m.role === 'assistant') head = `[assistant] ${text}`
      else if (isUserTyped(m)) {
        head = `[user ${rowRef(i + refOffset)}] ${text}`
        sources.push([rowRef(i + refOffset), { kind: 'user', text, ...(full ? { full } : {}) }])
      } else head = `[harness] ${text}`
    }
    const parts = [head]
    for (const u of m.toolUses) parts.push(`  -> ${u.tool} ${clip(JSON.stringify(u.input ?? {}), INPUT_CLIP)}`)
    for (const r of m.toolResults ?? []) {
      const { text, full } = clippedSource(r.text, RESULT_CLIP)
      parts.push(`  <- [${r.tool_use_id}] ${r.isError ? 'error ' : ''}${text}`)
      const toolUse = toolUseOf.get(r.tool_use_id)
      sources.push([r.tool_use_id, {
        kind: 'tool_result', text, ...(full ? { full } : {}),
        ...(toolUse ? { tool: toolUse.tool, toolInput: toolUse.input } : {}), isError: r.isError,
      }])
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

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
// A model copying a clipped row copies the clip's `…` too, or marks a skipped
// middle with one; each `…`-separated piece must then appear, in order, in the
// row, and each must be specific on its own: short pieces scattered across a
// row ("push…to…origin…main") prove nothing their join seems to say.
const quoteParts = (quote: string) => quote.split('…').map(squash).filter(Boolean)
function quoteIn(quote: string, source: Source): boolean {
  const row = squash((source.full ?? source.text).replace(/…/g, ' '))
  let at = 0
  for (const part of quoteParts(quote)) {
    const i = row.indexOf(part, at)
    if (i < 0) return false
    at = i + part.length
  }
  return true
}

/**
 * Why `e` fails as evidence from `admissible` rows of `sources`, or undefined
 * when it holds. `forDone` also refuses a failed tool result and a subagent's
 * or relay's report, which show no step of this session executing.
 */
// The merge model often cites a ref the way the range renders it
// (`<- [toolu_…]`, `[user m4 2026-10-15 14:03 KST]`), drops or upcases the
// `m`, or changes a tool id's case; each such spelling names one row. A ref
// that only mentions a row (`[assistant after m4]`) also resolves to it, and
// the quote check then refuses the assistant prose it actually quotes.
const STAMP = /\d{4}-\d\d-\d\d \d\d:\d\d(?: KST)?/g
/** The source key `ref` names, or undefined when it names no citable row. */
export function resolveRef(ref: string, sources: Sources): string | undefined {
  if (sources.has(ref)) return ref
  const tokensOf = (value: string) => value.replace(STAMP, ' ').replace(/\bm\s+(\d+)\b/gi, 'm$1').match(/[\p{L}\p{N}_]+/gu) ?? []
  const tokens = tokensOf(ref)
  const lower = new Map<string, Set<string>>()
  for (const key of sources.keys()) for (const token of tokensOf(key)) {
    const normalized = token.toLowerCase()
    const keys = lower.get(normalized) ?? new Set<string>()
    keys.add(key)
    lower.set(normalized, keys)
    const row = /^m?(\d+)$/i.exec(token)
    if (row) {
      const rowKeys = lower.get(`m${row[1]}`) ?? new Set<string>()
      rowKeys.add(key)
      lower.set(`m${row[1]}`, rowKeys)
    }
  }
  const matches = new Set<string>()
  for (const t of tokens) {
    for (const key of lower.get(t.toLowerCase()) ?? []) matches.add(key)
    const row = /^m?(\d+)$/i.exec(t)
    if (row && (tokens.length === 1 || /^m/i.test(t))) {
      for (const key of lower.get(`m${row[1]}`) ?? []) matches.add(key)
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined
}

export function evidenceProblem(e: Evidence, sources: Sources, admissible: readonly SourceKind[], forDone = false): string | undefined {
  const key = resolveRef(e.ref, sources)
  const source = key === undefined ? undefined : sources.get(key)
  if (!source) return `ref ${e.ref} is not a citable row of the transcript range`
  if (!admissible.includes(source.kind)) return `ref ${e.ref} is a ${source.kind}, not ${admissible.join(' or ')}`
  if (forDone && source.isError) return `ref ${e.ref} is a failed tool result, which proves no done`
  if (forDone && source.tool && RELAY_TOOLS.has(source.tool)) return `ref ${e.ref} is a ${source.tool} report, which proves no done`
  const parts = quoteParts(e.quote)
  if (!parts.length || parts.some(tooShort)) return `quote ${JSON.stringify(e.quote)} is too short to cite (under ${MIN_WORDS} words)`
  if (!quoteIn(e.quote, source)) return `quote ${JSON.stringify(clip(e.quote, 80))} is not in ${e.ref}`
  return undefined
}

/** The evidence items that hold, and one problem line per item that does not. */
export function checkEvidence(list: readonly Evidence[], sources: Sources, admissible: readonly SourceKind[] = ['user', 'tool_result'], forDone = false): { held: Evidence[]; problems: string[] } {
  const held: Evidence[] = [], problems: string[] = []
  for (const e of list) {
    const p = evidenceProblem(e, sources, admissible, forDone)
    if (p) problems.push(p)
    else held.push({ ...e, ref: resolveRef(e.ref, sources)! })
  }
  return { held, problems }
}
