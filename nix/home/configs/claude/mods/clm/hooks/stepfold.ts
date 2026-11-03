import type { SessionMessage } from 'claude-code'

import { estTokens, isPrompt } from './fold'
import { isRecord, type Issue } from './tracker'

export type FoldStep = {
  id: string
  intent: string
  finding: string
  decision: string
  files: string[]
  startToolUseId: string
  endToolUseId: string
}

export type StepFoldSpan = Pick<FoldStep, 'id' | 'startToolUseId' | 'endToolUseId'> & { status: 'done' | 'doing' }
export type StepFoldRecord = Pick<FoldStep, 'id' | 'intent' | 'finding' | 'decision' | 'files'>
export type CollapsedStep = { id: string; rows: readonly SessionMessage[] }
export type StepReplacementPlan = { replace: Record<string, string>; collapsed: CollapsedStep[]; savedTokens: number }

const TASK_TOOL = 'mcp__clm__clm_task'
const ABSOLUTE_PATH = /(\/[\w.@~+-]+(?:\/[\w.@~+-]+)+\.\w+)/g
const MIN_SAVED_TOKENS = 2000

const toolUseIndex = (rows: readonly SessionMessage[]) => new Map(rows.flatMap((row, rowIndex) =>
  row.toolUses.map(use => [use.tool_use_id, rowIndex] as const)))

const resultEndIndex = (rows: readonly SessionMessage[], id: string, fallback: number) => {
  for (let index = fallback; index < rows.length; index++)
    if (rows[index]?.toolResults?.some(result => result.tool_use_id === id)) return index
  return fallback
}

const taskCalls = (rows: readonly SessionMessage[]) => rows.flatMap(row => row.toolUses.flatMap(use => {
  if (use.tool !== TASK_TOOL || !isRecord(use.input)) return []
  return [{ id: use.tool_use_id, input: use.input }]
}))

/** Resolves the live tracker plan to tool-use boundaries without changing transcript rows. */
export function plannedStepSpans(rows: readonly SessionMessage[], issues: readonly Issue[]): { spans: StepFoldSpan[]; records: StepFoldRecord[] } {
  const calls = taskCalls(rows)
  const positions = toolUseIndex(rows)
  const planned = issues.filter(issue => issue.parent && issues.some(root => root.id === issue.parent && root.planMode))
  const starts = planned.map(issue => issue.result?.span?.startToolUseId ?? issue.startToolUseId
    ?? calls.find(call => call.input.id === issue.id && call.input.status === 'doing')?.id)
  const spans: StepFoldSpan[] = []
  const records: StepFoldRecord[] = []
  for (const [index, issue] of planned.entries()) {
    const startToolUseId = starts[index]
    if (!startToolUseId || !positions.has(startToolUseId)) continue
    let endToolUseId = issue.result?.span?.endToolUseId
      ?? calls.find(call => call.input.id === issue.id && call.input.status === 'done')?.id
    if (!endToolUseId) {
      const next = starts.slice(index + 1).find(id => id && positions.has(id))
      const before = next ? (positions.get(next) ?? 0) - 1 : -1
      if (before >= 0) endToolUseId = rows.slice(0, before + 1).flatMap(row => row.toolUses).at(-1)?.tool_use_id
    }
    if (!endToolUseId || !positions.has(endToolUseId)) continue
    spans.push({ id: issue.id, startToolUseId, endToolUseId, status: issue.status === 'done' ? 'done' : 'doing' })
    if (issue.result) records.push({ id: issue.id, intent: issue.result.intent, finding: issue.result.finding, decision: issue.result.decision, files: issue.result.files })
  }
  return { spans, records }
}

const validClause = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 160

