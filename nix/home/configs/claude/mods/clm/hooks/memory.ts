import type { SessionMessage } from 'claude-code'

import type { AddressRow } from './address'

// Model-held memory across a fold: notes the model records with clm_note, the
// folded rows clm archives beside the ledger, and the search clm_recall runs
// over both.

// --- clm_note ----------------------------------------------------------------

export const NOTE_KEEP = 12
export const NOTE_CHARS = 200
export const NOTE_TOOL = 'clm_note'
export const noteStoreKey = (key: string) => `model-notes:${key}`
export const NOTE_DESCRIPTION = [
  'Record one fact, path or decision that must survive when clm folds older turns.',
  `Each note is one line of at most ${NOTE_CHARS} characters, kept verbatim in the ledger's facts section after every fold.`,
  `clm keeps the newest ${NOTE_KEEP} notes; recording a thirteenth evicts the oldest, and recording an existing note again moves it to newest.`,
].join(' ')

export const readNotes = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string' && value.trim() !== '') : []

/** Adds one note, newest last; returns the kept notes and the ones evicted to stay within NOTE_KEEP. */
export function addNote(notes: readonly string[], text: unknown): { notes: string[]; evicted: string[] } | { error: string } {
  if (typeof text !== 'string') return { error: 'clm_note requires text: one line to keep.' }
  const line = text.replace(/\s+/g, ' ').trim()
  if (!line) return { error: 'clm_note requires non-empty text.' }
  if ([...line].length > NOTE_CHARS) return { error: `a note holds at most ${NOTE_CHARS} characters; this one has ${[...line].length}. Split it or shorten it.` }
  const next = [...notes.filter(note => note !== line), line]
  const cut = Math.max(0, next.length - NOTE_KEEP)
  return { notes: next.slice(cut), evicted: next.slice(0, cut) }
}

export const NOTE_PREFIX = '[note] '
export const noteLine = (note: string) => `- ${NOTE_PREFIX}${note}`

// --- archive of folded rows ----------------------------------------------------

/** The archive keeps its newest ARCHIVE_CHARS; one row contributes at most ROW_CHARS. */
export const ARCHIVE_CHARS = 2_000_000
export const ROW_CHARS = 8_000
export const archivePath = (base: string) => `${base}.archive.txt`
const BLOCK = '=== @fold:'

// The archive holds what the transcript already holds; these patterns keep the
// common credential shapes from being copied a second time into a searchable file.
const SECRETS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bgithub[_]pat_[A-Za-z0-9_]{20,}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
  /((?:^|[^A-Za-z0-9])(?:x-api-key|authorization)\s*:\s*(?:(?:Bearer|Basic|Token)\s+)?)[^\s"',;]{8,}/gim,
  // An env-style NAME_ prefix (CLOUDFLARE_API_TOKEN=) defeats \b, since _ is a word char; the lead keeps it out of the middle of a word.
  /((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+_)*(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?key|token|secret|password|passwd)\\?["']?\s*[:=]\s*\\?["']?)[^\s"',;]{8,}/gim,
  // camelCase names (accessToken, clientSecret); case-sensitive so monkey or keyed stay untouched.
  /((?:^|[^A-Za-z0-9])[a-z][A-Za-z0-9]*(?:Token|Secret|Password|Key)\\?["']?\s*[:=]\s*\\?["']?)[^\s"',;]{8,}/gm,
]
export const redact = (text: string) =>
  SECRETS.reduce((out, pattern) => out.replace(pattern, (match, lead) => `${typeof lead === 'string' && match.startsWith(lead) ? lead : ''}[redacted]`), text)

const rowBody = (row: SessionMessage) => [
  row.text,
  ...row.toolUses.map(use => `-> ${use.tool} ${JSON.stringify(use.input ?? {})}`),
  ...(row.toolResults ?? []).map(result => `<- [${result.tool_use_id}] ${result.isError ? 'error ' : ''}${result.text}`),
].filter(Boolean).join('\n')

/** One block per folded row, every role, addressed @fold:<seq>.<n>. */
export function archiveBlocks(seq: number, rows: readonly SessionMessage[]): string {
  return rows.map((row, index) => {
    const body = redact(rowBody(row)).replace(/^=== @fold:/gm, ' === @fold:')
    const clipped = body.length > ROW_CHARS ? `${body.slice(0, ROW_CHARS)}… [+${body.length - ROW_CHARS} chars]` : body
    return `${BLOCK}${seq}.${index} [${row.role}]\n${clipped}\n`
  }).join('')
}

/** previous + added, cut from the front at a block boundary to stay within cap. */
export function appendArchive(previous: string, added: string, cap = ARCHIVE_CHARS): string {
  const joined = previous + added
  if (joined.length <= cap) return joined
  const start = joined.indexOf(`\n${BLOCK}`, joined.length - cap - 1)
  return start < 0 ? '' : joined.slice(start + 1)
}

export type ArchiveBlock = { address: string; role: string; body: string }
export function parseArchive(text: string): ArchiveBlock[] {
  return text.split(/^(?==== @fold:)/m).flatMap(part => {
    const match = /^=== (@fold:\d+\.\d+) \[(\w+)\]\n([\s\S]*)$/.exec(part)
    return match ? [{ address: match[1]!, role: match[2]!, body: match[3]!.replace(/\n$/, '') }] : []
  })
}

// --- clm_recall {query} ----------------------------------------------------------

export const RECALL_HITS = 12
const SNIPPET = 160

const snippet = (body: string, at: number) => {
  const start = Math.max(0, at - SNIPPET / 2)
  const text = body.slice(start, start + SNIPPET).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${text}${start + SNIPPET < body.length ? '…' : ''}`
}

/**
 * Newest-first matches of every query word (case-insensitive) across the
 * archive and the user prompts clm addressed; each hit names the address
 * clm_recall reads in full.
 */
export function searchMemory(query: string, archive: readonly ArchiveBlock[], prompts: readonly AddressRow[], limit = RECALL_HITS): string[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const candidates = [
    ...prompts.map(row => ({ address: row.address, role: 'user', body: row.text })),
    ...archive,
  ]
  const hits: string[] = []
  for (const block of candidates.reverse()) {
    const lower = block.body.toLowerCase()
    if (!words.every(word => lower.includes(word))) continue
    hits.push(`${block.address} [${block.role}] ${snippet(block.body, lower.indexOf(words[0]!))}`)
    if (hits.length >= limit) break
  }
  return hits
}

// --- pre-fold wrap-up notice ------------------------------------------------------

export const wrapUpStoreKey = (key: string) => `wrap-up-notice:${key}`
export const WRAP_UP_NOTICE = [
  '[clm] This conversation is close to its fold point: clm will soon fold the older turns into the ledger row, and their raw text leaves your context.',
  'Record each fact, path or decision you still need with clm_note now, one line per note. Folded turns stay searchable with clm_recall {query}.',
].join(' ')

/** The notice fires inside the last tenth (at least 2000 tokens) before the fold point, once per ledger seq. */
export function wrapUpDue(input: {
  used: number | undefined; budget: number; reserve: number; jobIdle: boolean; compactionDisabled?: boolean; seq: number; noticedSeq: unknown
}): boolean {
  const { used, budget, reserve } = input
  if (used === undefined || !input.jobIdle || input.compactionDisabled || input.noticedSeq === input.seq) return false
  const foldAt = budget - reserve
  const margin = Math.max(2000, Math.floor(foldAt / 10))
  return used >= foldAt - margin && used < foldAt
}
