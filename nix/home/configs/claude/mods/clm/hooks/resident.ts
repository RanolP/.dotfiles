import { effectiveIssueLabel, isOpen, isRecord, labelVisibility, shownNote, type Issue, type TrackerEvent } from './tracker'
import {
  EMPTY_LEDGER, constraintFactLines, learnedFactLines, notesOf, type Topic,
} from './ledger'
import { resourceLedgerForSession } from './resources'
import { LEDGER_LINE_LIMIT } from './fold'
import { noteLine, noteStoreKey, readNotes } from './memory'

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
  /** clm_note lines, shown verbatim after the other facts so ledger trimming reaches them last. */
  notes?: readonly string[]
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
}

type LedgerPreview = { notes?: string; topics?: Topic[]; issues?: Issue[]; state?: { stack: string[]; pending: string[] } }
export const issueAddressKey = (key: string) => `issue-addresses:${key}`
export const objectiveKey = (key: string) => `objective:${key}`
export async function residentLedger(
  io: ResidentIo, key: string, issues: readonly Issue[], state: { stack: string[]; pending: string[] }, _events: readonly TrackerEvent[], preview: LedgerPreview = {},
): Promise<string> {
  const shownIssues = preview.issues ?? [...issues]
  const shownState = preview.state ?? state
  const addressesRaw = await io.get(issueAddressKey(key))
  const addresses = isRecord(addressesRaw) ? addressesRaw : {}
  const byId = new Map(shownIssues.map(issue => [issue.id, issue]))
  const topId = shownState.stack.at(-1)
  const issueVisibility = (issue: Issue) => issue.status === 'dropped' ? 'invalid' : labelVisibility(effectiveIssueLabel(issue, byId), id => { const issue = byId.get(id); return issue?.status === 'dropped' ? 'rejected' : issue?.status === 'done' && issue.result ? 'merged' : issue ? 'live' : undefined })
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
  const resources = await resourceLedgerForSession(key.split(':')[0] ?? '')
  const objective = await io.get(objectiveKey(key))
  const plannedObjective = planRoot && isRecord(objective) && objective.issue === planRoot.id
    && typeof objective.text === 'string' && typeof objective.address === 'string'
    ? { text: objective.text, address: objective.address } : undefined
  const sections: ResidentLedgerSections = {
    children: shownIssues.filter(issue => top !== undefined && issue.parent === top.id && isOpen(issue) && visible(issue)),
    ...(planRoot ? { plan: { objective: plannedObjective, revision: planRoot.planRevision ?? 0, steps: shownIssues.filter(issue => issue.parent === planRoot.id && visible(issue)) } } : {}),
    notes: readNotes(await io.get(noteStoreKey(key))),
    questions: shownIssues.filter(issue => issue.status === 'question' && visible(issue)),
    uncertain: shownIssues.filter(issue => issue.status === 'uncertain' && visible(issue)),
    resources,
    pendingInvalid: [...shownIssues.filter(issue => issue.status !== 'dropped' && issue.resolution !== 'closed'
      && issueVisibility(issue) === 'invalid').map(issue => issue.id)],
  }
  return residentLedgerText(top, top ? String(addresses[top.id] ?? '') || undefined : undefined, shownState.stack.length, shownState.pending.length, sections)
}

export function residentLedgerText(
  top: Issue | undefined, topAddress: string | undefined, stackSize: number, pendingCount: number,
  sections: ResidentLedgerSections = {},
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
    // Shown only while a question waits, so the common case pays nothing for it.
    ...(questions.length ? ['## open questions', questions.join('\n')] : []),
    ...(sections.notes?.length ? ['## notes', body(sections.notes.map(note => noteLine(oneLine(note))))] : []),
    '## uncertain', body(uncertain),
    ...(legacy.length ? ['## legacy', legacy.join('\n')] : []),
    '## owned resources', body(resources),
  ].join('\n\n')
}
