import { mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, RenderPropsOf, SessionCompactInput, SessionCompactResult, SessionMessage, SessionStartInput, ToolCallInput, TurnCompleteInput } from 'claude-code'

import { boardHtml } from './board'
import { chooseContinuation, clmStatus, isHeld, resetUserWorkflow, removeQueueSnapshotTargets, restoreFailedContinuation, sessionIssues, submitWithRecovery, trackIssue, recallTranscriptAddress, residentLedgerText, TASK_TOOL } from './register'
import type { Held, Meta } from './register'
import { INTENT_SYSTEM } from './intent'
import type { ClmWorkflow } from '../types'

import { ageDecayPlan, fallbackLedger, instructionValues, LEDGER_COMPACT_SYSTEM, MERGE_SYSTEM, parseMerge, preserveInstructions, REVIEW_SYSTEM, SPLIT_MERGE_SYSTEM } from './ledger'
import { focusOf, parseLog, snapshot, toEvents, type Issue, type Payload } from './tracker'
import { fingerprint } from './fold'

export const M = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
  ({ ...extra, role, text, toolUses: extra.toolUses ?? [] } satisfies SessionMessage)
export const intentReply = (fields: Record<string, unknown> = {}) => JSON.stringify({
  intent: 'continue', target: null, title: null, rule: null, later: [], laterDrop: [], raised: [], resolved: [], ...fields,
})
export const use = (id: string, tool: string) => M('assistant', '', { toolUses: [{ tool_use_id: id, tool, input: { id }, text: 'ok' }] })
export const res = (id: string, text: string) => M('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] })
export const BIG = 'x'.repeat(4000) // ~1000 tokens
export const MID = 'y'.repeat(800) // ~200 tokens

// ~2250 estimated tokens over four turns. With a 1200-token tail target the
// newest two turns fit and the first request's tool work plus "now fix it" fold.
export const ROWS = [
  M('user', 'please investigate the build'), use('tu_a', 'Bash'), res('tu_a', 'log: make fails at a.ts:12 ' + BIG), M('assistant', 'make fails at a.ts:12'),
  M('user', 'now fix it'), use('tu_b', 'Edit'), res('tu_b', 'edited ' + MID), M('assistant', 'fixed a.ts:12'),
  M('user', 'run tests'), use('tu_c', 'Bash'), res('tu_c', 'pass: all 12 tests passed ' + BIG), M('assistant', 'tests pass'),
  M('user', 'commit it'), M('assistant', 'done'),
]
// The merge model writes 목표 and an <ops> array; facts arrive as fact ops,
// clm keeps 사용자 지시 itself and the tracker renders the other three. Every
// fact and done claim here cites the first tool result of ROWS ("log: ..."),
// which tests not about evidence rely on to pass the mechanical check.
export const CITE = [{ ref: 'tu_a', quote: 'log: make fails at' }]
export const ledger = (fact: string, ops = '[]', cite = CITE) =>
  `## 목표\n- -\n\n<ops>${JSON.stringify([{ op: 'fact', text: fact, evidence: cite }, ...JSON.parse(ops).map((o: any) => (o.status === 'done' && !o.evidence ? { ...o, evidence: cite } : o))])}</ops>`
export const splitAnswer = (split = 2, topic = 'build', summary = 'build summary', note = 'build summary') => JSON.stringify({
  split, notes: `## 목표\n- ${note}`, ops: [], topics: [{ topic, summary }],
})
export const compressedTopics = (topics: { topic: string; summary: string; seq: number }[]) => JSON.stringify({ topics })
export const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } satisfies TurnCompleteInput
export const OPTS = { options: { budget: 2000, tailTarget: 1200, reserve: 100, queueTarget: 100000 } }
export const LEDGER_FILE = '/home/t/.claude-work/plans/clm-s1.md'
export const LOG_FILE = '/home/t/.claude-work/plans/clm-s1.log.jsonl'
export const storedLedger = (seen: { files: Record<string, string> }) => seen.files[LEDGER_FILE] ?? ''
export const ids = (m: any) => [...m.toolUses.map((u: any) => u.tool_use_id), ...(m.toolResults ?? []).map((r: any) => r.tool_use_id)]
export const est = (m: any) => Math.ceil((m.text.length + m.toolUses.reduce((k: number, u: any) => k + JSON.stringify(u.input).length + u.tool.length, 0) + (m.toolResults ?? []).reduce((k: number, x: any) => k + x.text.length, 0)) / 4)
export const shape = (out: any[]) => out.map((m: any) => m.text || ids(m).join())
export const handled = (rows: readonly SessionMessage[]): SessionMessage[] => rows.map((m, i) => ({ ...m, handle: `h${i}` } satisfies SessionMessage))
export const compactInput = (trigger: SessionCompactInput['trigger'], messages: readonly SessionMessage[], extra: Pick<SessionCompactInput, 'agentId' | 'instructions'> = {}) =>
  ({ ...extra, trigger, messages } satisfies SessionCompactInput)
