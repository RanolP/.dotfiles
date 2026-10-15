import type { PromptOrigin } from 'claude-code'
import type { ClmWorkflow } from '../types'

const emptyWorkflow = (): ClmWorkflow => ({
  later: [], resumeRequest: null, lastSubmittedTurn: null, activeTurnId: null,
  promptSeq: 0, focusAppliedSeq: 0, replayed: null,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function workflowValue(value: unknown): ClmWorkflow {
  const empty = emptyWorkflow()
  if (!isRecord(value)) return empty
  const later = Array.isArray(value.later) ? value.later.flatMap((item): ClmWorkflow['later'] => {
    if (typeof item === 'string') return item.trim() ? [{ text: item }] : []
    if (!isRecord(item) || typeof item.text !== 'string' || !item.text.trim()) return []
    return [{ text: item.text, ...(typeof item.issue === 'string' ? { issue: item.issue } : {}) }]
  }) : []
  const resumeRequest = value.resumeRequest === null || value.resumeRequest === undefined
    ? null
    : isRecord(value.resumeRequest) && typeof value.resumeRequest.text === 'string' ? { text: value.resumeRequest.text } : null
  const replayed = isRecord(value.replayed) && typeof value.replayed.issue === 'string' ? { issue: value.replayed.issue } : null
  return {
    later, resumeRequest,
    lastSubmittedTurn: typeof value.lastSubmittedTurn === 'string' ? value.lastSubmittedTurn : null,
    activeTurnId: typeof value.activeTurnId === 'string' ? value.activeTurnId : null,
    promptSeq: typeof value.promptSeq === 'number' && Number.isInteger(value.promptSeq) && value.promptSeq >= 0 ? value.promptSeq : 0,
    focusAppliedSeq: typeof value.focusAppliedSeq === 'number' && Number.isInteger(value.focusAppliedSeq) && value.focusAppliedSeq >= 0 ? value.focusAppliedSeq : 0,
    replayed,
  }
}

export const isHumanOrigin = (origin: PromptOrigin) => origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
export function resetUserWorkflow(current: ClmWorkflow, origin: PromptOrigin): ClmWorkflow {
  if (!isHumanOrigin(origin) || (!current.resumeRequest && current.lastSubmittedTurn === null)) return current
  return { ...current, resumeRequest: null, lastSubmittedTurn: null }
}

export type Continuation = { text: string; issue?: string; asUser?: true; source: 'later' | 'resume' }
export function chooseContinuation(current: ClmWorkflow, turnId: string): { workflow: ClmWorkflow; continuation?: Continuation } {
  if (current.lastSubmittedTurn === turnId) return { workflow: current }
  const [laterHead, ...laterRest] = current.later
  if (laterHead !== undefined) {
    return {
      workflow: {
        ...current, later: laterRest, lastSubmittedTurn: turnId,
        replayed: laterHead.issue ? { issue: laterHead.issue } : current.replayed,
      },
      continuation: { text: laterHead.text, ...(laterHead.issue ? { issue: laterHead.issue } : {}), asUser: true, source: 'later' },
    }
  }
  if (current.resumeRequest) {
    return {
      workflow: { ...current, resumeRequest: null, lastSubmittedTurn: turnId },
      continuation: { text: current.resumeRequest.text, source: 'resume' },
    }
  }
  return { workflow: current }
}

export function restoreFailedContinuation(current: ClmWorkflow, turnId: string, continuation: Continuation): ClmWorkflow {
  if (current.lastSubmittedTurn !== turnId) return current
  if (continuation.source === 'later')
    return {
      ...current, later: [{ text: continuation.text, ...(continuation.issue ? { issue: continuation.issue } : {}) }, ...current.later],
      replayed: continuation.issue && current.replayed?.issue === continuation.issue ? null : current.replayed,
      lastSubmittedTurn: null,
    }
  return { ...current, resumeRequest: current.resumeRequest ?? { text: continuation.text }, lastSubmittedTurn: null }
}

export function removeQueueSnapshotTargets(
  current: readonly ClmWorkflow['later'][number][], snapshot: readonly ClmWorkflow['later'][number][], positions: readonly number[],
): { remaining: ClmWorkflow['later']; dropped: { item: string; number: number }[] } {
  const remaining = [...current]
  const dropped: { item: string; number: number }[] = []
  for (const number of positions) {
    const target = snapshot[number - 1]
    if (!target) continue
    const index = remaining.findIndex(item => item.text === target.text)
    if (index < 0) continue
    remaining.splice(index, 1)
    dropped.push({ item: target.text, number })
  }
  return { remaining, dropped }
}
