import type { SessionMessage } from 'claude-code'
import { fingerprint, liveRows, protectedIndex, type Boundary } from './fold'
import { EMPTY_LEDGER, notesOf } from './ledger'
import type { Payload } from './tracker'

export type RewindTopic = { topic: string; summary: string; seq: number; sourceTokens?: number; focusIssue?: string | null }
export type RewindMeta = {
  seq: number; fails: number; lastClear?: string; lastFoldAt?: number; foldDurationsMs?: Record<string, number>
  foldTokens?: number; boundary?: Boundary; lastSkip?: string; ratio?: number; overhead?: number; lastObserved?: number
}
export type RewindPlan = {
  notes: string; fullNotes: string; ops: Payload[]; seq: number; keepFp?: string; keepFrom: number; dropFps: string[]
  cuts: Record<string, number>; keptTurns: number; fallback: boolean; summaryMs?: number; topics?: RewindTopic[]
  rewindOnly?: boolean; coveredRows?: string[]
}

export type LedgerSnapshot = {
  seq: number; ledgerFp: string; coveredRows: string[]; ledger: string; topics?: RewindTopic[]; instructions?: unknown; addresses?: unknown
}
export type RewindIo = {
  storeGet(key: string): Promise<unknown>
  storeSet(key: string, value: unknown): Promise<void>
  storeDelete(key: string): Promise<void>
  writeFile(path: string, text: string): Promise<void>
  ledgerPath(): Promise<string>
  topicsKey(key: string): Promise<string>
  pendingKey(key: string): Promise<string>
  readMeta(): Promise<RewindMeta>
  writeMeta(meta: RewindMeta): Promise<void>
  readyFoldDropFps(key: string): string[] | undefined
  clearReadyFold(key: string): Promise<void>
  setRewindReady(key: string, plan: RewindPlan, fingerprints: string[]): void
  logEvent(fields: { reason: string }): Promise<void>
  log(text: string): void
}

const ledgerSnapshotsKey = (key: string) => `ledger-snapshots:${key}`
const transcriptRowsKey = (key: string) => `transcript-rows:${key}`
const instructionIndexKey = (key: string) => `instruction-index:${key}`
const issueAddressKey = (key: string) => `issue-addresses:${key}`
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function isTopic(value: unknown): value is RewindTopic {
  return isRecord(value) && typeof value.topic === 'string' && value.topic.trim() !== ''
    && typeof value.summary === 'string' && value.summary.trim() !== '' && typeof value.seq === 'number' && Number.isInteger(value.seq) && value.seq > 0
    && (value.sourceTokens === undefined || (typeof value.sourceTokens === 'number' && Number.isInteger(value.sourceTokens) && value.sourceTokens >= 0))
    && (value.focusIssue === undefined || value.focusIssue === null || typeof value.focusIssue === 'string')
}

function isTopicList(value: unknown): value is RewindTopic[] {
  return Array.isArray(value) && value.every(isTopic)
    && new Set(value.map(topic => `${topic.topic.replace(/\s+/g, ' ').trim()}\0${topic.focusIssue ?? ''}`)).size === value.length
}

function isLedgerSnapshot(value: unknown): value is LedgerSnapshot {
  return isRecord(value) && typeof value.seq === 'number' && Number.isInteger(value.seq)
    && typeof value.ledgerFp === 'string' && Array.isArray(value.coveredRows) && value.coveredRows.every(ref => typeof ref === 'string')
    && typeof value.ledger === 'string' && (value.topics === undefined || isTopicList(value.topics))
}

export async function readLedgerSnapshots(io: RewindIo, key: string): Promise<LedgerSnapshot[]> {
  const stored = await io.storeGet(ledgerSnapshotsKey(key))
  return Array.isArray(stored) ? stored.filter(isLedgerSnapshot).slice(-32) : []
}

export async function saveLedgerSnapshot(
  io: RewindIo, key: string, seq: number, ledgerFp: string, ledger: string, topics: RewindTopic[] | undefined, coveredRows: readonly string[],
): Promise<void> {
  const history = await readLedgerSnapshots(io, key)
  const instructions = await io.storeGet(instructionIndexKey(key))
  const addresses = await io.storeGet(issueAddressKey(key))
  const next: LedgerSnapshot = {
    seq, ledgerFp, ledger, coveredRows: [...new Set(coveredRows)],
    ...(topics ? { topics } : {}),
    ...(instructions === undefined ? {} : { instructions }),
    ...(addresses === undefined ? {} : { addresses }),
  }
  await io.storeSet(ledgerSnapshotsKey(key), [...history, next].slice(-32))
}