export const promptInput = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false } satisfies PromptSubmitInput)
export const turnInput = (turnId: string, extra: Partial<TurnCompleteInput> = {}) => ({ ...TURN, ...extra, turnId } satisfies TurnCompleteInput)
export const commandInput = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } satisfies CommandRunInput)
export const compactedMessages = (result: SessionCompactResult): readonly SessionMessage[] => {
  if (!('messages' in result)) throw new Error('compaction returned no messages')
  return result.messages
}
export const workflow = (fields: Partial<ClmWorkflow> = {}): ClmWorkflow => ({
  later: [], resumeRequest: null, lastSubmittedTurn: null, activeTurnId: null,
  promptSeq: 0, focusAppliedSeq: 0, replayed: null, ...fields,
})
export const heldIn = (seen: { store: Record<string, unknown> }): Held[] => {
  const value = seen.store['held:s1']
  return Array.isArray(value) ? value.filter(isHeld) : []
}
export const isMetaValue = (value: unknown): value is Meta => typeof value === 'object' && value !== null && 'seq' in value && typeof value.seq === 'number' && 'fails' in value && typeof value.fails === 'number'
export const metaIn = (seen: { store: Record<string, unknown> }): Meta => {
  const value = seen.store['ledger:s1']
  if (!isMetaValue(value)) throw new Error('ledger metadata is missing')
  return value
}

