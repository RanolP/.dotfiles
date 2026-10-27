import { isOpen, isRecord, shownNote, type Issue, type TrackerEvent } from './tracker'
import {
  EMPTY_LEDGER, constraintFactLines, learnedFactLines, notesOf, sectionBody, type Topic,
} from './ledger'
import { resourceLedgerForSession } from './resources'
import { clauseQuoteOverlaps, clauseStoreKey, emptyClauseStore, readClauseStore, renderClauses } from './clauses'

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
  questions?: readonly Issue[]
  uncertain?: readonly Issue[]
  learned?: readonly string[]
  resources?: readonly string[]
}

export type ResidentIo = {
  get: (key: string) => Promise<unknown>
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

export async function residentLedger(
  io: ResidentIo, key: string, issues: readonly Issue[], state: { stack: string[]; pending: string[] }, _events: readonly TrackerEvent[], preview: LedgerPreview = {},
): Promise<string> {
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
  const clauseStore = readClauseStore(await io.get(clauseStoreKey(key))) ?? emptyClauseStore()
  const inScope = (issue: string | null) => issue === null || ancestors.has(issue)
  const instructions = renderClauses(clauseStore, inScope)
  const liveQuotes = clauseStore.clauses.filter(clause => clause.status === 'live').map(clause => clause.quote)
  const rawNotes = preview.notes ?? notesOf((await io.readLedger()) ?? EMPTY_LEDGER)
  const meta = await io.readMeta()
  const topics = preview.topics ?? await io.storedTopics(rawNotes, meta.seq, key)
  const scopedTopics = topics
    .map(topic => topic.focusIssue === undefined ? { ...topic, focusIssue: topId ?? null } : topic)
    .filter(topic => (topic.focusIssue ?? null) === (topId ?? null))
  const fallbackGoal = sectionBody(rawNotes, '목표')
  const where = topics.length
    ? scopedTopics.map(topic => `${topic.topic}: ${topic.summary}`)
    : fallbackGoal && fallbackGoal !== '- (none yet)' ? [fallbackGoal] : []
  const requests = (await io.readRequests(key)).filter(request => request.status === 'open' && !liveQuotes.some(quote => clauseQuoteOverlaps(request.quote, quote)))
  const constraints = constraintFactLines(rawNotes).map(line => line.replace(/^\[constraint\]\s*/, ''))
  const learned = learnedFactLines(rawNotes)
  const resources = await resourceLedgerForSession(key.split(':')[0] ?? '')
  const sections: ResidentLedgerSections = {
    where,
    children: shownIssues.filter(issue => topId !== undefined && issue.parent === topId && isOpen(issue)),
    requests,
    constraints,
    questions: shownIssues.filter(issue => issue.status === 'question'),
    uncertain: shownIssues.filter(issue => issue.status === 'uncertain'),
    learned,
    resources,
  }
  return residentLedgerText(top, top ? String(addresses[top.id] ?? '') || undefined : undefined, shownState.stack.length, shownState.pending.length, instructions, sections)
}

export function residentLedgerText(
  top: Issue | undefined, topAddress: string | undefined, stackSize: number, pendingCount: number,
  instructions: readonly string[], sections: ResidentLedgerSections = {},
): string {
  const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()
  const bullet = (value: string) => `- ${oneLine(value).replace(/^-\s*/, '')}`
  const lastNote = top && shownNote(top)
  const focus = top
    ? `- ${oneLine(top.title)}${lastNote ? ` — ${oneLine(lastNote)}` : ''} ${topAddress ?? '@unknown'}`
    : '- (none)'
  const where = [focus, ...(sections.where ?? []).map(line => oneLine(line)).filter(Boolean).map(line => `- ${line}`), `- stack ${stackSize} · pending ${pendingCount}`]
  const tasks = (sections.children ?? []).filter(issue => issue.parent === top?.id && isOpen(issue))
    .map(issue => {
      const note = shownNote(issue)
      return `- ${oneLine(issue.title)}${note ? ` — ${oneLine(note)}` : ''} [${issue.id}]`
    })
  const requests = (sections.requests ?? []).filter(request => request.status === 'open')
    .map(request => `- [${request.id}] ${oneLine(request.text)} — quote: ${JSON.stringify(oneLine(request.quote))}`)
  const constraints = (sections.constraints ?? []).map(oneLine).filter(Boolean).map(bullet)
  const questions = (sections.questions ?? []).filter(issue => issue.status === 'question')
    .map(issue => {
      const note = shownNote(issue)
      return `- ${oneLine(issue.title)}${note ? ` — ${oneLine(note)}` : ''} [${issue.id}]`
    })
  const uncertain = (sections.uncertain ?? []).filter(issue => issue.status === 'uncertain')
    .map(issue => `- ${oneLine(issue.title)} — settling check: ${oneLine(shownNote(issue) ?? 'verify the claim')} [${issue.id}]`)
  const learned = (sections.learned ?? []).map(oneLine).filter(Boolean).map(bullet)
  const resources = (sections.resources ?? []).map(oneLine).filter(Boolean).map(bullet)
  const body = (lines: readonly string[]) => lines.length ? lines.join('\n') : '- (none yet)'
  return [
    '## where we are', where.join('\n'),
    '## what to do', body(tasks),
    '## what to request', body(requests),
    // Shown only while a question waits, so the common case pays nothing for it.
    ...(questions.length ? ['## open questions', questions.join('\n')] : []),
    '## user instructions', body(instructions),
    '## constraints & preferences', body(constraints),
    '## uncertain', body(uncertain),
    '## learned', body(learned),
    '## owned resources', body(resources),
  ].join('\n\n')
}
