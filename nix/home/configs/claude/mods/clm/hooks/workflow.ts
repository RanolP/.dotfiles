import type { PromptOrigin } from 'claude-code'
import type { ClmWorkflow } from '../types'
import { describe, focusOf, issueId, isOpen, isRecord, snapshot, type FocusState, type Intent, type Issue, type Origin, type Payload, type TrackerEvent } from './tracker'

const emptyWorkflow = (): ClmWorkflow => ({
  later: [], resumeRequest: null, lastSubmittedTurn: null, activeTurnId: null,
  promptSeq: 0, focusAppliedSeq: 0, replayed: null,
})

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

export type LaterPop = { popped: ClmWorkflow['later'][number] } | { missing: 'empty' | number; size: number }
export async function popLater(io: WorkflowIo, number: number, defer: (run: () => Promise<void>) => void): Promise<LaterPop> {
  const taken = await io.change((current): { next: ClmWorkflow; result: LaterPop } => {
    const item = current.later[number - 1]
    if (!item) return { next: current, result: { missing: current.later.length ? number : 'empty', size: current.later.length } }
    return {
      next: { ...current, later: current.later.filter((_, i) => i !== number - 1), replayed: item.issue ? { issue: item.issue } : current.replayed },
      result: { popped: item },
    }
  })
  if (!('popped' in taken)) return taken
  const item = taken.popped
  const restore = () => io.change(current => ({
    next: {
      ...current, later: [...current.later.slice(0, number - 1), item, ...current.later.slice(number - 1)],
      replayed: item.issue && current.replayed?.issue === item.issue ? null : current.replayed,
    },
    result: undefined,
  }))
  defer(async () => {
    await submitWithRecovery(async () => {
      const result = await io.submit({ text: item.text, asUser: true })
      if (result.drop !== undefined) throw new Error(result.drop)
    }, restore, message => io.log(message))
  })
  return taken
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

export type WorkflowIo = {
  read: () => Promise<ClmWorkflow>
  change: <T>(change: (current: ClmWorkflow) => { next: ClmWorkflow; result: T }) => Promise<T>
  submit: (input: { text: string; asUser?: true }) => Promise<{ drop?: string }>
  log: (message: string) => void
}

export type ReplayIo = Pick<WorkflowIo, 'read' | 'change' | 'log'> & {
  captureOrigin(): Promise<Origin>
  readEvents(): Promise<TrackerEvent[]>
  serialize<T>(session: string, run: () => Promise<T>): Promise<T>
  compose(state: FocusState, intent: Intent, issues: readonly Issue[], createId: () => string): { payloads: Payload[]; next: FocusState }
  writeEvents(payloads: readonly Payload[], origin: Origin): Promise<TrackerEvent[]>
  syncPanel(origin: Origin, events: readonly TrackerEvent[]): Promise<void>
}

export async function reconcileReplay(io: ReplayIo): Promise<void> {
  const origin = await io.captureOrigin()
  await io.serialize(origin.session, async () => {
    const replayed = (await io.read()).replayed
    if (!replayed) return
    const events = await io.readEvents()
    const allIssues = snapshot(events)
    const issue = allIssues.find(item => item.id === replayed.issue && item.origin.session === origin.session)
    const state = focusOf(events, origin.session)
    if (issue && isOpen(issue) && state.stack.at(-1) !== issue.id) {
      const currentIssues = allIssues.filter(item => item.origin.session === origin.session)
      const lastSeq = events.filter(event => event.origin.session === origin.session).reduce((n, event) => Math.max(n, event.seq), 0)
      const intent: Intent = { intent: 'handoff', target: issue.id, title: null, rule: null, later: [], laterDrop: [] }
      const { payloads, next } = io.compose(state, intent, currentIssues, () => issueId(origin.session, lastSeq + 1))
      const written = await io.writeEvents([...payloads, { op: 'focus', stack: next.stack, pending: next.pending, intent: 'handoff' }], origin)
      for (const line of describe(written, allIssues)) io.log(line)
      if (payloads.length) await io.syncPanel(origin, written)
    }
    await io.change(current => current.replayed?.issue === replayed.issue
      ? { next: { ...current, replayed: null }, result: undefined }
      : { next: current, result: undefined })
  })
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
  reconcileReplay(): Promise<void>
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
    await io.reconcileReplay()
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