/** Drops malformed model step proposals independently, keeping every valid ordered span. */
export function validateFoldSteps(rows: readonly SessionMessage[], proposed: readonly unknown[], seq: number): FoldStep[] {
  const positions = toolUseIndex(rows)
  const lastTurnStart = rows.findLastIndex(isPrompt)
  const finalToolUse = rows.slice(Math.max(0, lastTurnStart)).flatMap(row => row.toolUses).at(-1)?.tool_use_id
  const finalIndex = finalToolUse ? positions.get(finalToolUse) : undefined
  const accepted: FoldStep[] = []
  let previousEnd = -1
  for (const candidate of proposed.slice(0, 8)) {
    if (!isRecord(candidate)) continue
    const fromId = candidate.from
    const toId = candidate.to
    const intent = candidate.intent
    const finding = candidate.finding
    const decision = candidate.decision
    if (typeof fromId !== 'string' || typeof toId !== 'string') continue
    const from = positions.get(fromId)
    const to = positions.get(toId)
    const files = candidate.files === undefined ? [] : candidate.files
    if (from === undefined || to === undefined || from > to || from <= previousEnd
      || (finalIndex !== undefined && from <= finalIndex && finalIndex <= to)
      || !validClause(intent) || !validClause(finding) || !validClause(decision)
      || !Array.isArray(files) || files.length > 5 || !files.every((file): file is string => typeof file === 'string' && file.trim().length > 0)) continue
    accepted.push({
      id: `s${seq}-${accepted.length + 1}`, startToolUseId: fromId, endToolUseId: toId,
      intent: intent.trim(), finding: finding.trim(), decision: decision.trim(), files: files.map(file => file.trim()),
    })
    previousEnd = to
  }
  return accepted
}

const resultTokens = (toolUseId: string, text: string) => estTokens({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: toolUseId, text, isError: false }] })

/** Replaces only large, closed-step tool-result texts and preserves every row and pair. */
export function stepReplacements(
  tail: readonly SessionMessage[], spans: readonly StepFoldSpan[], records: readonly StepFoldRecord[],
): StepReplacementPlan {
  const positions = toolUseIndex(tail)
  const recordById = new Map(records.map(record => [record.id, record]))
  const useById = new Map(tail.flatMap(row => row.toolUses.map(use => [use.tool_use_id, use] as const)))
  const replace: Record<string, string> = {}
  const collapsed: CollapsedStep[] = []
  for (const span of spans) {
    if (span.status !== 'done') continue
    const record = recordById.get(span.id)
    const start = positions.get(span.startToolUseId), rawEnd = positions.get(span.endToolUseId)
    if (!record || start === undefined || rawEnd === undefined || start > rawEnd) continue
    const end = resultEndIndex(tail, span.endToolUseId, rawEnd)
    const later = tail.slice(end + 1)
    const eligible = tail.slice(start, end + 1).flatMap(row => row.toolResults ?? []).filter(result => {
      if (result.isError || result.text.length <= 400 || result.text.startsWith('[clm step ') || result.text.startsWith('[clm: folded into step ')) return false
      const laterText = later.map(item => `${item.text}\n${JSON.stringify(item.toolUses.map(use => use.input))}`).join('\n')
      const input = JSON.stringify(useById.get(result.tool_use_id)?.input ?? {})
      const paths = [...input.matchAll(ABSOLUTE_PATH)].flatMap(match => match[1] === undefined ? [] : [match[1]])
      return !laterText.includes(result.tool_use_id) && !paths.some(path => laterText.includes(path))
    })
    for (const [index, result] of eligible.entries()) {
      const address = `@step:${span.id}`
      const replacement = index === 0
        ? `[clm step ${span.id} done: ${record.intent} → ${record.finding} → ${record.decision}; files: ${record.files.join(', ')}. Its raw tool results are stored: call clm_recall with {"address":"${address}"} before you re-run or re-read them.]`
        : `[clm: folded into step ${span.id}; clm_recall {"address":"${address}"}]`
      replace[result.tool_use_id] = replacement
    }
    if (eligible.length) collapsed.push({ id: span.id, rows: tail.slice(start, end + 1) })
  }
  return finalizeStepReplacements(tail, replace, collapsed)
}

export function finalizeStepReplacements(
  tail: readonly SessionMessage[], replace: Record<string, string>, collapsed: CollapsedStep[],
): StepReplacementPlan {
  const originals = new Map(tail.flatMap(row => (row.toolResults ?? []).map(result => [result.tool_use_id, result.text] as const)))
  const savedTokens = Object.entries(replace).reduce((total, [id, replacement]) => {
    const original = originals.get(id) ?? ''
    return total + Math.max(0, resultTokens(id, original) - resultTokens(id, replacement))
  }, 0)
  return savedTokens < MIN_SAVED_TOKENS ? { replace: {}, collapsed: [], savedTokens: 0 } : { replace, collapsed, savedTokens }
}

export const shouldRequestSingleTurnSteps = (tail: readonly SessionMessage[], hasPlan: boolean): boolean =>
  !hasPlan && tail.reduce((total, row) => total + estTokens(row), 0) > 20_000
