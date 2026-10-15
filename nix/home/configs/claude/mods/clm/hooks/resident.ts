import { isOpen, type Issue } from './tracker'

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
