import { isOpen, isRecord, type Issue, type TrackerEvent } from './tracker'
import {
  EMPTY_LEDGER, constraintFactLines, instructionKey, instructionValues, learnedFactLines, notesOf, withdrawnInstructionKeys,
  WITHDRAWN_PREFIX, type Topic,
} from './ledger'
import { stripReminders } from './fold'

export type InstructionIndex = { address: string; issue: string | null; text: string }
export type ResidentLedgerRequest = {
  id: string
  text: string
  quote: string
  status: 'open' | 'answered' | 'declined' | 'skipped'
}
export type ResidentLedgerSections = {
  where?: readonly string[]
  children?: readonly Issue[]
  requests?: readonly ResidentLedgerRequest[]
  constraints?: readonly string[]
  uncertain?: readonly Issue[]
  learned?: readonly string[]
}

export type ResidentIo = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  addressRows: (key: string) => Promise<{ address: string; text: string }[]>
  readLedger: () => Promise<string | undefined>
  readMeta: () => Promise<{ seq: number }>
  storedTopics: (notes: string, seq: number, key: string) => Promise<Topic[]>
  readRequests: (key: string) => Promise<ResidentLedgerRequest[]>
}

type LedgerPreview = { notes?: string; topics?: Topic[]; issues?: Issue[]; state?: { stack: string[]; pending: string[] } }
export const instructionIndexKey = (key: string) => `instruction-index:${key}`
export const issueAddressKey = (key: string) => `issue-addresses:${key}`
export function isInstructionIndex(value: unknown): value is InstructionIndex {
  return isRecord(value) && typeof value.address === 'string' && (/^@[\da-f]{8}$/i.test(value.address) || value.address === '@unknown')
    && (typeof value.issue === 'string' || value.issue === null) && typeof value.text === 'string'
}

export async function ensureInstructionIndex(io: ResidentIo, key: string, notes: string): Promise<void> {
  const raw = await io.get(instructionIndexKey(key))
  const index = Array.isArray(raw) ? raw.filter(isInstructionIndex) : []
  const indexed = new Set(index.map(item => instructionKey(item.text)))
  const rows = await io.addressRows(key)
  let changed = false
  for (const text of instructionValues(notes)) {
    if (text.startsWith(WITHDRAWN_PREFIX)) continue
    const normalized = instructionKey(text)
    if (!normalized || indexed.has(normalized)) continue
    const source = [...rows].reverse().find(row => instructionKey(stripReminders(row.text)) === normalized)
    index.push({ address: source?.address ?? '@unknown', issue: null, text })
    indexed.add(normalized)
    changed = true
  }
  if (changed) await io.set(instructionIndexKey(key), index)
}

