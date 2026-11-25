import type { SessionMessage } from 'claude-code'

import { fingerprint, stripReminders } from './fold'
import { isRecord } from './tracker'

// clm builds its own address index from the hooks it receives and never reads
// the transcript file: the engine refuses large reads, and a long session is
// exactly the one whose instructions need addresses. A session indexed only
// from some point on resolves older rows to @unknown.

/** A human prompt as clm saw it at prompt.submit, with the address clm coined for it. */
export type AddressRow = { address: string; text: string; at: string; promptSeq?: number }
/** First-seen time of a message fingerprint; `at` is null once two sends share it. */
type Stamp = { at: string | null; n: number }
type AddressIndex = { rows: AddressRow[]; stamps: Record<string, Stamp> }

const MAX_ROWS = 1000
const MAX_STAMPS = 4000

export type AddressIo = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
}

const addressIndexKey = (key: string) => `address-index:${key}`
const isRow = (value: unknown): value is AddressRow =>
  isRecord(value) && typeof value.address === 'string' && typeof value.text === 'string' && typeof value.at === 'string'
const isStamp = (value: unknown): value is Stamp =>
  isRecord(value) && (typeof value.at === 'string' || value.at === null) && typeof value.n === 'number'

async function readIndex(io: AddressIo, key: string): Promise<AddressIndex> {
  const raw = await io.get(addressIndexKey(key))
  if (!isRecord(raw)) return { rows: [], stamps: {} }
  const rows = Array.isArray(raw.rows) ? raw.rows.filter(isRow) : []
  const stamps = isRecord(raw.stamps) ? Object.fromEntries(Object.entries(raw.stamps).filter(([, stamp]) => isStamp(stamp))) as Record<string, Stamp> : {}
  return { rows, stamps }
}

export function fnv1a(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0
  return h
}
// FNV-1a, so an address is stable for its input and needs no randomness.
const coin = (seed: string): string => `@${fnv1a(seed).toString(16).padStart(8, '0')}`

export async function addressRows(io: AddressIo, key: string): Promise<AddressRow[]> {
  return (await readIndex(io, key)).rows
}

/** Records a human prompt and returns the address coined for it. */
export async function recordPrompt(io: AddressIo, key: string, text: string, at: string, promptSeq?: number): Promise<string> {
  const index = await readIndex(io, key)
  const taken = new Set(index.rows.map(row => row.address))
  let address = coin(`${key}\0${index.rows.length}\0${at}\0${text}`)
  for (let salt = 1; taken.has(address); salt++) address = coin(`${key}\0${index.rows.length}\0${at}\0${text}\0${salt}`)
  await io.set(addressIndexKey(key), { ...index, rows: [...index.rows, { address, text, at, ...(promptSeq === undefined ? {} : { promptSeq }) }].slice(-MAX_ROWS) })
  return address
}

/** Stamps every message not seen before with `at`, the time this hook observed it. */
export async function stampMessages(io: AddressIo, key: string, messages: readonly SessionMessage[], at: string): Promise<void> {
  const index = await readIndex(io, key)
  const counts = new Map<string, number>()
  for (const m of messages) { const fp = fingerprint(m); counts.set(fp, (counts.get(fp) ?? 0) + 1) }
  let changed = false
  const stamps = { ...index.stamps }
  for (const [fp, n] of counts) {
    const stamp = stamps[fp]
    if (!stamp) stamps[fp] = { at, n }
    else if (n > stamp.n) stamps[fp] = { at: null, n }
    else continue
    changed = true
  }
  if (changed) await io.set(addressIndexKey(key), { ...index, stamps: Object.fromEntries(Object.entries(stamps).slice(-MAX_STAMPS)) })
}

/** When a message was sent, as an ISO time, or undefined when unknown. */
export type SentAt = (m: SessionMessage) => string | undefined

/**
 * A typed prompt takes its prompt.submit time; any other row takes the time a
 * hook first saw its fingerprint. Text sent at two different times is
 * ambiguous and stays unstamped.
 */
export async function sentAtOf(io: AddressIo, key: string): Promise<SentAt> {
  const { rows, stamps } = await readIndex(io, key)
  const byText = new Map<string, string | undefined>()
  for (const row of rows) {
    const text = stripReminders(row.text)
    byText.set(text, byText.has(text) && byText.get(text) !== row.at ? undefined : row.at)
  }
  return m => {
    const text = m.role === 'user' && m.text ? stripReminders(m.text) : undefined
    if (text !== undefined && byText.has(text)) return byText.get(text)
    return stamps[fingerprint(m)]?.at ?? undefined
  }
}

