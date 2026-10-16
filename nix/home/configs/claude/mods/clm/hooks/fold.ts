import type { SessionMessage } from 'claude-code'

// Matches the header of rows written before the Haiku-summary wording too, and
// both header times: the KST stamp below and the UTC ISO time older rows carry.
const LEDGER_ROW = /^\[clm ledger #(\d+) · [^\]]+\]/
const RESULT_FLOOR = 1024 // tokens each older kept tool result may shrink to, at least

// --- rows ----------------------------------------------------------------

export const estTokens = (m: SessionMessage): number => {
  let chars = m.text.length
  for (const u of m.toolUses) chars += JSON.stringify(u.input ?? {}).length + u.tool.length
  for (const r of m.toolResults ?? []) chars += r.text.length
  return Math.ceil(chars / 4)
}
export const sum = (rows: readonly SessionMessage[]) => rows.reduce((n, m) => n + estTokens(m), 0)

export const fingerprint = (m: SessionMessage): string =>
  [m.role, m.toolUses.map(u => u.tool_use_id).join(','), (m.toolResults ?? []).map(r => r.tool_use_id).join(','), m.text.slice(0, 160)].join('|')

// Rows the engine injects rather than the conversation. SessionMessage has no
// origin flag, so match text. "(no content)" is how the engine rebuilds an
// empty assistant row after a compaction.
const SYSTEM_ROW = {
  taskNotification: /^\s*<task-notification>/,
  remindersOnly: /^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/,
  // A session opened by /clear starts with that command's row; kept as the
  // first request, every fold re-drew it above the ledger.
  localCommand: /^\s*(?:<command-name>\/(?:clear|compact)<\/command-name>|<local-command-(?:stdout|stderr|caveat)>)/,
}
const isBare = (m: SessionMessage) => m.toolUses.length === 0 && (m.toolResults ?? []).length === 0
const isLocalCommand = (m: SessionMessage) => isBare(m) && m.role === 'user' && SYSTEM_ROW.localCommand.test(m.text)
const isEmptyRow = (m: SessionMessage) => isBare(m) && (m.text.trim() === '' || (m.role === 'assistant' && m.text.trim() === '(no content)'))
export const isSystemRow = (m: SessionMessage): boolean => {
  if (!isBare(m)) return false
  if (m.role === 'assistant') return isEmptyRow(m)
  return SYSTEM_ROW.taskNotification.test(m.text) || SYSTEM_ROW.remindersOnly.test(m.text) || isLocalCommand(m)
}
/** A user-facing time on the Asia/Seoul clock, `2026-10-13 18:04 KST`; Korea keeps no DST, so +9h is exact. */
export const kst = (t: number | string | Date = new Date()): string => {
  const ms = new Date(t).getTime()
  return Number.isNaN(ms) ? String(t) : `${new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} KST`
}
export const ledgerRowSeq = (text: string): string | undefined => LEDGER_ROW.exec(text)?.[1]
export const isLedgerRow = (m: SessionMessage) => m.role === 'user' && ledgerRowSeq(m.text) !== undefined
export const isPrompt = (m: SessionMessage) =>
  m.role === 'user' && m.text.trim() !== '' && (m.toolResults ?? []).length === 0 && !isSystemRow(m) && !isLedgerRow(m)

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
export const stripReminders = (text: string) => text.replace(REMINDER, '').trim()
// User-role rows the harness writes into the conversation: a subagent's
// hand-back and a loaded skill's body. They still open a turn (isPrompt), so
// a session driven by hand-backs keeps its fold boundaries, but they are not
// the user speaking, so they are neither citable as the user nor instructions.
const HARNESS_TEXT = /^(?:Another Claude session sent a message:|Base directory for this skill: )/
export const isHarnessText = (text: string) => HARNESS_TEXT.test(text)
/** A prompt the user wrote: what may be quoted as the user and kept under 사용자 지시. */
export const isUserTyped = (m: SessionMessage) => isPrompt(m) && !isHarnessText(stripReminders(m.text))

// A ledger row ahead of every prompt means the first request was already
// folded away; the ledger then marks the head, and buildCleared replaces it.
export const protectedIndex = (msgs: readonly SessionMessage[]): number => {
  const i = msgs.findIndex(m => isPrompt(m) || isLedgerRow(m))
  return i < 0 ? 0 : i
}
export const visibleTokens = (msgs: readonly SessionMessage[]) => msgs.reduce((n, m) => n + (isSystemRow(m) ? 0 : estTokens(m)), 0)

// `$.session.messages()` returns the stored transcript, older chains before a
// compact boundary included, and no API option scopes it. So each fold records
// the ledger row it wrote (unique: it carries a sequence number and a time) and
// its offset; the live rows start that far before its last occurrence.
export type Boundary = { fp: string; offset: number }
export function liveRows(msgs: readonly SessionMessage[], b: Boundary | undefined): readonly SessionMessage[] {
  if (!b) return msgs
  for (let j = msgs.length - 1; j >= 0; j--) if (fingerprint(msgs[j]!) === b.fp) return msgs.slice(Math.max(0, j - b.offset))
  return msgs
}

// Rebuilt WITHOUT the handle: a handled row keeps its old parent and message id,
// and on --resume the loader pulls the pre-fold chain back in.
const strip = (m: SessionMessage): SessionMessage =>
  ({ role: m.role, text: m.text, toolUses: m.toolUses, ...(m.toolResults ? { toolResults: m.toolResults } : {}) })

// --- planning a fold -----------------------------------------------------

export type ClearPlan = {
  head: readonly SessionMessage[]
  dropped: readonly SessionMessage[]
  tail: readonly SessionMessage[]
  keptTurns: number
  /** tool_use_id -> token share its result is cut to */
  cuts: Record<string, number>
}

const sumAfterCuts = (rows: readonly SessionMessage[], cuts: Record<string, number>): number => rows.reduce((n, m) => {
  const raw = (m.toolResults ?? []).reduce((total, r) => total + Math.ceil(r.text.length / 4), 0)
  const clipped = (m.toolResults ?? []).reduce((total, r) => total + Math.min(Math.ceil(r.text.length / 4), cuts[r.tool_use_id] ?? Infinity), 0)
  return n + estTokens(m) - raw + clipped
}, 0)

// Turns open on a real user prompt, so whole turns never split a tool_use
// from its tool_result. The tail is the newest turns that fit `target`
// alongside the head and the ledger after older result trimming, and always
// holds the newest one.
export function planClear(msgs: readonly SessionMessage[], target: number, ledgerTokens: number): ClearPlan | undefined {
  const first = protectedIndex(msgs)
  const starts = msgs.flatMap((m, i) => (i > first && isPrompt(m) ? [i] : []))
  const head = msgs.slice(0, first + 1)
  const fixed = sum(head) + ledgerTokens
  let keepFrom = starts.length ? starts[starts.length - 1]! : first + 1
  let keptTurns = starts.length ? 1 : 0
  for (let t = starts.length - 2; t >= 0; t--) {
    const candidate = msgs.slice(starts[t]!)
    if (fixed + sum(candidate) > target) {
      const candidateCuts = shareResults(candidate, target - fixed, starts[starts.length - 1]! - starts[t]!)
      if (Object.keys(candidateCuts).length === 0 || fixed + sumAfterCuts(candidate, candidateCuts) > target) break
    }
    keepFrom = starts[t]!
    keptTurns++
  }
  const tail = msgs.slice(keepFrom)
  const dropped = msgs.slice(first + 1, keepFrom).filter(m => !isLedgerRow(m) && !isSystemRow(m))
  // The newest turn may still be in progress when compaction is requested;
  // preserve its tool results whole so a live command's output is not lost.
  const newestStart = starts.at(-1)
  const cuttable = newestStart === undefined ? tail.length : Math.max(0, newestStart - keepFrom)
  const cuts = fixed + sum(tail) > target ? shareResults(tail, target - fixed, cuttable) : {}
  if (dropped.length === 0 && Object.keys(cuts).length === 0) return undefined
  return { head, dropped, tail, keptTurns, cuts }
}

// Each tool result in the tail gets an equal slice of the room left after the
// tail's other text; only results bigger than their slice are cut.
function shareResults(tail: readonly SessionMessage[], room: number, cuttableLength = tail.length): Record<string, number> {
  const results = tail.slice(0, cuttableLength).flatMap(m => m.toolResults ?? [])
  if (results.length === 0) return {}
  const other = sum(tail) - results.reduce((n, r) => n + Math.ceil(r.text.length / 4), 0)
  const share = Math.max(RESULT_FLOOR, Math.floor((room - other) / results.length))
  const cuts: Record<string, number> = {}
  for (const r of results) if (Math.ceil(r.text.length / 4) > share) cuts[r.tool_use_id] = share
  return cuts
}

export function cutText(text: string, share: number): string {
  const keep = share * 4
  const headChars = Math.floor(keep * 0.6)
  return `${text.slice(0, headChars)}\n…[clm: ${text.length - keep} of ${text.length} chars cut at fold time]…\n${text.slice(text.length - (keep - headChars))}`
}
const applyCuts = (m: SessionMessage, cuts: Record<string, number>): SessionMessage =>
  !m.toolResults?.some(r => cuts[r.tool_use_id] !== undefined)
    ? m
    : { ...m, toolResults: m.toolResults.map(r => (cuts[r.tool_use_id] === undefined ? r : { ...r, text: cutText(r.text, cuts[r.tool_use_id]!) })) }

export function buildCleared(plan: Pick<ClearPlan, 'head' | 'tail' | 'cuts'>, ledgerRow: SessionMessage): SessionMessage[] {
  return [...plan.head.filter(m => !isLedgerRow(m)), ledgerRow, ...plan.tail].filter(m => !isEmptyRow(m) && !isLocalCommand(m)).map(m => strip(applyCuts(m, plan.cuts)))
}

// clm-prompt
const LEDGER_LINE_LIMIT = 240
const LEDGER_NONE = '- (none yet)'
const LEDGER_MORE = '- …+'
const clipLedgerLine = (line: string) => {
  const chars = [...line.replace(/\s+/g, ' ').trim()]
  return chars.length > LEDGER_LINE_LIMIT ? `${chars.slice(0, LEDGER_LINE_LIMIT - 1).join('')}…` : chars.join('')
}
type LedgerSection = { name: string; lines: string[]; dropped: number }
const ledgerSections = (ledger: string): LedgerSection[] => ledger.split(/\n\n(?=## )/).map(part => {
  const [heading, ...lines] = part.split('\n')
  return { name: heading?.startsWith('## ') ? heading.slice(3) : '', lines: lines.map(clipLedgerLine), dropped: 0 }
})
const renderLedgerSections = (sections: readonly LedgerSection[]) => sections.map(section => {
  const lines = section.lines.filter(line => line !== LEDGER_NONE)
  if (section.name === 'where we are' && section.dropped) {
    const metadata = lines.findIndex(line => line === 'Stack size' || line === 'Pending count')
    const before = metadata < 0 ? lines : lines.slice(0, metadata)
    const after = metadata < 0 ? [] : lines.slice(metadata)
    before.push(`${LEDGER_MORE}${section.dropped} older, see clm_recall`)
    return `## ${section.name}\n${[...before, ...after].join('\n')}`
  }
  if (section.dropped) lines.push(`${LEDGER_MORE}${section.dropped} older, see clm_recall`)
  return `## ${section.name}\n${lines.length ? lines.join('\n') : LEDGER_NONE}`
}).join('\n\n')
const dropOldestLedgerItem = (section: LedgerSection | undefined) => {
  if (!section) return false
  let index = -1
  if (section.name === 'where we are') {
    const metadata = section.lines.findIndex(line => line === 'Stack size' || line === 'Pending count')
    const end = metadata < 0 ? section.lines.length : metadata
    for (let i = 1; i < end; i++) if (section.lines[i] !== LEDGER_NONE) { index = i; break }
  } else index = section.lines.findIndex(line => line !== LEDGER_NONE)
  if (index < 0) return false
  section.lines.splice(index, 1)
  section.dropped++
  return true
}

export const ledgerRowText = (seq: number, at: string, _path: string, ledger: string, maxTokens: number) => {
  const header = `[clm ledger #${seq} · ${at}]\n\n`
  const footer = '\n\nPR, branch, deploy and ticket states may have moved since: re-query one before acting on it.'
  const sections = ledgerSections(ledger)
  const render = () => `${header}${renderLedgerSections(sections)}${footer}`
  const fits = () => Math.ceil(render().length / 4) <= maxTokens
  if (fits()) return render()
  const byName = (name: string) => sections.find(section => section.name === name)
  const trimOrder = ['learned', 'where we are', 'owned resources', 'uncertain', 'what to do', 'what to request', 'constraints & preferences']
  while (!fits()) {
    const trimmed = trimOrder.some(name => dropOldestLedgerItem(byName(name)))
    if (!trimmed) break
  }
  return render()
}