export async function residentLedger(
  io: ResidentIo, key: string, issues: readonly Issue[], state: { stack: string[]; pending: string[] }, events: readonly TrackerEvent[], preview: LedgerPreview = {},
): Promise<string> {
  const rawIndex = await io.get(instructionIndexKey(key))
  const index = Array.isArray(rawIndex) ? rawIndex.filter(isInstructionIndex) : []
  const rows = await io.addressRows(key)
  const seen = new Set(index.map(item => `${item.address}\0${item.issue}`))
  for (const event of events) {
    const rule = event.op === 'focus' ? event.rule?.trim() : undefined
    if (event.op !== 'focus' || event.issue !== event.origin.session || !rule) continue
    const source = [...rows].reverse().find(row => instructionKey(row.text).includes(instructionKey(rule)))
    if (!source) continue
    const { address } = source
    if (!seen.has(`${address}\0null`)) index.push({ address, issue: null, text: source.text })
  }
  const shownIssues = preview.issues ?? [...issues]
  const shownState = preview.state ?? state
  const addressesRaw = await io.get(issueAddressKey(key))
  const addresses = isRecord(addressesRaw) ? addressesRaw : {}
  const byId = new Map(shownIssues.map(issue => [issue.id, issue]))
  const topId = shownState.stack.at(-1)
  const top = topId ? byId.get(topId) : undefined
  const ancestors = new Set<string>()
  let current = top
  while (current && !ancestors.has(current.id)) {
    ancestors.add(current.id)
    current = current.parent ? byId.get(current.parent) : undefined
  }
  if (index.length !== (Array.isArray(rawIndex) ? rawIndex.length : 0)) await io.set(instructionIndexKey(key), index)
  const rawNotes = preview.notes ?? notesOf((await io.readLedger()) ?? EMPTY_LEDGER)
  const meta = await io.readMeta()
  const topics = preview.topics ?? await io.storedTopics(rawNotes, meta.seq, key)
  const scopedTopics = topics
    .map(topic => topic.focusIssue === undefined ? { ...topic, focusIssue: topId ?? null } : topic)
    .filter(topic => (topic.focusIssue ?? null) === (topId ?? null))
  const fallbackGoal = /^## 목표\s*\n([\s\S]*?)(?=\n## |$)/m.exec(rawNotes)?.[1]?.trim() ?? ''
  const where = topics.length
    ? scopedTopics.map(topic => `${topic.topic}: ${topic.summary}`)
    : fallbackGoal && fallbackGoal !== '- (none yet)' ? [fallbackGoal] : []
  const requests = (await io.readRequests(key)).filter(request => request.status === 'open')
  const constraints = constraintFactLines(rawNotes).map(line => line.replace(/^\[constraint\]\s*/, ''))
  const learned = learnedFactLines(rawNotes)
  const sections: ResidentLedgerSections = {
    where,
    children: shownIssues.filter(issue => topId !== undefined && issue.parent === topId && isOpen(issue)),
    requests,
    constraints,
    uncertain: shownIssues.filter(issue => issue.status === 'uncertain'),
    learned,
  }
  const withdrawn = withdrawnInstructionKeys(rawNotes)
  const visibleIndex = index.filter(item => !withdrawn.has(instructionKey(item.text)))
  return residentLedgerText(top, top ? String(addresses[top.id] ?? '') || undefined : undefined, shownState.stack.length, shownState.pending.length, visibleIndex, ancestors, sections)
}

export function residentLedgerText(
  top: Issue | undefined, topAddress: string | undefined, stackSize: number, pendingCount: number,
  instructions: readonly InstructionIndex[], ancestorIds: ReadonlySet<string>, sections: ResidentLedgerSections = {},
): string {
  const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()
  const lastNote = top?.notes.at(-1)
  const focus = top
    ? `- ${oneLine(top.title)}${lastNote ? ` — ${oneLine(lastNote)}` : ''} ${topAddress ?? '@unknown'}`
    : '- (none)'
  const index = instructions.filter(item => item.issue === null || (item.issue !== null && ancestorIds.has(item.issue)))
    .map(item => `- ${[...item.text].slice(0, 80).join('')} ${item.address}`)
  const where = [focus, ...(sections.where ?? []).map(line => `- ${oneLine(line)}`), 'Stack size', String(stackSize), 'Pending count', String(pendingCount)]
  const tasks = (sections.children ?? []).filter(issue => issue.parent === top?.id && isOpen(issue))
    .map(issue => {
      const note = issue.notes.at(-1)
      return `- ${oneLine(issue.title)}${note ? ` — ${oneLine(note)}` : ''} [${issue.id}]`
    })
  const requests = (sections.requests ?? []).filter(request => request.status === 'open')
    .map(request => `- [${request.id}] ${oneLine(request.text)} — quote: ${JSON.stringify(oneLine(request.quote))}`)
  const constraints = [...index, ...(sections.constraints ?? []).map(oneLine)]
  const uncertain = (sections.uncertain ?? []).filter(issue => issue.status === 'uncertain')
    .map(issue => `- ${oneLine(issue.title)} — settling check: ${oneLine(issue.notes.at(-1) ?? 'verify the claim')} [${issue.id}]`)
  const learned = (sections.learned ?? []).map(oneLine)
  const body = (lines: readonly string[]) => lines.length ? lines.join('\n') : '- (none yet)'
  return [
    '## where we are', where.join('\n'),
    '## what to do', body(tasks),
    '## what to request', body(requests),
    '## constraints & preferences', body(constraints),
    '## uncertain', body(uncertain),
    '## learned', body(learned),
  ].join('\n\n')
}
