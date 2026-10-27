import { isOpen, isRecord, shownNote, type Issue, type TrackerEvent } from './tracker'
import {
  EMPTY_LEDGER, constraintFactLines, learnedFactLines, notesOf, type Topic,
} from './ledger'
import { resourceLedgerForSession } from './resources'
import { applyClauses, clauseQuoteOverlaps, clauseStoreKey, emptyClauseStore, parseClause, readClauseStore, renderClauses, type ClauseStore, type IncomingClause } from './clauses'

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
  facts?: readonly string[]
  constraints?: readonly string[]
  questions?: readonly Issue[]
  uncertain?: readonly Issue[]
  legacy?: readonly string[]
  learned?: readonly string[]
  resources?: readonly string[]
}

export type ResidentIo = {
  get: (key: string) => Promise<unknown>
  set?: (key: string, value: unknown) => Promise<void>
  log?: (text: string, options?: { to?: 'transcript' | 'debug' }) => void
  readLedger: () => Promise<string | undefined>
  readMeta: () => Promise<{ seq: number }>
  readLegacyTopics: (notes: string, seq: number, key: string) => Promise<Topic[]>
  readRequests: (key: string) => Promise<ResidentLedgerRequest[]>
}

type LedgerPreview = { notes?: string; topics?: Topic[]; issues?: Issue[]; state?: { stack: string[]; pending: string[] }; clauses?: ClauseStore }
export const instructionIndexKey = (key: string) => `instruction-index:${key}`
export const issueAddressKey = (key: string) => `issue-addresses:${key}`
export function isInstructionIndex(value: unknown): value is InstructionIndex {
  return isRecord(value) && typeof value.address === 'string' && (/^@[\da-f]{8}$/i.test(value.address) || value.address === '@unknown')
    && (typeof value.issue === 'string' || value.issue === null) && typeof value.text === 'string'
}

const atom = (value: string) => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

