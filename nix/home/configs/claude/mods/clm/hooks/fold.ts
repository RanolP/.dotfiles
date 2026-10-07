import type { SessionMessage } from 'claude-code'

const LEDGER_ROW = /^\[clm ledger #(\d+) · [^\]]+\] Earlier turns of this session were folded into these notes by the harness/
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
}
const isBare = (m: SessionMessage) => m.toolUses.length === 0 && (m.toolResults ?? []).length === 0
const isEmptyRow = (m: SessionMessage) => isBare(m) && (m.text.trim() === '' || (m.role === 'assistant' && m.text.trim() === '(no content)'))
export const isSystemRow = (m: SessionMessage): boolean => {
  if (!isBare(m)) return false
  if (m.role === 'assistant') return isEmptyRow(m)
  return SYSTEM_ROW.taskNotification.test(m.text) || SYSTEM_ROW.remindersOnly.test(m.text)
}
export const ledgerRowSeq = (text: string): string | undefined => LEDGER_ROW.exec(text)?.[1]
export const isLedgerRow = (m: SessionMessage) => m.role === 'user' && ledgerRowSeq(m.text) !== undefined
export const isPrompt = (m: SessionMessage) =>
  m.role === 'user' && m.text.trim() !== '' && (m.toolResults ?? []).length === 0 && !isSystemRow(m) && !isLedgerRow(m)

export const protectedIndex = (msgs: readonly SessionMessage[]): number => {
  const i = msgs.findIndex(isPrompt)
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
  return [...plan.head, ledgerRow, ...plan.tail].filter(m => !isEmptyRow(m)).map(m => strip(applyCuts(m, plan.cuts)))
}

export const ledgerRowText = (seq: number, at: string, path: string, ledger: string) =>
  `[clm ledger #${seq} · ${at}] Earlier turns of this session were folded into these notes by the harness (file: ${path}). They are your memory of that work.\n\n${ledger}`
