import type { PromptOrigin } from 'claude-code'
import type { ClmWorkflow } from '../types'
import { isRecord } from './tracker'

const emptyWorkflow = (): ClmWorkflow => ({
  resumeRequest: null, lastSubmittedTurn: null, activeTurnId: null,
  promptSeq: 0, focusAppliedSeq: 0,
})

export function workflowValue(value: unknown): ClmWorkflow {
  const empty = emptyWorkflow()
  if (!isRecord(value)) return empty
  const resumeRequest = value.resumeRequest === null || value.resumeRequest === undefined
    ? null
    : isRecord(value.resumeRequest) && typeof value.resumeRequest.text === 'string' ? { text: value.resumeRequest.text } : null
  return {
    resumeRequest,
    lastSubmittedTurn: typeof value.lastSubmittedTurn === 'string' ? value.lastSubmittedTurn : null,
    activeTurnId: typeof value.activeTurnId === 'string' ? value.activeTurnId : null,
    promptSeq: typeof value.promptSeq === 'number' && Number.isInteger(value.promptSeq) && value.promptSeq >= 0 ? value.promptSeq : 0,
    focusAppliedSeq: typeof value.focusAppliedSeq === 'number' && Number.isInteger(value.focusAppliedSeq) && value.focusAppliedSeq >= 0 ? value.focusAppliedSeq : 0,
  }
}

export type WorkflowStateIo = {
  get(): Promise<unknown>
  update(change: (value: unknown) => unknown): Promise<void>
}

export async function readWorkflow(io: Pick<WorkflowStateIo, 'get'>): Promise<ClmWorkflow> {
  return workflowValue(await io.get())
}

export async function changeWorkflow<T>(
  io: WorkflowStateIo, change: (current: ClmWorkflow) => { next: ClmWorkflow; result: T },
): Promise<T> {
  let result: { value: T } | undefined
  await io.update(value => {
    const changed = change(workflowValue(value))
    result = { value: changed.result }
    return changed.next
  })
  if (!result) throw new Error('clm workflow update did not run')
  return result.value
}

export const isHumanOrigin = (origin: PromptOrigin) => origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
export function resetUserWorkflow(current: ClmWorkflow, origin: PromptOrigin): ClmWorkflow {
  if (!isHumanOrigin(origin) || (!current.resumeRequest && current.lastSubmittedTurn === null)) return current
  return { ...current, resumeRequest: null, lastSubmittedTurn: null }
}

export type Continuation = { text: string }
export function chooseContinuation(current: ClmWorkflow, turnId: string): { workflow: ClmWorkflow; continuation?: Continuation } {
  if (current.lastSubmittedTurn === turnId || !current.resumeRequest) return { workflow: current }
  return {
    workflow: { ...current, resumeRequest: null, lastSubmittedTurn: turnId },
    continuation: { text: current.resumeRequest.text },
  }
}

export function restoreFailedContinuation(current: ClmWorkflow, turnId: string, continuation: Continuation): ClmWorkflow {
  if (current.lastSubmittedTurn !== turnId) return current
  return { ...current, resumeRequest: current.resumeRequest ?? { text: continuation.text }, lastSubmittedTurn: null }
}

export type WorkflowIo = {
  read: () => Promise<ClmWorkflow>
  change: <T>(change: (current: ClmWorkflow) => { next: ClmWorkflow; result: T }) => Promise<T>
  submit: (input: { text: string; asUser?: true }) => Promise<{ drop?: string }>
  log: (message: string) => void
}

export async function claimContinuation(io: WorkflowIo, turnId: string): Promise<Continuation | undefined> {
  return io.change(current => {
    const selected = chooseContinuation(current, turnId)
    return { next: selected.workflow, result: selected.continuation }
  })
}

export async function stampHumanPrompt(io: Pick<WorkflowIo, 'change'>): Promise<number> {
  return io.change(current => {
    const promptSeq = Math.max(current.promptSeq, current.focusAppliedSeq) + 1
    return { next: { ...current, promptSeq }, result: promptSeq }
  })
}

export async function queueResume(
  io: WorkflowIo, rawText: string, makeTurnId: () => Promise<string>,
): Promise<'submitted' | 'queued'> {
  const text = rawText.trim()
  if (!text) throw new Error('clm.resume text must not be empty')
  const activeTurn = (await io.read()).activeTurnId
  await io.change(current => ({ next: { ...current, resumeRequest: { text } }, result: undefined }))
  return activeTurn === null ? arbitrateContinuation(io, await makeTurnId()) : 'queued'
}

export type MainTurnCompletionIo = {
  showChanges(answer: string): void
  maybeClear(): Promise<void>
  arbitrate(turnId: string): Promise<unknown>
  clearActiveTurn(turnId: string): Promise<void>
  log(message: string): void
}

export async function markActiveTurn(io: Pick<WorkflowIo, 'change' | 'log'>, turnId: string): Promise<void> {
  try {
    await io.change(current => ({ next: { ...current, activeTurnId: turnId }, result: undefined }))
  } catch (err) {
    io.log(`clm: active turn state failed (${String(err).slice(0, 160)})`)
  }
}

export async function completeMainTurn(
  io: MainTurnCompletionIo, turnId: string, isAborted: boolean, answer: string,
): Promise<void> {
  try {
    io.showChanges(answer)
    await io.maybeClear()
  } catch (err) {
    io.log(`clm: fold failed, ${String(err).slice(0, 200)}`)
  }
  if (!isAborted) {
    try { await io.arbitrate(turnId) }
    catch (err) { io.log(`clm: continuation arbitration failed (${String(err).slice(0, 160)})`) }
  }
  try { await io.clearActiveTurn(turnId) }
  catch (err) { io.log(`clm: active turn clear failed (${String(err).slice(0, 160)})`) }
}

async function restoreContinuation(io: Pick<WorkflowIo, 'change'>, turnId: string, continuation: Continuation): Promise<void> {
  await io.change(current => ({ next: restoreFailedContinuation(current, turnId, continuation), result: undefined }))
}

export async function submitWithRecovery(
  submit: () => Promise<void>, restore: () => Promise<void>, log: (message: string) => void,
): Promise<boolean> {
  try {
    await submit()
    return true
  } catch (err) {
    try { await restore() }
    catch (restoreError) { log(`clm: continuation restore failed (${String(restoreError).slice(0, 160)})`) }
    log(`clm: continuation submit failed (${String(err).slice(0, 160)})`)
    return false
  }
}

async function submitContinuation(io: WorkflowIo, turnId: string, continuation: Continuation): Promise<boolean> {
  return submitWithRecovery(
    async () => {
      const submitted = await io.submit({ text: continuation.text })
      if (submitted.drop !== undefined) throw new Error(submitted.drop)
    },
    () => restoreContinuation(io, turnId, continuation),
    message => io.log(message),
  )
}

export async function arbitrateContinuation(io: WorkflowIo, turnId: string): Promise<'submitted' | 'queued'> {
  const continuation = await claimContinuation(io, turnId)
  if (!continuation) return 'queued'
  if ((await io.read()).activeTurnId !== null) {
    void submitContinuation(io, turnId, continuation)
    return 'queued'
  }
  return await submitContinuation(io, turnId, continuation) ? 'submitted' : 'queued'
}