/** Converts every old prose line, retaining unparsable lines for a visible legacy section. */
export function migrateLegacyLedger(store: ClauseStore, notes: string, topics: readonly Topic[], promptSeq: number, now: string): ClauseStore {
  if (store.migratedLedger) return store
  const input: IncomingClause[] = []
  const legacy: string[] = []
  const existing = new Set(store.clauses.map(clause => clause.text))
  const facts = [...constraintFactLines(notes), ...learnedFactLines(notes)]
  if (!facts.length && !topics.length) return { ...store, migratedLedger: true }
  facts.forEach((line, index) => {
    const text = line.replace(/^\[constraint\]\s*/, '').replace(/^\s*-\s*/, '').trim()
    if (!text) { legacy.push(line); return }
    if (existing.has(text)) return
    try {
      input.push({ ...parseClause(`legacy_fact(${atom(`F${index + 1}`)}).`), text, quote: text, address: '@unknown', issue: null, key: 1, origin: 'legacy', kind: 'fact' })
    } catch { legacy.push(line) }
  })
  const newest = new Map<string | null, Topic>()
  for (const topic of topics) newest.set(topic.focusIssue ?? null, topic)
  for (const [issue, topic] of newest) {
    const text = `${topic.topic}: ${topic.summary}`
    if (existing.has(text)) continue
    try {
      input.push({ ...parseClause(`goal(${atom(issue ?? 'session')}, legacy).`), text, quote: topic.summary, address: '@unknown', issue, key: 1, origin: 'legacy', kind: 'goal' })
    } catch { legacy.push(text) }
  }
  return { ...applyClauses(store, input, promptSeq, now).next, migratedLedger: true, ...(legacy.length ? { legacy } : {}) }
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
  let clauseStore = preview.clauses ?? readClauseStore(await io.get(clauseStoreKey(key))) ?? emptyClauseStore()
  const inScope = (issue: string | null) => issue === null || ancestors.has(issue)
  const rawNotes = preview.notes ?? notesOf((await io.readLedger()) ?? EMPTY_LEDGER)
  const meta = await io.readMeta()
  const topics = preview.topics ?? await io.readLegacyTopics(rawNotes, meta.seq, key)
  const migrated = clauseStore.migratedLedger ? clauseStore : migrateLegacyLedger(clauseStore, rawNotes, topics, meta.seq, new Date().toISOString())
  if (migrated !== clauseStore) {
    clauseStore = migrated
    if (!preview.clauses) await io.set?.(clauseStoreKey(key), clauseStore)
    if (clauseStore.legacy?.length) io.log?.(`clm: ${clauseStore.legacy.length} legacy ledger line(s) could not migrate`, { to: 'debug' })
  }
  const instructions = renderClauses(clauseStore, inScope, 40, ['instruction'])
  const facts = renderClauses(clauseStore, inScope, 15, ['fact'])
  const where = renderClauses(clauseStore, inScope, 20, ['goal'])
  const liveQuotes = clauseStore.clauses.filter(clause => clause.status === 'live' && clause.kind === 'instruction').map(clause => clause.quote)
  const requests = (await io.readRequests(key)).filter(request => request.status === 'open' && !liveQuotes.some(quote => clauseQuoteOverlaps(request.quote, quote)))
  const resources = await resourceLedgerForSession(key.split(':')[0] ?? '')
  const sections: ResidentLedgerSections = {
    where,
    children: shownIssues.filter(issue => topId !== undefined && issue.parent === topId && isOpen(issue)),
    requests,
    facts,
    questions: shownIssues.filter(issue => issue.status === 'question'),
    uncertain: shownIssues.filter(issue => issue.status === 'uncertain'),
    legacy: clauseStore.legacy,
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
  const where = [focus, ...(sections.where ?? []).map(line => oneLine(line).replace(/^-\s*/, '')).filter(Boolean).map(line => `- ${line}`), `- stack ${stackSize} · pending ${pendingCount}`]
  const tasks = (sections.children ?? []).filter(issue => issue.parent === top?.id && isOpen(issue))
    .map(issue => {
      const note = shownNote(issue)
      return `- ${oneLine(issue.title)}${note ? ` — ${oneLine(note)}` : ''} [${issue.id}]`
    })
  const requests = (sections.requests ?? []).filter(request => request.status === 'open')
    .map(request => `- [${request.id}] ${oneLine(request.text)} — quote: ${JSON.stringify(oneLine(request.quote))}`)
  const facts = [...(sections.facts ?? []), ...(sections.constraints ?? []), ...(sections.learned ?? [])].map(oneLine).filter(Boolean).map(line => line.startsWith('- ') ? line : bullet(line))
  const questions = (sections.questions ?? []).filter(issue => issue.status === 'question')
    .map(issue => {
      const note = shownNote(issue)
      return `- ${oneLine(issue.title)}${note ? ` — ${oneLine(note)}` : ''} [${issue.id}]`
    })
  const uncertain = (sections.uncertain ?? []).filter(issue => issue.status === 'uncertain')
    .map(issue => `- ${oneLine(issue.title)} — settling check: ${oneLine(shownNote(issue) ?? 'verify the claim')} [${issue.id}]`)
  const legacy = (sections.legacy ?? []).map(oneLine).filter(Boolean).map(bullet)
  const resources = (sections.resources ?? []).map(oneLine).filter(Boolean).map(bullet)
  const body = (lines: readonly string[]) => lines.length ? lines.join('\n') : '- (none yet)'
  return [
    '## where we are', where.join('\n'),
    '## what to do', body(tasks),
    '## what to request', body(requests),
    // Shown only while a question waits, so the common case pays nothing for it.
    ...(questions.length ? ['## open questions', questions.join('\n')] : []),
    '## user instructions', body(instructions),
    '## facts', body(facts),
    '## uncertain', body(uncertain),
    ...(legacy.length ? ['## legacy', legacy.join('\n')] : []),
    '## owned resources', body(resources),
  ].join('\n\n')
}
