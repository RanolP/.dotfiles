import type { SessionMessage } from 'claude-code'

import type { SentAt } from './address'
import { isUserTyped, kst, stripReminders } from './fold'
import type { Issue, Payload } from './tracker'

// A summary claim (a done step, a key fact, a user instruction) stands only on
// a verbatim quote from one row of the folded range. The rows a quote may come
// from are the user's messages and tool results: the assistant's own prose is
// where a recommendation ("closing it is fine") turns into a recorded "closed",
// so it carries no ref and cannot be cited. A user-role row the harness wrote
// (a reminder, a skill body, a command expansion, an agent's hand-back) is not
// the user speaking, so only a prompt the user typed carries a ref, and the
// system reminders inside it are cut before it is rendered or quoted.

export type Evidence = { ref: string; quote: string }
export type SourceKind = 'user' | 'tool_result' | 'assistant'
// `full` is the row's text before display clipping, kept so a quote taken from
// past the clip still matches; it is itself capped so a held source stays small.
export type Source = { kind: SourceKind; text: string; full?: string; tool?: string; isError?: boolean }
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


/** ` 2026-10-15 14:03 KST` when the row's send time is known, '' otherwise. */
export const sentStamp = (m: SessionMessage, sentAt?: SentAt) => {
  const at = sentAt?.(m)
  return at ? ` ${kst(at)}` : ''
}

/** The ref of a user row: its 1-based position in the rendered range. */
export const rowRef = (i: number) => `m${i + 1}`

/**
 * Renders rows for a model with a ref on every citable row, and returns each
 * ref's text exactly as rendered (clipped), which is what a quote is checked
 * against. Over `cap`, whole oldest rows go, so every kept ref is shown whole.
 */