async function restoreLedgerSnapshot(io: RewindIo, key: string, snapshot: LedgerSnapshot | undefined): Promise<void> {
  await io.writeFile(await io.ledgerPath(), `${(snapshot?.ledger ?? EMPTY_LEDGER).trimEnd()}\n`)
  if (snapshot?.topics) await io.storeSet(await io.topicsKey(key), snapshot.topics)
  else await io.storeDelete(await io.topicsKey(key))
  if (snapshot?.instructions === undefined) await io.storeDelete(instructionIndexKey(key))
  else await io.storeSet(instructionIndexKey(key), snapshot.instructions)
  if (snapshot?.addresses === undefined) await io.storeDelete(issueAddressKey(key))
  else await io.storeSet(issueAddressKey(key), snapshot.addresses)
}

function removedRows(previous: readonly string[], current: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const ref of current) counts.set(ref, (counts.get(ref) ?? 0) + 1)
  const removed: string[] = []
  for (const ref of previous) {
    const count = counts.get(ref) ?? 0
    if (count === 0) removed.push(ref)
    else counts.set(ref, count - 1)
  }
  return removed
}

export async function rewindOnlyPlan(
  rows: readonly SessionMessage[], snapshot: LedgerSnapshot | undefined,
): Promise<RewindPlan> {
  const first = protectedIndex(rows)
  const ledger = snapshot?.ledger ?? EMPTY_LEDGER
  const keptRow = rows[first + 1]
  return {
    notes: notesOf(ledger), fullNotes: notesOf(ledger), ops: [], seq: snapshot?.seq ?? 0,
    ...(keptRow ? { keepFp: fingerprint(keptRow) } : {}), keepFrom: first + 1, dropFps: [],
    cuts: {}, keptTurns: 0, fallback: false, rewindOnly: true,
    ...(snapshot?.topics ? { topics: snapshot.topics } : {}),
    coveredRows: snapshot?.coveredRows ?? [],
  }
}

export async function observeTranscript(io: RewindIo, key: string, all: readonly SessionMessage[]): Promise<void> {
  const meta = await io.readMeta()
  const rows = liveRows(all, meta.boundary)
  const current = rows.map(fingerprint)
  const stored = await io.storeGet(transcriptRowsKey(key))
  await io.storeSet(transcriptRowsKey(key), current)
  if (!Array.isArray(stored) || !stored.every(ref => typeof ref === 'string')) return
  const removed = removedRows(stored, current)
  if (!removed.length) return

  const removedSet = new Set(removed)
  const history = await readLedgerSnapshots(io, key)
  const latest = history.at(-1)
  const ledgerWasRemoved = latest !== undefined && removedSet.has(latest.ledgerFp)
  const restored = ledgerWasRemoved ? history.at(-2) : undefined
  const readyDropFps = io.readyFoldDropFps(key)
  const invalidated = readyDropFps?.some(ref => removedSet.has(ref)) ?? false
  if (invalidated) {
    await io.clearReadyFold(key)
    io.log('clm: rewound rows overlapped the pending summary; discarded its plan')
  }
  if (!ledgerWasRemoved) return

  if (restored) {
    const restoredIndex = history.indexOf(restored)
    await io.storeSet(ledgerSnapshotsKey(key), history.slice(0, restoredIndex + 1))
  } else {
    await io.storeDelete(ledgerSnapshotsKey(key))
  }
  await restoreLedgerSnapshot(io, key, restored)
  const plan = await rewindOnlyPlan(rows, restored)
  io.setRewindReady(key, plan, current)
  await io.storeSet(await io.pendingKey(key), plan)
  await io.writeMeta({ ...meta, seq: plan.seq })
  await io.logEvent({ reason: `restored ledger snapshot ${plan.seq} after ${removed.length} row(s) left the active transcript` })
  io.log(`clm: restored ledger snapshot ${plan.seq} after rewind (${removed.length} row(s))`)
}
