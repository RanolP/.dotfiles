import { effectiveIssueLabel, isOpen, isRecord, labelVisibility, shownNote, type Issue, type TrackerEvent } from './tracker'
import {
  EMPTY_LEDGER, constraintFactLines, learnedFactLines, notesOf, type Topic,
} from './ledger'
import { resourceLedgerForSession } from './resources'
import { LEDGER_LINE_LIMIT } from './fold'
import { applyClauses, assumptionStatuses, clauseQuoteOverlaps, clauseStoreKey, emptyClauseStore, parseClause, pendingClauseIds, readClauseStore, renderClauses, type ClauseStore, type IncomingClause } from './clauses'

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
  plan?: { objective?: { text: string; address: string }; revision: number; steps: readonly Issue[] }
  requests?: readonly ResidentLedgerRequest[]
  facts?: readonly string[]
  constraints?: readonly string[]
  questions?: readonly Issue[]
  uncertain?: readonly Issue[]
  legacy?: readonly string[]
  learned?: readonly string[]
  resources?: readonly string[]
  pendingInvalid?: readonly string[]
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
export const objectiveKey = (key: string) => `objective:${key}`
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
  let clauseStore = preview.clauses ?? readClauseStore(await io.get(clauseStoreKey(key))) ?? emptyClauseStore()
  const rawNotes = preview.notes ?? notesOf((await io.readLedger()) ?? EMPTY_LEDGER)
  const meta = await io.readMeta()
  const topics = preview.topics ?? await io.readLegacyTopics(rawNotes, meta.seq, key)
  const migrated = clauseStore.migratedLedger ? clauseStore : migrateLegacyLedger(clauseStore, rawNotes, topics, meta.seq, new Date().toISOString())
  if (migrated !== clauseStore) {
    clauseStore = migrated
    if (!preview.clauses) await io.set?.(clauseStoreKey(key), clauseStore)
    if (clauseStore.legacy?.length) io.log?.(`clm: ${clauseStore.legacy.length} legacy ledger line(s) could not migrate`, { to: 'debug' })
  }
  const statuses = assumptionStatuses(clauseStore, shownIssues)
  const issueVisibility = (issue: Issue) => issue.status === 'dropped' ? 'invalid' : labelVisibility(effectiveIssueLabel(issue, byId), id => statuses.get(id))
  const candidate = topId ? byId.get(topId) : undefined
  const top = candidate && issueVisibility(candidate) !== 'invalid' ? candidate : undefined
  const ancestors = new Set<string>()
  let current = top
  let planRoot: Issue | undefined
  while (current && !ancestors.has(current.id)) {
    ancestors.add(current.id)
    if (!planRoot && current.planMode) planRoot = current
    current = current.parent ? byId.get(current.parent) : undefined
  }
  const inScope = (issue: string | null) => issue === null || ancestors.has(issue)
  // With no focus there is no position to narrow to, so show every open goal.
  const goalInScope = ancestors.size ? inScope : (issue: string | null) => issue === null || shownIssues.some(candidateIssue => candidateIssue.id === issue && isOpen(candidateIssue))
  const activeBranchIds = new Set([...ancestors, ...clauseStore.clauses.filter(clause => clause.kind === 'assume' && clause.issue !== null && ancestors.has(clause.issue)).map(clause => clause.id)])
  const underActiveBranch = (issue: Issue) => {
    const seen = new Set<string>()
    let cursor: Issue | undefined = issue
    while (cursor && !seen.has(cursor.id)) {
      if (ancestors.has(cursor.id)) return true
      seen.add(cursor.id)
      cursor = cursor.parent ? byId.get(cursor.parent) : undefined
    }
    return false
  }
  const visible = (issue: Issue) => issueVisibility(issue) === 'main' || (issueVisibility(issue) === 'branch' && underActiveBranch(issue))
  const scopedClauses = (scope: (issue: string | null) => boolean, cap: number, kinds: Parameters<typeof renderClauses>[3]) => [
    ...renderClauses(clauseStore, scope, cap, kinds, statuses),
    ...(ancestors.size ? renderClauses(clauseStore, scope, cap, kinds, statuses, true, activeBranchIds) : []),
  ].slice(0, cap)
  const instructions = scopedClauses(inScope, 40, ['instruction'])
  const facts = scopedClauses(inScope, 15, ['fact'])
  const where = scopedClauses(goalInScope, 20, ['goal'])
  const liveQuotes = clauseStore.clauses.filter(clause => clause.status === 'live' && clause.kind === 'instruction').map(clause => clause.quote)
  const requests = (await io.readRequests(key)).filter(request => request.status === 'open' && !liveQuotes.some(quote => clauseQuoteOverlaps(request.quote, quote)))
  const resources = await resourceLedgerForSession(key.split(':')[0] ?? '')
  const objective = await io.get(objectiveKey(key))
  const plannedObjective = planRoot && isRecord(objective) && objective.issue === planRoot.id
    && typeof objective.text === 'string' && typeof objective.address === 'string'
    ? { text: objective.text, address: objective.address } : undefined
  const sections: ResidentLedgerSections = {
    where,
    children: shownIssues.filter(issue => top !== undefined && issue.parent === top.id && isOpen(issue) && visible(issue)),
    ...(planRoot ? { plan: { objective: plannedObjective, revision: planRoot.planRevision ?? 0, steps: shownIssues.filter(issue => issue.parent === planRoot.id && visible(issue)) } } : {}),
    requests,
    facts,
    questions: shownIssues.filter(issue => issue.status === 'question' && visible(issue)),
    uncertain: shownIssues.filter(issue => issue.status === 'uncertain' && visible(issue)),
    legacy: clauseStore.legacy,
    resources,
    pendingInvalid: [...shownIssues.filter(issue => issue.status !== 'dropped' && issue.resolution !== 'closed'
      && issueVisibility(issue) === 'invalid').map(issue => issue.id), ...pendingClauseIds(clauseStore, statuses)],
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
  const invalid = [...new Set(sections.pendingInvalid ?? [])]
  const held = invalid.length ? `- 보류: 기각된 가정에 기댄 추론 ${invalid.length}개가 결정을 기다린다 — 사용자에게 닫을지 살릴지 묻는다 [${invalid.join(', ')}]` : undefined
  const where = [focus, ...(sections.where ?? []).map(line => oneLine(line).replace(/^-\s*/, '')).filter(Boolean).map(line => `- ${line}`), ...(held ? [held] : []), `- stack ${stackSize} · pending ${pendingCount}`]
  const tasks = (sections.children ?? []).filter(issue => issue.parent === top?.id && isOpen(issue))
    .map(issue => {
      const note = shownNote(issue)
      return `- ${oneLine(issue.title)}${note ? ` — ${oneLine(note)}` : ''} [${issue.id}]`
    })
  const plan = sections.plan
  const clippedObjective = plan?.objective?.text.length && plan.objective.text.length > 600
    ? `${plan.objective.text.slice(0, 599)}…` : plan?.objective?.text
  const clipPlanLine = (line: string) => {
    const chars = [...line]
    return chars.length > LEDGER_LINE_LIMIT ? `${chars.slice(0, LEDGER_LINE_LIMIT - 1).join('')}…` : line
  }
  const done = plan?.steps.filter(issue => issue.status === 'done') ?? []
  const hiddenDone = new Set(done.slice(0, -12).map(issue => issue.id))
  let collapsedDone = false
  const stepLines = plan?.steps.flatMap(issue => {
    if (hiddenDone.has(issue.id)) {
      if (collapsedDone) return []
      collapsedDone = true
      return [`- …+${hiddenDone.size} done (clm_recall @step:${issue.id})`]
    }
    const result = issue.status === 'done' ? issue.result : undefined
    const detail = result ? ` — ${oneLine(result.intent)} → ${oneLine(result.finding)} → ${oneLine(result.decision)}${result.files.length ? ` (files: ${result.files.map(oneLine).join(', ')})` : ''}` : ''
    return [clipPlanLine(`- [${issue.status === 'done' ? 'x' : issue.status === 'doing' ? '>' : issue.status === 'dropped' ? '-' : ' '}] ${oneLine(issue.title)}${detail} [${issue.id}]`)]
  }) ?? []
  const planLines = plan ? [
    ...(clippedObjective ? [`- objective (${plan.objective?.address ?? '@unknown'}): ${JSON.stringify(clippedObjective)}`] : []),
    `- revision ${plan.revision}`,
    ...stepLines,
  ] : []
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
    ...(plan ? ['## plan', body(planLines)] : ['## what to do', body(tasks)]),
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