export function renderRange(rows: readonly SessionMessage[], cap = 120_000, refOffset = 0, sentAt?: SentAt): { text: string; sources: Map<string, Source> } {
  const toolOf = new Map(rows.flatMap(m => m.toolUses.map(u => [u.tool_use_id, u.tool] as const)))
  const rendered = rows.map((m, i) => {
    const sources: [string, Source][] = []
    const at = sentStamp(m, sentAt)
    let head = `[${m.role}${at}]`
    const shown = m.role === 'user' ? stripReminders(m.text) : m.text
    if (shown) {
      const { text, full } = clippedSource(shown, TEXT_CLIP)
      if (m.role === 'assistant') head = `[assistant${at}] ${text}`
      else if (isUserTyped(m)) {
        head = `[user ${rowRef(i + refOffset)}${at}] ${text}`
        sources.push([rowRef(i + refOffset), { kind: 'user', text, ...(full ? { full } : {}) }])
      } else head = `[harness${at}] ${text}`
    }
    const parts = [head]
    for (const u of m.toolUses) parts.push(`  -> ${u.tool} ${clip(JSON.stringify(u.input ?? {}), INPUT_CLIP)}`)
    for (const r of m.toolResults ?? []) {
      const { text, full } = clippedSource(r.text, RESULT_CLIP)
      parts.push(`  <- [${r.tool_use_id}] ${r.isError ? 'error ' : ''}${text}`)
      sources.push([r.tool_use_id, { kind: 'tool_result', text, ...(full ? { full } : {}), tool: toolOf.get(r.tool_use_id), isError: r.isError }])
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
  if (!source) return `ref ${e.ref} is not a citable row of the folded range`
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

export const isDoneClaim = (o: Payload) => (o.op === 'create' || o.op === 'status') && o.status === 'done'

/** A done claim that lost its evidence leaves its issue where it was: a status move is withheld and a create lands as todo, while `confirmQuestion` asks the user. */
export const withhold = (o: Payload): Payload[] => (o.op === 'status' ? [] : o.op === 'create' ? [{ ...o, status: 'todo' }] : [o])

export const CONFIRM_PREFIX = '이 항목들이 끝났는지 확인: '
const CONFIRM_SEP = ' · '

// The fold only observes the transcript, so a done it inferred but could not
// prove goes to the user as one question per fold, extended rather than
// duplicated while it stays open; the user's answer then lands the dones
// through a later fold's user-quoted ops.
export function confirmQuestion(claimed: readonly Payload[], landed: readonly Payload[], issues: readonly Issue[], doneTitles: ReadonlySet<string>): Payload[] {
  type Item = { id?: string; title: string }
  const statusAfter = new Map(issues.map(issue => [issue.id, issue.status]))
  for (const o of landed) if (o.op === 'status') statusAfter.set(o.issue, o.status)
  const closed = (status: string | undefined) => status === 'done' || status === 'dropped'
  const finishedTitles = new Set([
    ...doneTitles,
    ...landed.flatMap(o => o.op === 'create' && o.status === 'done' ? [o.title.trim()] : []),
    ...issues.filter(issue => closed(statusAfter.get(issue.id))).map(issue => issue.title.trim()),
  ])
  const stillOpen = (item: Item) => !finishedTitles.has(item.title) && !(item.id !== undefined && closed(statusAfter.get(item.id)))
  const title = (id: string) => issues.find(issue => issue.id === id)?.title.trim() ?? ''
  // A done on a dropped or finished issue is a re-open the user's own words decide, not a completion to confirm.
  const asksAbout = (o: Payload) => o.op !== 'status' || issues.some(issue => issue.id === o.issue && !closed(issue.status))
  const claims = claimed.filter(o => isDoneClaim(o) && asksAbout(o))
    .map((o): Item => o.op === 'status' ? { id: o.issue, title: title(o.issue) } : { title: o.op === 'create' ? o.title.trim() : '' })
    .filter(stillOpen)
  const open = issues.find(issue => issue.status === 'question' && issue.title.startsWith(CONFIRM_PREFIX) && statusAfter.get(issue.id) === 'question')
  const asked = (open?.title.slice(CONFIRM_PREFIX.length).split(CONFIRM_SEP) ?? []).flatMap((text): Item[] => {
    const match = /^(?:(\S+) )?"(.*)"$/.exec(text)
    return match ? [{ ...(match[1] ? { id: match[1] } : {}), title: match[2] ?? '' }] : []
  })
  const items: Item[] = []
  for (const item of [...asked.filter(stillOpen), ...claims]) if (!items.some(seen => seen.title === item.title)) items.push(item)
  const text = (item: Item) => `${item.id ? `${item.id} ` : ''}"${item.title}"`
  let body = items.map(text).join(CONFIRM_SEP)
  if (CONFIRM_PREFIX.length + body.length > 200) body = `${body.slice(0, 200 - CONFIRM_PREFIX.length)}…`
  if (!open) return items.length ? [{ op: 'create', title: CONFIRM_PREFIX + body, status: 'question', note: '사용자 확인 대기' }] : []
  if (!items.length) return [{ op: 'status', issue: open.id, status: 'done' }]
  return CONFIRM_PREFIX + body === open.title ? [] : [{ op: 'retitle', issue: open.id, title: CONFIRM_PREFIX + body }]
}

/** Appends the first held quote to a done create's note, so 한 일 shows what proved it. */
export function citeNote(o: Payload, held: readonly Evidence[]): Payload {
  const first = held[0]
  if (o.op !== 'create' || !first) return o
  const cite = `quote: ${JSON.stringify(clip(squash(first.quote), 120))}`
  return { ...o, note: o.note ? `${o.note} (${cite})` : cite }
}

export const isDropClaim = (o: Payload) => o.op === 'status' && o.status === 'dropped'

/**
 * Applies the mechanical check to tracker ops: a done claim with no held
 * evidence is withheld for the user's confirmation, and a drop with no held quote from the user is
 * discarded, since only the user can abandon a direction. Returns the ops (aligned with `evidence` by index,
 * now holding only the held items) and one line per rejection.
 */
/** A move of an issue in `dropped` (the ids now dropped) to any other status: only the user resuming that direction re-opens it. */
export const isReopenClaim = (o: Payload, dropped: ReadonlySet<string>) => o.op === 'status' && o.status !== 'dropped' && dropped.has(o.issue)

// A drop or a re-open turns on the user's direction, so each needs a quote of
// a user row and is discarded without one; a stale tool row from before the
// pivot proves neither.
export function gateOps(ops: readonly Payload[], evidence: readonly Evidence[][], sources: Sources, dropped: ReadonlySet<string> = new Set()): { ops: Payload[]; evidence: Evidence[][]; rejections: string[] } {
  const out: Payload[] = [], kept: Evidence[][] = [], rejections: string[] = []
  ops.forEach((o, i) => {
    const reopen = isReopenClaim(o, dropped)
    if (reopen || isDropClaim(o)) {
      const { held, problems } = checkEvidence(evidence[i] ?? [], sources, ['user'])
      if (held.length) {
        out.push(o)
        kept.push(held)
      } else rejections.push(`${describeOp(o)}: ${reopen ? 're-open' : 'drop'} discarded (${problems.join('; ') || 'no evidence'})`)
      return
    }
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
    rejections.push(`${describeOp(o)}: done held for the user's confirmation (${problems.join('; ') || 'no evidence'})`)
    for (const op of withhold(o)) {
      out.push(op)
      kept.push([])
    }
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
    case 'parent': return `issue ${o.issue} gets parent ${o.parent ?? '(none)'}`
    case 'focus': return `focus -> [${o.stack.join(', ')}] (${o.intent})`
  }
}