export type State = { rows: SessionMessage[]; agentRows?: Record<string, SessionMessage[]>; replies: (string | null | Error)[]; splitReplies?: (string | Error)[]; compressionReplies?: (string | Error)[]; splitBlock?: () => Promise<void>; mergeBlock?: () => Promise<void>; splitDelay?: number; turnReplies?: string[]; intentReplies?: (string | Error)[]; intentBlocks?: (() => Promise<void>)[]; usage?: any; mergeDelays?: number[]; reviewReplies?: (string | Error)[] }
export function bottoms(on: any, s: State) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-06T00:00:00Z') })
  const seen = { clock, store: {} as Record<string, unknown>, files: {} as Record<string, string>, prompts: [] as string[], splitPrompts: [] as string[], compressionPrompts: [] as string[], rewindPrompts: [] as string[], intentPrompts: [] as string[], submissions: [] as { text: string; asUser?: true }[], reviewPrompts: [] as string[], reviewMaxTokens: [] as number[], turnPrompts: [] as string[], logs: [] as string[], results: [] as SessionCompactResult[], taskCalls: [] as ToolCallInput[], engineCompactions: 0, engineInputs: [] as (readonly SessionMessage[])[] }
  on('store.get', (_$: any, e: any) => ({ value: seen.store[e.key] }))
  on('store.set', (_$: any, e: any) => { seen.store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete seen.store[e.key]; return { value: undefined } })
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', (_$: any, e: any) => ({ value: e.agentId === undefined ? s.rows : s.agentRows?.[e.agentId] ?? [] }))
  on('session.usage', () => ({ value: s.usage ?? { startedAt: 0, context: { window: 200000, tokens: 6000 }, rateLimits: [] } }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in seen.files || Object.keys(seen.files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$: any, e: any) => ({
    value: Object.keys(seen.files).filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/'))
      .map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: seen.files[f]!.length, mtimeMs: 0, isLink: false })),
  }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'rm') for (const path of e.argv.slice(e.argv.indexOf('--') + 1)) delete seen.files[path]
    return { value: { exitCode: 0, stdout: e.argv.includes('get-url') ? 'git@github.com:o/repo.git\n' : 'main\n', stderr: '' } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('fs.read', (_$: any, e: any) => ({ value: seen.files[e.path] }))
  on('fs.write', (_$: any, e: any) => { seen.files[e.path] = e.text; return { value: undefined } })
  // The merge call answers from s.replies, the turn-time change call from s.turnReplies.
  on('model.complete', async (_$: any, e: any) => {
    if (e.system === INTENT_SYSTEM) {
      seen.intentPrompts.push(e.prompt)
      const text = s.intentReplies?.shift() ?? intentReply()
      await s.intentBlocks?.shift()?.()
      if (text instanceof Error) return { value: { isAnswered: false, reason: text.message } }
      return { value: { isAnswered: true, text, usage: {} } }
    }
    if (e.system === REVIEW_SYSTEM) {
      seen.reviewPrompts.push(e.prompt)
      seen.reviewMaxTokens.push(e.maxTokens)
      // Unscripted, the reviewer accepts every claim the prompt lists.
      const text = s.reviewReplies?.shift() ?? JSON.stringify({ verdicts: [...e.prompt.matchAll(/"id":"((?:op|fact|drop|held)\d+)"/g)].map(m => ({ id: m[1], accept: true, reason: 'ok' })) })
      if (text instanceof Error) throw text
      return { value: { isAnswered: true, text, usage: {} } }
    }
    if (e.system === SPLIT_MERGE_SYSTEM) {
      seen.splitPrompts.push(e.prompt)
      if (s.splitBlock) await s.splitBlock()
      if (s.splitDelay) await clock.sleep(s.splitDelay)
      const text = s.splitReplies?.shift() ?? splitAnswer()
      if (text instanceof Error) throw text
      return { value: { isAnswered: true, text, usage: {} } }
    }
    if (e.system === LEDGER_COMPACT_SYSTEM) {
      seen.compressionPrompts.push(e.prompt)
      const text = s.compressionReplies?.shift() ?? compressedTopics([{ topic: 'build', summary: 'build summary', seq: 1 }])
      if (text instanceof Error) throw text
      return { value: { isAnswered: true, text, usage: {} } }
    }
    if (e.system !== MERGE_SYSTEM) {
      seen.turnPrompts.push(e.prompt)
      return { value: { isAnswered: true, text: s.turnReplies?.shift() ?? '<changes></changes>', usage: {} } }
    }
    seen.prompts.push(e.prompt)
    if (s.mergeBlock) await s.mergeBlock()
    const delay = s.mergeDelays?.shift()
    if (delay !== undefined) await clock.sleep(delay)
    const text = s.replies.shift()
    if (text instanceof Error) throw text
    return { value: text === null ? { isAnswered: false, reason: 'aborted' } : { isAnswered: true, text: text ?? '', usage: {} } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', (_$: any, e: any) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('prompt.submit', (_$: any, e: any) => {
    seen.submissions.push({ text: e.text, ...(e.origin?.asUser ? { asUser: true as const } : {}) })
    return { text: e.text, context: e.context }
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('turn.complete', async ($: any) => {
    return { text: '' }
  })
  // Stands for the engine summarizer: any call reaching it is a compaction clm failed to replace.
  on('session.compact', (_$: any, e: any) => { seen.engineCompactions++; seen.engineInputs.push(e.messages); return { messages: [M('user', 'ENGINE SUMMARY')] } })
  return seen
}
// The test asks the engine for a manual compaction after the turn hook runs.
export async function turnEnds($: any, s: State, seen: { results: SessionCompactResult[] }, answer = '') {
  await $.turn.complete({ ...TURN, answer })
  seen.results.push(await $.session.compact({ trigger: 'manual', messages: handled(s.rows) }))
}
export async function waitForPending(seen: { store: Record<string, unknown>; logs: string[]; splitPrompts: string[]; compressionPrompts: string[]; reviewPrompts: string[] }) {
  for (let i = 0; i < 2000 && !seen.store['pending:s1']; i++) await new Promise(resolve => setTimeout(resolve, 1))
  if (!seen.store['pending:s1']) throw new Error(`background fold did not write Pending; calls split=${seen.splitPrompts.length}, compress=${seen.compressionPrompts.length}, review=${seen.reviewPrompts.length}; recent logs: ${seen.logs.slice(-5).join(' | ')}`)
}
export const BG_OPTS = { options: { budget: 5000, tailTarget: 1200, queueTarget: 1, ledgerTarget: 300, reserve: 100 } }
export const logEvents = (seen: { files: Record<string, string> }) => (seen.files[LOG_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))


export type On = Parameters<TestBody>[1]
export type Seen = ReturnType<typeof bottoms>
export type PanelReply = { success: boolean; error?: string }
// Panel tasks numbered panel-1, panel-2, ...; each TaskUpdate is answered by `reply`.
export function panelHandlers(on: On, seen: Seen, reply: (taskId: string) => PanelReply = () => ({ success: true })) {
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => {
    seen.taskCalls.push(e)
    return { result: { task: { id: `panel-${++n}`, subject: e.subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => {
    seen.taskCalls.push(e)
    return { result: { taskId: e.taskId, updatedFields: [], ...reply(e.taskId) } }
  })
}
// Six model tasks, all completed, so 'done 1' is archived.
export async function sixDone($: Engine, on: On, seen: Seen) {
  panelHandlers(on, seen)
  for (let i = 1; i <= 6; i++) await $.tool.call({ tool: 'TaskCreate', subject: `done ${i}`, description: `d${i}` })
  for (let i = 1; i <= 6; i++) await $.tool.call({ tool: 'TaskUpdate', taskId: `panel-${i}`, status: 'completed' })
}
export const storedOverhead = (v: unknown): Meta['overhead'] =>
  typeof v === 'object' && v !== null && 'overhead' in v && typeof v.overhead === 'number' ? v.overhead : undefined


export const NOTE_REPLY = '## 목표\n- g\n\n'

// Escape-path rows: the oldest turn's tool result is the only thing that can be withheld.
export const ESCAPE_ROWS = [
  M('user', 'start'), M('user', 'a'), use('tu_a', 'Bash'), res('tu_a', 'r'.repeat(4000)), M('assistant', 'A'.repeat(2000)),
  M('user', 'b'), M('assistant', 'B'.repeat(2200)), M('user', 'go'), M('assistant', 'w'.repeat(2200)),
]
export const WITHHELD_FILE = '/home/t/.claude-work/plans/clm-s1.withheld-0-tu_a.txt'


export const section = (ledgerText: string, name: string) => new RegExp(`## ${name}\n([\\s\\S]*?)(\n\n|$)`).exec(ledgerText)?.[1] ?? ''
// The PR #<pr> incident: the assistant recommended closing the PR, the only tool result showed it OPEN, and the ledger recorded it closed.
export const PR_ROWS = [
  M('user', 'check PR #<pr> and close it if it is stale'), use('tu_pr', 'Bash'), res('tu_pr', 'PR <pr> state: OPEN ' + BIG), M('assistant', 'I recommend closing PR #<pr>; closed it.'),
  ...ROWS.slice(4),
]


export const TRACKER = '/home/t/.claude-work/tracker/events/s1.jsonl'
export function seedTracker(seen: { files: Record<string, string> }, payloads: Payload[]) {
  const events = toEvents(payloads, { session: 's1', repo: 'github.com/o/repo', cwd: '/work/repo' }, 0, '2026-10-06T00:00:00.000Z')
  seen.files[TRACKER] = `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}
// --- quote matching, drops, directive noise, KST ------------------------------

export const issueAt = (issues: readonly { id: string }[], n: number): string => {
  const issue = issues[n]
  if (!issue) throw new Error(`no issue at ${n}; the tracker holds ${issues.length}`)
  return issue.id
}

// Regression caught: a quote copied from a clipped tool result kept the clip's `…`, or came from text past the clip, and was rejected, so 핵심 사실·경로 stayed empty.

export const runClm = ($: { command: { run(e: { command: string; args: string }): Promise<unknown> } }, args: string) => $.command.run({ command: 'clm', args })
export const LATER_BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: { offset: 0, bodyRows: 8 }, view: {},
}

export const waitForLog = async (seen: { logs: string[] }, message: string) => {
  for (let i = 0; i < 50 && !seen.logs.includes(message); i++)
    await new Promise(resolve => setTimeout(resolve, 5))
}
