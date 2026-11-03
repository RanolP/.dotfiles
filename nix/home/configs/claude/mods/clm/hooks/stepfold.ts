import type { SessionMessage } from 'claude-code'

import { estTokens, isPrompt } from './fold'
import type { Issue } from './tracker'

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

const taskCalls = (rows: readonly SessionMessage[]) => rows.flatMap((row, rowIndex) => row.toolUses.flatMap(use => {
  if (use.tool !== TASK_TOOL || typeof use.input !== 'object' || use.input === null) return []
  return [{ id: use.tool_use_id, rowIndex, input: use.input as Record<string, unknown> }]
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
    if (typeof candidate !== 'object' || candidate === null) continue
    const value = candidate as Record<string, unknown>
    const from = typeof value.from === 'string' ? positions.get(value.from) : undefined
    const to = typeof value.to === 'string' ? positions.get(value.to) : undefined
    const files = value.files === undefined ? [] : value.files
    if (from === undefined || to === undefined || from > to || from <= previousEnd
      || (finalIndex !== undefined && from <= finalIndex && finalIndex <= to)
      || !validClause(value.intent) || !validClause(value.finding) || !validClause(value.decision)
      || !Array.isArray(files) || files.length > 5 || !files.every(file => typeof file === 'string' && file.trim())) continue
    accepted.push({
      id: `s${seq}-${accepted.length + 1}`, startToolUseId: value.from as string, endToolUseId: value.to as string,
      intent: value.intent.trim(), finding: value.finding.trim(), decision: value.decision.trim(), files: files.map(file => file.trim()),
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
  let savedTokens = 0
  for (const span of spans) {
    if (span.status !== 'done') continue
    const record = recordById.get(span.id)
    const start = positions.get(span.startToolUseId), rawEnd = positions.get(span.endToolUseId)
    if (!record || start === undefined || rawEnd === undefined || start > rawEnd) continue
    const end = resultEndIndex(tail, span.endToolUseId, rawEnd)
    const later = tail.slice(end + 1)
    let first = true
    let changed = false
    for (const row of tail.slice(start, end + 1)) for (const result of row.toolResults ?? []) {
      if (result.isError || result.text.length <= 400) continue
      const laterText = later.map(item => `${item.text}\n${JSON.stringify(item.toolUses.map(use => use.input))}`).join('\n')
      const input = JSON.stringify(useById.get(result.tool_use_id)?.input ?? {})
      const paths = [...input.matchAll(ABSOLUTE_PATH)].map(match => match[1]!)
      if (laterText.includes(result.tool_use_id) || paths.some(path => laterText.includes(path))) continue
      const address = `@step:${span.id}`
      const replacement = first
        ? `[clm step ${span.id} done: ${record.intent} → ${record.finding} → ${record.decision}; files: ${record.files.join(', ')}. Its raw tool results are stored: call clm_recall with {"address":"${address}"} before you re-run or re-read them.]`
        : `[clm: folded into step ${span.id}; clm_recall {"address":"${address}"}]`
      replace[result.tool_use_id] = replacement
      savedTokens += Math.max(0, resultTokens(result.tool_use_id, result.text) - resultTokens(result.tool_use_id, replacement))
      first = false
      changed = true
    }
    if (changed) collapsed.push({ id: span.id, rows: tail.slice(start, end + 1) })
  }
  return savedTokens < MIN_SAVED_TOKENS ? { replace: {}, collapsed: [], savedTokens: 0 } : { replace, collapsed, savedTokens }
}

export const shouldRequestSingleTurnSteps = (tail: readonly SessionMessage[], hasPlan: boolean): boolean =>
  !hasPlan && tail.reduce((total, row) => total + estTokens(row), 0) > 20_000
