import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, RenderPropsOf, SessionCompactInput, SessionCompactResult, SessionMessage, SessionStartInput, ToolCallInput, TurnCompleteInput } from 'claude-code'

import { boardHtml } from './board'
import { chooseContinuation, clmStatus, isHeld, resetUserWorkflow, removeQueueSnapshotTargets, restoreFailedContinuation, sessionIssues, STEP_SYSTEM, submitWithRecovery, trackIssue, recallTranscriptAddress, residentLedgerText } from './register'
import type { Held, Meta } from './register'
import { INTENT_SYSTEM } from './intent'
import type { ClmWorkflow } from '../types'

import { ageDecayPlan, fallbackLedger, instructionValues, LEDGER_COMPACT_SYSTEM, MERGE_SYSTEM, parseMerge, preserveInstructions, REVIEW_SYSTEM, SPLIT_MERGE_SYSTEM } from './ledger'
import { focusOf, parseLog, snapshot, toEvents, type Issue } from './tracker'
import { fingerprint } from './fold'

const M = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
  ({ ...extra, role, text, toolUses: extra.toolUses ?? [] } satisfies SessionMessage)
const intentReply = (fields: Record<string, unknown> = {}) => JSON.stringify({
  intent: 'continue', target: null, title: null, rule: null, later: [], laterDrop: [], raised: [], resolved: [], ...fields,
})
const use = (id: string, tool: string) => M('assistant', '', { toolUses: [{ tool_use_id: id, tool, input: { id }, text: 'ok' }] })
const res = (id: string, text: string) => M('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] })
const BIG = 'x'.repeat(4000) // ~1000 tokens
const MID = 'y'.repeat(800) // ~200 tokens

// ~2250 estimated tokens over four turns. With a 1200-token tail target the
// newest two turns fit and the first request's tool work plus "now fix it" fold.
const ROWS = [
  M('user', 'please investigate the build'), use('tu_a', 'Bash'), res('tu_a', 'log: make fails at a.ts:12 ' + BIG), M('assistant', 'make fails at a.ts:12'),
  M('user', 'now fix it'), use('tu_b', 'Edit'), res('tu_b', 'edited ' + MID), M('assistant', 'fixed a.ts:12'),
  M('user', 'run tests'), use('tu_c', 'Bash'), res('tu_c', 'pass: all 12 tests passed ' + BIG), M('assistant', 'tests pass'),
  M('user', 'commit it'), M('assistant', 'done'),
]
// The merge model writes 목표 and an <ops> array; facts arrive as fact ops,
// clm keeps 사용자 지시 itself and the tracker renders the other three. Every
// fact and done claim here cites the first tool result of ROWS ("log: ..."),
// which tests not about evidence rely on to pass the mechanical check.
const CITE = [{ ref: 'tu_a', quote: 'log: make fails at' }]
const ledger = (fact: string, ops = '[]', cite = CITE) =>
  `## 목표\n- -\n\n<ops>${JSON.stringify([{ op: 'fact', text: fact, evidence: cite }, ...JSON.parse(ops).map((o: any) => (o.status === 'done' && !o.evidence ? { ...o, evidence: cite } : o))])}</ops>`
const splitAnswer = (split = 2, topic = 'build', summary = 'build summary', note = 'build summary') => JSON.stringify({
  split, notes: `## 목표\n- ${note}`, ops: [], topics: [{ topic, summary }],
})
const compressedTopics = (topics: { topic: string; summary: string; seq: number }[]) => JSON.stringify({ topics })
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } satisfies TurnCompleteInput
const OPTS = { options: { budget: 2000, tailTarget: 1200, reserve: 100, queueTarget: 100000 } }
const LEDGER_FILE = '/home/t/.claude-work/plans/clm-s1.md'
const LOG_FILE = '/home/t/.claude-work/plans/clm-s1.log.jsonl'
const storedLedger = (seen: { files: Record<string, string> }) => seen.files[LEDGER_FILE] ?? ''
const ids = (m: any) => [...m.toolUses.map((u: any) => u.tool_use_id), ...(m.toolResults ?? []).map((r: any) => r.tool_use_id)]
const est = (m: any) => Math.ceil((m.text.length + m.toolUses.reduce((k: number, u: any) => k + JSON.stringify(u.input).length + u.tool.length, 0) + (m.toolResults ?? []).reduce((k: number, x: any) => k + x.text.length, 0)) / 4)
const shape = (out: any[]) => out.map((m: any) => m.text || ids(m).join())
const handled = (rows: readonly SessionMessage[]): SessionMessage[] => rows.map((m, i) => ({ ...m, handle: `h${i}` } satisfies SessionMessage))
const compactInput = (trigger: SessionCompactInput['trigger'], messages: readonly SessionMessage[], extra: Pick<SessionCompactInput, 'agentId' | 'instructions'> = {}) =>
  ({ ...extra, trigger, messages } satisfies SessionCompactInput)
const promptInput = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false } satisfies PromptSubmitInput)
const turnInput = (turnId: string, extra: Partial<TurnCompleteInput> = {}) => ({ ...TURN, ...extra, turnId } satisfies TurnCompleteInput)
const commandInput = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } satisfies CommandRunInput)
const compactedMessages = (result: SessionCompactResult): readonly SessionMessage[] => {
  if (!('messages' in result)) throw new Error('compaction returned no messages')
  return result.messages
}
const workflow = (fields: Partial<ClmWorkflow> = {}): ClmWorkflow => ({
  later: [], resumeRequest: null, lastSubmittedTurn: null, activeTurnId: null,
  promptSeq: 0, focusAppliedSeq: 0, replayed: null, ...fields,
})
const heldIn = (seen: { store: Record<string, unknown> }): Held[] => {
  const value = seen.store['held:s1']
  return Array.isArray(value) ? value.filter(isHeld) : []
}
const isMetaValue = (value: unknown): value is Meta => typeof value === 'object' && value !== null && 'seq' in value && typeof value.seq === 'number' && 'fails' in value && typeof value.fails === 'number'
const metaIn = (seen: { store: Record<string, unknown> }): Meta => {
  const value = seen.store['ledger:s1']
  if (!isMetaValue(value)) throw new Error('ledger metadata is missing')
  return value
}

type State = { rows: SessionMessage[]; replies: (string | null | Error)[]; splitReplies?: (string | Error)[]; compressionReplies?: (string | Error)[]; splitBlock?: () => Promise<void>; splitDelay?: number; turnReplies?: string[]; intentReplies?: (string | Error)[]; intentBlocks?: (() => Promise<void>)[]; stepReplies?: string[]; stepDelay?: number; usage?: any; mergeDelays?: number[]; reviewReplies?: (string | Error)[] }
function bottoms(on: any, s: State) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-06T00:00:00Z') })
  const seen = { clock, store: {} as Record<string, unknown>, files: {} as Record<string, string>, prompts: [] as string[], splitPrompts: [] as string[], compressionPrompts: [] as string[], rewindPrompts: [] as string[], intentPrompts: [] as string[], submissions: [] as { text: string; asUser?: true }[], reviewPrompts: [] as string[], reviewMaxTokens: [] as number[], turnPrompts: [] as string[], stepPrompts: [] as string[], logs: [] as string[], results: [] as SessionCompactResult[], taskCalls: [] as ToolCallInput[], engineCompactions: 0, engineInputs: [] as (readonly SessionMessage[])[] }
  on('store.get', (_$: any, e: any) => ({ value: seen.store[e.key] }))
  on('store.set', (_$: any, e: any) => { seen.store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete seen.store[e.key]; return { value: undefined } })
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: s.rows }))
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
      if (text instanceof Error) throw text
      return { value: { isAnswered: true, text, usage: {} } }
    }
    if (e.system === STEP_SYSTEM) {
      seen.stepPrompts.push(e.prompt)
      if (s.stepDelay) await clock.sleep(s.stepDelay)
      return { value: { isAnswered: true, text: s.stepReplies?.shift() ?? '<ops>[]</ops>', usage: {} } }
    }
    if (e.system === REVIEW_SYSTEM) {
      seen.reviewPrompts.push(e.prompt)
      seen.reviewMaxTokens.push(e.maxTokens)
      // Unscripted, the reviewer accepts every claim the prompt lists.
      const text = s.reviewReplies?.shift() ?? JSON.stringify({ verdicts: [...e.prompt.matchAll(/"id":"((?:op|fact|step|held)\d+)"/g)].map(m => ({ id: m[1], accept: true, reason: 'ok' })) })
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
async function turnEnds($: any, s: State, seen: { results: SessionCompactResult[] }, answer = '') {
  await $.turn.complete({ ...TURN, answer })
  seen.results.push(await $.session.compact({ trigger: 'manual', messages: handled(s.rows) }))
}
async function waitForPending(seen: { store: Record<string, unknown>; logs: string[]; splitPrompts: string[]; compressionPrompts: string[]; reviewPrompts: string[] }) {
  for (let i = 0; i < 2000 && !seen.store['pending:s1']; i++) await new Promise(resolve => setTimeout(resolve, 1))
  if (!seen.store['pending:s1']) throw new Error(`background fold did not write Pending; calls split=${seen.splitPrompts.length}, compress=${seen.compressionPrompts.length}, review=${seen.reviewPrompts.length}; recent logs: ${seen.logs.slice(-5).join(' | ')}`)
}
const BG_OPTS = { options: { budget: 5000, tailTarget: 1200, queueTarget: 1, ledgerTarget: 300, reserve: 100 } }
const logEvents = (seen: { files: Record<string, string> }) => (seen.files[LOG_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))

// Regression caught: the time-budget noun could not create, update, filter, or reject cross-session tracker issues.
test('the clm noun tracks only this session\'s issues', OPTS, async ($, on) => {
  const files: Record<string, string> = {}
  const engine = {
    session: { id: async () => 'noun-test', cwd: async () => '/work/repo' },
    env: { get: async (name: string) => name === 'HOME' ? '/home/t' : undefined },
    fs: {
      exists: async (path: string) => path in files || Object.keys(files).some(file => file.startsWith(`${path}/`)),
      list: async (path: string) => Object.keys(files).filter(file => file.startsWith(`${path}/`))
        .map(file => ({ name: file.slice(path.length + 1), kind: 'file', size: files[file]?.length ?? 0, mtimeMs: 0, isLink: false })),
      read: async (path: string) => files[path] ?? '',
      write: async (path: string, text: string) => { files[path] = text },
    },
    process: { run: async (argv: string[]) => ({ exitCode: 0, stdout: argv.includes('get-url') ? 'git@github.com:o/repo.git\n' : 'main\n', stderr: '' }) },
    ui: { log: () => undefined, panes: async () => [] },
    tool: { call: async () => ({ result: { success: true, task: { id: 'panel-1' } } }) },
  }
  let error: unknown
  const created = await trackIssue(engine, { title: 'track me', status: 'doing' })
  expect(created.title).toBe('track me')
  expect(created.status).toBe('doing')
  const completed = await trackIssue(engine, { title: 'ignored', status: 'done', issue: created.id })
  expect(completed.status).toBe('done')
  expect((await sessionIssues(engine, { status: 'done' })).map(issue => issue.id)).toEqual([created.id])
  files['/home/t/.claude-work/tracker/events/s2.jsonl'] = `${JSON.stringify({
    ts: '2026-10-06T00:00:00.000Z', seq: 1, issue: 's2-1',
    origin: { session: 's2', repo: 'github.com/o/repo', cwd: '/work/repo' },
    op: 'create', title: 'foreign', status: 'doing',
  })}\n`
  try {
    await trackIssue(engine, { title: 'foreign', status: 'done', issue: 's2-1' })
  } catch (err) {
    error = err
  }
  expect(created.id).toBe('noun-tes-1')
  expect(error instanceof Error ? error.message : String(error)).toContain('does not belong')
})

// Regression: clm status omitted the queued follow-up or pending resume, or changed state while reading it.
test('the clm status noun reports its read-only session view', async () => {
  const workflow: ClmWorkflow = {
    later: [{ text: 'review the release' }], resumeRequest: { text: 'continue the audit' },
    lastSubmittedTurn: null, activeTurnId: 'turn-1', promptSeq: 0, focusAppliedSeq: 0, replayed: null,
  }
  const eventFile = '/home/t/.claude-work/tracker/events/status-session.jsonl'
  const events = [
    { ts: '2026-10-06T00:00:00.000Z', seq: 1, issue: 'status-s-1', origin: { session: 'status-session', repo: 'github.com/o/repo', cwd: '/work/repo' }, op: 'create', title: 'todo item', status: 'todo' },
    { ts: '2026-10-06T00:00:01.000Z', seq: 2, issue: 'status-s-2', origin: { session: 'status-session', repo: 'github.com/o/repo', cwd: '/work/repo' }, op: 'create', title: 'doing item', status: 'doing' },
    { ts: '2026-10-06T00:00:02.000Z', seq: 3, issue: 'status-s-3', origin: { session: 'status-session', repo: 'github.com/o/repo', cwd: '/work/repo' }, op: 'create', title: 'question item', status: 'question' },
    { ts: '2026-10-06T00:00:03.000Z', seq: 4, issue: 'status-s-4', origin: { session: 'status-session', repo: 'github.com/o/repo', cwd: '/work/repo' }, op: 'create', title: 'dropped item', status: 'dropped' },
    { ts: '2026-10-06T00:00:04.000Z', seq: 5, issue: 'status-s-5', origin: { session: 'status-session', repo: 'github.com/o/repo', cwd: '/work/repo' }, op: 'create', title: 'finished item', status: 'done' },
  ].map(event => JSON.stringify(event)).join('\n') + '\n'
  const engine = {
    state: {
      get: async (ref: { plugin: string; key: string }) => ({ value: ref.plugin === 'clm' && ref.key === 'workflow' ? workflow : undefined }),
    },
    store: {
      get: async (key: string) => key === 'ledger:status-session' ? { seq: 2, fails: 0, lastFoldAt: 1_791_926_400_000 } : undefined,
    },
    session: { id: async () => 'status-session' },
    env: { get: async () => '/home/t' },
    fs: {
      exists: async (path: string) => path === '/home/t/.claude-work/tracker/events' || path === eventFile,
      list: async (path: string) => path === '/home/t/.claude-work/tracker/events'
        ? [{ name: 'status-session.jsonl', kind: 'file' as const, size: events.length, mtimeMs: 1, isLink: false }]
        : [],
      read: async (path: string) => path === eventFile ? events : '',
    },
    ui: { log: () => undefined },
  } satisfies Parameters<typeof clmStatus>[0]

  expect(await clmStatus(engine)).toEqual({
    later: [{ text: 'review the release' }],
    resumeRequest: { text: 'continue the audit' },
    lastFoldAt: 1_791_926_400_000,
    ledgerPath: '/home/t/.claude-work/plans/clm-status-session.md',
    openIssues: 3,
  })
})

// Regression caught: a stale projected task id used to hide completion instead of relinking to a fresh task.
test('fold issues project to the task panel', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"clm 조사하기","status":"todo","note":"조사 메모"}]'), ledger('fact 2', '[{"op":"status","issue":"s1-1","status":"done"}]', [{ ref: 'tu_c', quote: 'all 12 tests passed' }])] }
  const seen = bottoms(on, s)
  let created = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    return { result: { task: { id: `panel-${++created}`, subject: e.subject } } }
  })
  let stale = true
  on('tool.call', { tool: 'TaskUpdate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    if (stale && e.taskId === 'panel-1') {
      stale = false
      return { result: { success: false, message: 'stale task id' }, isError: true }
    }
    return { result: { success: true, taskId: e.taskId, updatedFields: [] } }
  })
  await turnEnds($, s, seen)
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'complete the investigation'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'completed'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)
  const create = seen.taskCalls.find(c => c.tool === 'TaskCreate')
  const updates = seen.taskCalls.filter(c => c.tool === 'TaskUpdate')
  expect(create.subject).toBe('clm 조사하기')
  expect(create.description).toBe('조사 메모')
  expect(updates.some(u => u.taskId === 'panel-2' && u.status === 'completed')).toBe(true)
  expect(logEvents(seen).some(e => e.event === 'panel-relink')).toBe(true)
})

// Regression caught: every done issue of the session stayed in the ledger's 한 일 and on the task panel forever, so a long session's context filled with old completions.
test('a session with 8 done issues shows only the latest 5 in the ledger and panel', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact')] }
  const seen = bottoms(on, s)
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    return { result: { task: { id: `panel-${++n}`, subject: e.subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    return { result: { success: true, taskId: e.taskId, updatedFields: [] } }
  })
  for (let i = 1; i <= 8; i++) await $.tool.call({ tool: 'TaskCreate', subject: `done ${i}`, description: `d${i}` })
  for (let i = 1; i <= 8; i++) await $.tool.call({ tool: 'TaskUpdate', taskId: `panel-${i}`, status: 'completed' })
  const last = new Map<string, string>()
  for (const c of seen.taskCalls) if (c.tool === 'TaskUpdate' && c.status) last.set(c.taskId, c.status)
  expect([1, 2, 3].map(i => last.get(`panel-${i}`))).toEqual(['deleted', 'deleted', 'deleted'])
  expect([4, 5, 6, 7, 8].map(i => last.get(`panel-${i}`))).toEqual(Array(5).fill('completed'))
  await turnEnds($, s, seen)
  const done = /## 한 일\n([\s\S]*?)\n\n/.exec(seen.files[LEDGER_FILE] ?? '')?.[1] ?? ''
  expect(done.split('\n').map(l => /^- (done \d)/.exec(l)?.[1])).toEqual(['done 4', 'done 5', 'done 6', 'done 7', 'done 8'])
})

type On = Parameters<TestBody>[1]
type Seen = ReturnType<typeof bottoms>
type PanelReply = { success: boolean; error?: string }
// Panel tasks numbered panel-1, panel-2, ...; each TaskUpdate is answered by `reply`.
function panelHandlers(on: On, seen: Seen, reply: (taskId: string) => PanelReply = () => ({ success: true })) {
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
async function sixDone($: Engine, on: On, seen: Seen) {
  panelHandlers(on, seen)
  for (let i = 1; i <= 6; i++) await $.tool.call({ tool: 'TaskCreate', subject: `done ${i}`, description: `d${i}` })
  for (let i = 1; i <= 6; i++) await $.tool.call({ tool: 'TaskUpdate', taskId: `panel-${i}`, status: 'completed' })
}
const storedOverhead = (v: unknown): Meta['overhead'] =>
  typeof v === 'object' && v !== null && 'overhead' in v && typeof v.overhead === 'number' ? v.overhead : undefined

// Regression caught: the merge model never saw archived done issues, re-created them from the folded turns, and each duplicate pushed a real recent completion off the ledger and panel.
test('a fold over turns that finished an archived issue creates no duplicate done issue', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"done 1","status":"done","note":"again"}]')] }
  const seen = bottoms(on, s)
  await sixDone($, on, seen)
  await turnEnds($, s, seen)
  expect(seen.prompts[0]).toContain('<finished_earlier>\n- done 1\n</finished_earlier>')
  const done = /## 한 일\n([\s\S]*?)\n\n/.exec(seen.files[LEDGER_FILE] ?? '')?.[1] ?? ''
  expect(done.split('\n').map(l => /^- (done \d)/.exec(l)?.[1])).toEqual(['done 2', 'done 3', 'done 4', 'done 5', 'done 6'])
  expect(seen.files[LEDGER_FILE]).not.toContain('<finished_earlier>')
})

// Regression caught: a TaskUpdate answered with success: false and no isError counted as success, so a missing panel task was never relinked.
test('a TaskUpdate answered success false relinks the issue to a new panel task', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen, id => (id === 'panel-1' ? { success: false, error: 'Task not found' } : { success: true }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'lost task', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 'panel-1', status: 'in_progress' })
  expect(seen.taskCalls.filter(c => c.tool === 'TaskCreate').map(c => c.subject)).toEqual(['lost task', 'lost task'])
  expect(seen.taskCalls.some(c => c.tool === 'TaskUpdate' && c.taskId === 'panel-2' && c.status === 'in_progress')).toBe(true)
  expect(logEvents(seen).some(e => e.event === 'panel-relink' && e.reason.includes('Task not found'))).toBe(true)
})

// Regression caught: a completed TaskUpdate notice was delayed until session.compact and then could be repeated by the pending fold.
test('a TaskUpdate to completed logs its notice before any fold and is not repeated', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [] }
  const seen = bottoms(on, s)
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => ({ result: { task: { id: 'panel-1', subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$: any, e: any) => ({ result: { success: true, taskId: e.taskId, updatedFields: [] } }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'event task', description: 'created in the turn' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 'panel-1', status: 'completed' })
  expect(seen.logs.filter(l => l === "작업 'event task' 완수").length).toBe(1)
  await $.session.compact({ trigger: 'plugin', messages: handled(s.rows) })
  expect(seen.logs.filter(l => l === "작업 'event task' 완수").length).toBe(1)
})

// Regression caught: the model stays denied while clm centralizes its task change into tracker and panel writes.
test('model task calls are denied outside clm projection', OPTS, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    return { result: { task: { id: 'panel-1', subject: e.subject } } }
  })
  const r = await $.tool.call({ tool: 'TaskCreate', subject: 'model task', description: 'should be denied' })
  expect('deny' in r).toBe(true)
  expect(seen.taskCalls.some(c => c.tool === 'TaskCreate' && c.subject === 'model task')).toBe(true)
  expect(seen.logs).toContain("작업 'model task' 추가")
})

// Regression caught: a fold creating several issues re-entered the projection and created duplicate panel tasks.
test('several fold issues create one panel task each', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"A","status":"todo"},{"op":"create","title":"B","status":"done"},{"op":"create","title":"C","status":"todo"}]')] }
  const seen = bottoms(on, s)
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    return { result: { task: { id: `panel-${++n}`, subject: e.subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    return { result: { success: true, taskId: e.taskId, updatedFields: [] } }
  })
  await turnEnds($, s, seen)
  expect(seen.taskCalls.filter(c => c.tool === 'TaskCreate').map(c => c.subject)).toEqual(['A', 'B', 'C'])
  expect(seen.taskCalls.filter(c => c.tool === 'TaskUpdate').map(c => [c.taskId, c.status])).toEqual([['panel-2', 'completed']])
})

// Regression caught: a refused panel write blocked the fold or the tracker append.
test('a refused TaskCreate still lets the fold complete', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"clm 조사하기","status":"todo"}]')] }
  const seen = bottoms(on, s)
  on('tool.call', { tool: 'TaskCreate' }, () => ({ deny: 'refused in test' }))
  await turnEnds($, s, seen)
  expect(seen.results[0].messages[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(storedLedger(seen)).toContain('clm 조사하기')
  expect(seen.logs).toContain("작업 'clm 조사하기' 추가")
})

// Regression caught: a `<changes>` block in the merge reply leaked into the ledger notes or was announced as a 맥락 갱신 line at fold time.
test('a merge reply carrying a changes block folds without announcing it', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [`<changes>핵심 사실: 순서가 바뀐 응답</changes>\n\n${ledger('fact')}`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(storedLedger(seen)).toContain('fact')
  expect(seen.results[0].messages[1].text).not.toContain('<changes>')
  expect(seen.logs.some(l => l.startsWith('맥락 갱신: '))).toBe(false)
})

// Regression caught: the turn-time 맥락 갱신 lines were lost, capped above three, or leaked into the session transcript.
test('turn-time context changes show at most three display-only notices', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact')], turnReplies: ['<changes>핵심 사실: 브리지 재시작 시 키 유실 확인\n미결 질문 추가: ui.log가 --resume 후 남는지\n셋째\n넷째</changes>'] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen, 'finished')
  expect(seen.turnPrompts.length).toBe(1)
  expect(seen.logs).toContain('맥락 갱신: 핵심 사실: 브리지 재시작 시 키 유실 확인')
  expect(seen.logs).toContain('맥락 갱신: 미결 질문 추가: ui.log가 --resume 후 남는지')
  expect(seen.logs.filter(l => l.startsWith('맥락 갱신: ')).length).toBe(3)
  expect(seen.results[0].messages.some((m: { text?: string }) => m.text?.includes('맥락 갱신:'))).toBe(false)
})

// Regression caught: a merge reply without the optional changes block must still apply its ledger fold.
test('a merge without non-task changes still applies the fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(storedLedger(seen)).toContain('fact')
  expect(seen.logs.some(l => l.startsWith('맥락 갱신: '))).toBe(false)
})

// Regression caught: the automatic fold keeps the wrong rows (drops the request, keeps folded turns, or cuts between a tool_use and its tool_result).
test('over budget, a fold keeps [first request, ledger, newest turns] with tool pairs intact', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('a.ts:12 is the bad import')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out[0].text).toBe('please investigate the build')
  expect(out[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(section(out[1].text, 'learned')).toContain('a.ts:12 is the bad import')
  expect(storedLedger(seen)).toContain('a.ts:12 is the bad import')
  expect(shape(out.slice(2))).toEqual(['run tests', 'tu_c', 'tu_c', 'tests pass', 'commit it', 'done'])
  expect(out.some((m: any) => m.handle !== undefined)).toBe(false)
  expect(seen.prompts[0]).toContain('fixed a.ts:12')
  expect(seen.prompts[0]).not.toContain('tests pass')
  expect(seen.files[LEDGER_FILE]).toContain('## 핵심 사실·경로')
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: a second fold loses the first ledger (not fed back from the file) or stacks a second ledger row beside the first.
test('the ledger round-trips through its file and survives a second fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('FIRST-FACT'), ledger('SECOND-FACT', '[]', [{ ref: 'tu_c', quote: 'all 12 tests passed' }])] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const after1 = seen.results[0].messages
  // The stored transcript keeps the pre-fold chain in front of the live one.
  s.rows = [...ROWS, ...after1, M('user', 'add docs'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'docs added'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)
  expect(seen.prompts[1]).toContain('FIRST-FACT')
  const out = seen.results[1].messages
  expect(out.filter((m: any) => m.text.startsWith('[clm ledger')).length).toBe(1)
  expect(out[1].text).toMatch(/^\[clm ledger #2 · /)
  expect(section(out[1].text, 'learned')).toContain('SECOND-FACT')
  expect(storedLedger(seen)).toContain('SECOND-FACT')
  expect(out.map((m: any) => m.text).filter(Boolean)).toEqual(['please investigate the build', out[1].text, 'commit it', 'done', 'add docs', 'docs added', 'push', 'pushed'])
})

// Regression caught: a merged ledger missing a section replaces the memory anyway and silently drops that section.
test('a merged ledger without its 목표 header skips the fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['## 핵심 사실·경로\n- a heading the merge no longer writes\n\n<ops>[]</ops>'] }
  const seen = bottoms(on, s)
  const result: any = await $.session.compact(compactInput('manual', handled(ROWS)))
  expect(result.messages[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('요약 없이 접힘:')
  expect(logEvents(seen).map(e => e.event)).toEqual(['merge-invalid', 'merge-invalid', 'fallback', 'clear'])
})

// Regression caught: after a fold, reads include the pre-boundary transcript so totals double-count rows the model no longer sees; and /clm output lands in the model's transcript.
test('/clm prints the ledger, a budget line counting only post-boundary rows, and the last decisions', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('LEDGER-ONLY-FACT')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const after = seen.results[0].messages
  s.rows = [...ROWS, ...after]
  const r: any = await $.command.run(commandInput('clm'))
  expect(r.text).toBeUndefined()
  const text = seen.logs.at(-1)!
  const expected = after.reduce((n: number, m: any) => n + est(m), 0)
  expect(text.split('\n')[0]).toBe(`clm budget: ${expected}/2000 tokens (${Math.round(expected / 20)}%); escape at 1900, queue target 100000, tail target 1200, ledger target 300, ratio 1`)
  expect(text).toContain('LEDGER-ONLY-FACT')
  expect(text).toContain('"event":"clear"')
})

// Regression caught (guard 1): when the newest turn alone exceeds the tail target, the fold drops it too and the model loses the turn it is working on.
test('the tail keeps the newest turn even when that turn alone exceeds the tail target', OPTS, async ($, on) => {
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', 'HEAD' + 'z'.repeat(8000) + 'TAIL'), M('assistant', 'dumped')]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(shape(out.slice(2))).toEqual(['dump logs', 'tu_e', 'tu_e', 'dumped'])
})

// Regression caught: a pending plan found the newer of two identical prompts and deleted the rows between it and the planned boundary.
test('a pending fold keeps both identical tail prompts and the turn between them', OPTS, async ($, on) => {
  const rows = [
    M('user', 'start'), M('assistant', 'x'.repeat(9000)),
    M('user', 'old work'), M('assistant', 'x'.repeat(9000)),
    M('user', 'continue'), M('assistant', 'first continuation'),
    M('user', 'between'), M('assistant', 'middle result'),
    M('user', 'continue'), M('assistant', 'second continuation'),
    M('user', 'last'), M('assistant', 'done'),
  ]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out.filter((m: any) => m.text === 'continue').length).toBe(2)
  expect(shape(out)).toContain('between')
  expect(shape(out)).toContain('first continuation')
})

// Regression caught: summary work blocks the turn, or an engine trigger races it with a duplicate summary.
test('an engine trigger joins the turn-end summary and uses its single result', BG_OPTS, async ($, on) => {
  const rows = [M('user', 'protected request'), M('assistant', 'done'), M('user', 'finished topic'), M('assistant', 'A'.repeat(6000)), M('user', 'active topic'), M('assistant', 'working')]
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let summaryStarted = false
  const s: State = { rows, replies: [], splitBlock: () => { summaryStarted = true; return gate } }
  const seen = bottoms(on, s)
  let returned = false
  const turn = $.turn.complete(TURN).then(() => { returned = true })
  for (let i = 0; i < 50 && !summaryStarted; i++) await new Promise(resolve => setTimeout(resolve, 2))
  const returnedBeforeSummary = await Promise.race([turn.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))])
  const engineCompact = $.session.compact(compactInput('auto', handled(rows)))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.splitPrompts).toHaveLength(1)
  release()
  await turn
  const compacted = compactedMessages(await engineCompact)
  expect(summaryStarted).toBe(true)
  expect(returnedBeforeSummary).toBe(true)
  expect(seen.splitPrompts).toHaveLength(1)
  expect(seen.engineCompactions).toBe(0)
  expect(compacted[0]?.text).toBe('protected request')
  expect(compacted[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(compacted.slice(2)).toEqual(rows.slice(4))
})

// Regression caught: a changed A row let the swap delete turns the summary never saw.
test('a background plan whose A rows changed is discarded with rows untouched', BG_OPTS, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(6000)), M('user', 'active B'), M('assistant', 'B result')]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2)] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  s.rows[1] = M('user', 'A changed after summary')
  const unchanged = handled(s.rows)
  const result: any = await $.session.compact(compactInput('plugin', unchanged))
  expect(result.messages).toEqual(unchanged)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: a split between topics or a tail that cannot fit still produced a destructive plan.
test('a mid-topic split or tail overflow is rejected, retried once, then dropped', { options: { budget: 5000, tailTarget: 300, queueTarget: 1, ledgerTarget: 100, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(12000)), M('user', 'active B'), M('assistant', 'z'.repeat(6000))]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(1.5), splitAnswer(2)] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  for (let i = 0; i < 50 && !seen.logs.some(line => line.includes('split summary dropped')); i++) await new Promise(resolve => setTimeout(resolve, 2))
  expect(seen.splitPrompts).toHaveLength(2)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(seen.logs.some(line => line.includes('split summary dropped'))).toBe(true)
})

// Regression caught: applying a precomputed summary changed B after the model selected its split.
test('the applied background fold is head plus ledger plus B verbatim', BG_OPTS, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), use('tu_a', 'Bash'), res('tu_a', 'A'.repeat(6000)), M('assistant', 'A done'), M('user', 'active B'), use('tu_b', 'Edit'), res('tu_b', 'B result'), M('assistant', 'B done')]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2, 'B topic', 'B summary')], compressionReplies: [compressedTopics([{ topic: 'B topic', summary: 'B summary', seq: 1 }])] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const result: any = await $.session.compact(compactInput('plugin', handled(rows)))
  const expectedTail = rows.slice(5).map(({ handle: _handle, ...message }: any) => message)
  expect(result.messages[0].text).toBe('protected request')
  expect(result.messages[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(result.messages.slice(2)).toEqual(expectedTail)
  const clear = logEvents(seen).find(event => event.event === 'clear')!
  expect(typeof clear.summaryMs).toBe('number')
  expect(typeof clear.durationMs).toBe('number')
  expect(metaIn(seen).foldDurationsMs?.['1']).toBe(clear.durationMs)
})

// Regression caught: a ready fold replaced the transcript before its summary reached the escape threshold.
test('a ready fold waits below the escape threshold and swaps on the first crossing compaction', { options: { budget: 5000, tailTarget: 1200, queueTarget: 1, ledgerTarget: 300, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(6000)), M('user', 'active B'), M('assistant', 'B result')]
  const usage = (tokens: number) => ({ startedAt: 0, rateLimits: [], context: { window: 200000, tokens } })
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2)], usage: usage(4800) }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const belowThreshold = compactedMessages(await $.session.compact(compactInput('manual', handled(rows))))
  expect(belowThreshold).toEqual(handled(rows))
  expect(seen.store['pending:s1']).toBeDefined()

  s.usage = usage(4900)
  const crossed = compactedMessages(await $.session.compact(compactInput('auto', handled(rows))))
  expect(crossed[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(storedLedger(seen)).toContain('build summary')
  expect(seen.splitPrompts).toHaveLength(1)
})

// Regression caught: rewinding across a folded row kept claims from that branch or called the summary model again.
test('a rewind restores the newest snapshot before removed rows without another summary call', OPTS, async ($, on) => {
  const a = M('user', 'A remains in the active transcript')
  const c = M('user', 'C was folded and then rewound')
  const original = [M('user', 'protected request'), a, c, M('assistant', 'latest turn')]
  const snapshotA = [
    '## 목표\n- T1: A outcome', '## 사용자 지시\n- (none yet)', '## 한 일\n- (none yet)',
    '## 할 일\n- (none yet)', '## 미결 질문\n- (none yet)', '## 핵심 사실·경로\n- (none yet)',
  ].join('\n\n')
  const snapshotAC = snapshotA.replace('T1: A outcome', 'T1: A and C outcome')
  const s: State = { rows: [original[0]!, a, original[3]!], replies: [] }
  const seen = bottoms(on, s)
  seen.files[LEDGER_FILE] = snapshotAC
  seen.store['ledger:s1'] = { seq: 2, fails: 0 }
  seen.store['transcript-rows:s1:main'] = original.map(fingerprint)
  seen.store['ledger-snapshots:s1:main'] = [
    { seq: 1, coveredRows: [fingerprint(a)], ledger: snapshotA },
    { seq: 2, coveredRows: [fingerprint(a), fingerprint(c)], ledger: snapshotAC },
  ]

  const restored = compactedMessages(await $.session.compact(compactInput('plugin', handled(s.rows))))
  expect(restored.some(row => row.text.startsWith('[clm ledger #'))).toBe(true)
  expect(storedLedger(seen)).toContain('T1: A outcome')
  expect(seen.splitPrompts).toHaveLength(0)
  expect(seen.prompts).toHaveLength(0)
  expect(seen.compressionPrompts).toHaveLength(0)
})

// Regression caught: re-folding kept T1 at its old size or discarded an exact user instruction.
test('ledger recompression shrinks the old topic and preserves each user instruction verbatim', { options: { budget: 5000, tailTarget: 1200, queueTarget: 1, ledgerTarget: 150, reserve: 100 } }, async ($, on) => {
  const instruction = 'Keep the public API stable while changing the parser.'
  const oldSummary = 'T1 '.repeat(160)
  const oldLedger = `[clm ledger #1 · 2026-10-14 09:00 KST] Earlier turns of this session were folded into these notes by a Haiku summary (file: ${LEDGER_FILE}).\n\n## 목표\n- T1: ${oldSummary}\n\n## 사용자 지시\n- (none yet)\n\n## 한 일\n- (none yet)\n\n## 할 일\n- (none yet)\n\n## 미결 질문\n- (none yet)\n\n## 핵심 사실·경로\n- (none yet)`
  const rows = [M('user', 'protected request'), M('user', oldLedger), M('user', instruction), M('assistant', 'A complete'), M('user', 'continue with B'), M('assistant', 'B result')]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2, 'T2', 'new topic summary')], compressionReplies: [compressedTopics([
    { topic: 'T1', summary: 'T1 closed outcome', seq: 1 },
    { topic: 'T2', summary: 'new topic summary', seq: 2 },
  ])] }
  const seen = bottoms(on, s)
  seen.files[LEDGER_FILE] = oldLedger
  seen.store['ledger:s1'] = { seq: 1, fails: 0 }
  seen.store['topics:s1'] = [{ topic: 'T1', summary: oldSummary, seq: 1 }]
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const result: any = await $.session.compact(compactInput('plugin', handled(rows)))
  const ledgerRow = result.messages[1].text
  expect(seen.compressionPrompts).toHaveLength(1)
  expect(storedLedger(seen)).toContain('T1:')
  expect(ledgerRow).toContain('T1: T1 closed outcome')
  expect(ledgerRow).not.toContain(oldSummary)
  expect(est(result.messages[1])).toBeLessThanOrEqual(150)
  expect(instructionValues(storedLedger(seen))).toContain(instruction)
})

// Regression caught (guards 2 and 6): a fold cut the tool result of the newest turn while that command was still in progress.
test('an oversized result in an older kept turn is cut while the newest turn stays whole', { options: { budget: 5000, tailTarget: 3000, reserve: 100 } }, async ($, on) => {
  const olderResult = 'HEAD' + 'z'.repeat(16000) + 'TAIL'
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', olderResult), M('assistant', 'dumped'), M('user', 'ok'), M('assistant', 'ok')]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  const result = out.find((m: any) => m.toolResults?.[0]?.tool_use_id === 'tu_e').toolResults[0].text
  expect(result.startsWith('HEAD')).toBe(true)
  expect(result.endsWith('TAIL')).toBe(true)
  expect(result).toMatch(new RegExp(`…\\[clm: \\d+ of ${olderResult.length} chars cut at fold time\\]…`))
  expect(result.length).toBeLessThan(4 * 1200)
  expect(storedLedger(seen)).toContain('- 출력 과다: Bash {"id":"tu_e"}')
  expect(logEvents(seen).map(e => e.event)).toContain('truncation')
  expect(out.find((m: any) => m.text === 'ok')).toBeDefined()
})

// Regression caught: oversize notes pile up in the ledger without bound across folds.
test('only the last five oversize notes stay in the ledger', OPTS, async ($, on) => {
  const old = ['a', 'b', 'c', 'd', 'e'].map(c => `- 출력 과다: Bash old-${c}`).join('\n')
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', 'z'.repeat(16000)), M('assistant', 'dumped'), M('user', 'ok'), M('assistant', 'ok')]
  const s: State = { rows, replies: [ledger('new fact')] }
  const seen = bottoms(on, s)
  // Oversize notes are harness lines: an earlier fold left five in the stored ledger.
  seen.files[LEDGER_FILE] = `## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- kept fact — quote: "log"\n${old}`
  await turnEnds($, s, seen)
  const notes = storedLedger(seen).split('\n').filter((l: string) => l.includes('출력 과다:'))
  expect(notes.length).toBe(5)
  expect(notes[0]).toContain('old-b')
  expect(notes[4]).toContain('tu_e')
  expect(storedLedger(seen)).toContain('kept fact')
})

// Regression caught (guard 3): a fold whose ledger outweighs the turns it drops makes the context bigger, and the next turn folds again.
test('a fold that would not shrink the context is skipped with both sizes logged', { options: { budget: 2000, tailTarget: 1990, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'start'), M('user', 'a'), M('assistant', 'A'), M('user', 'b'), M('assistant', 'B'), M('user', 'go'), M('assistant', 'w'.repeat(7600))]
  const s: State = { rows, replies: [ledger('p'.repeat(1700))] }
  const seen = bottoms(on, s)
  await $.session.compact(compactInput('manual', handled(rows)))
  expect(seen.store['pending:s1']).toBeUndefined()
  const line = seen.logs.find(l => l.includes('would not shrink'))!
  expect(line).toMatch(/\(\d+ -> \d+ est\. tokens\)/)
  const ev = logEvents(seen).find(e => e.event === 'skip-not-shrinking')
  expect(ev.tokensAfter).toBeGreaterThanOrEqual(ev.tokensBefore)
})

// Regression caught: an engine-requested compaction could not shrink the transcript after a malformed merge.
test('an engine manual compaction uses a mechanical ledger when the merge fails', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['bad'] }
  const seen = bottoms(on, s)
  const result: any = await $.session.compact(compactInput('manual', handled(ROWS)))
  const row = result.messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(section(row, '핵심 사실·경로')).toBe('')
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('요약 없이 접힘:')
  expect(logEvents(seen).map(e => e.event)).toEqual(['merge-invalid', 'merge-invalid', 'fallback', 'clear'])
})

// Regression caught: system prompt tokens in usage must not block a queue-triggered background summary.
test('queueTarget schedules the background fold independently of the usage reading', { options: { budget: 5000, tailTarget: 3000, queueTarget: 1, ledgerTarget: 600, reserve: 100 } }, async ($, on) => {
  const rows = ROWS
  const usage = (tokens: number) => ({ startedAt: 0, rateLimits: [], context: { window: 200000, tokens } })
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2)], usage: usage(6000) }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  expect(metaIn(seen).ratio).toBeUndefined()
  expect(seen.store['pending:s1']).toBeDefined()
})

// Regression caught: system usage alone scheduled a summary while the queue stayed below queueTarget.
test('a queue below queueTarget does not schedule a summary for a large usage reading', OPTS, async ($, on) => {
  // The 6000-token reading is mostly system prompt; the message queue stays below the configured 100000-token target.
  const s: State = { rows: ROWS.slice(4), replies: [ledger('x')], usage: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 6000 } } }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect(seen.prompts.length).toBe(0)
  expect(seen.store['pending:s1']).toBeUndefined()
  // A later usage baseline does not change the queue-size trigger.
  seen.store['ledger:s1'] = { seq: 1, fails: 0, overhead: 4800, ratio: 1 }
  await $.turn.complete(TURN)
  expect(seen.prompts.length).toBe(0)
})

// Regression caught: the usage reading from before a fold was read as current after it, so every later turn folded again.
test('a turn after a fold with an unchanged usage reading does not fold again', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('x'), ledger('y')], usage: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 6000 } } }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(seen.prompts.length).toBe(1)
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'ok'), M('assistant', 'fine')]
  await $.turn.complete(TURN)
  expect(seen.prompts.length).toBe(1)
  expect(seen.store['pending:s1']).toBeUndefined()
})

// Regression caught (guard 7): empty and "(no content)" rows carried into the rewritten transcript waste context and can be refused by the API.
test('empty and "(no content)" rows are dropped from the fold result', OPTS, async ($, on) => {
  const rows = [...ROWS.slice(0, 12), M('assistant', '(no content)'), M('assistant', ''), ...ROWS.slice(12)]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out.some((m: any) => m.text === '(no content)' || (m.text === '' && ids(m).length === 0))).toBe(false)
})

// Regression caught (guard 8): a fold or skip leaves nothing to diagnose it from after the fact.
test('every fold writes a JSONL decision line with sizes, kept turns and ratio', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const clear = logEvents(seen).find(e => e.event === 'clear')
  expect(Object.keys(clear).sort()).toEqual(['durationMs', 'event', 'keptTurns', 'ratio', 'reason', 'summaryMs', 'tokensAfter', 'tokensBefore', 'ts'])
  expect(clear.keptTurns).toBe(2)
  expect(clear.tokensAfter).toBeLessThan(clear.tokensBefore)
})

// Regression caught (guard 9): a budget under 2000 or a reserve over the budget is silently replaced and the user never learns the setting was ignored.
test('a bad option is logged with the value actually used', { options: { budget: 100, tailTarget: 50000, queueTarget: 0, ledgerTarget: 2000, reserve: 9999 } }, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true } satisfies SessionStartInput)
  expect(seen.logs).toContain('clm: option budget=100 must be an integer of at least 2000; using 2000')
  expect(seen.logs).toContain('clm: option tailTarget=50000 must be a positive integer under the budget (2000); using 1000')
  expect(seen.logs).toContain('clm: option queueTarget=0 must be a positive integer; using 8000')
  expect(seen.logs).toContain('clm: option ledgerTarget=2000 must be a non-negative integer under tailTarget (1000); using 250')
  expect(seen.logs).toContain('clm: option reserve=9999 must be a positive integer under the budget (2000); using 500')
})

// Regression caught: with no plan pending, the engine's threshold or a /compact runs its own summarizer and replaces the ledger with an engine summary.
test('auto compaction with no pending plan produces a clm ledger instead of an engine summary', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('INLINE-FACT'), 'not a ledger'] }
  const seen = bottoms(on, s)
  const auto = compactedMessages(await $.session.compact(compactInput('auto', handled(ROWS))))
  expect(auto[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(section(auto[1].text, 'learned')).toContain('INLINE-FACT')
  expect(storedLedger(seen)).toContain('INLINE-FACT')
  // A failed merge still folds, mechanically, rather than handing over to the engine.
  const manual = compactedMessages(await $.session.compact(compactInput('manual', handled([...auto, M('user', 'more'), use('tu_f', 'Bash'), res('tu_f', BIG), M('assistant', 'ok')]))))
  expect(manual[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(manual.some(m => m.text.startsWith('[clm ledger #2'))).toBe(false)
  expect(manual.some(m => m.text === 'ENGINE SUMMARY')).toBe(false)
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: a non-shrinking compaction job delegated a competing engine summary.
test('a non-shrinking auto job leaves the transcript unchanged after its escape attempt', { options: { budget: 2000, tailTarget: 1990, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'start'), M('user', 'a'), M('assistant', 'A'), M('user', 'b'), M('assistant', 'B'), M('user', 'go'), M('assistant', 'w'.repeat(7600))]
  const s: State = { rows, replies: [ledger('p'.repeat(1700))] }
  const seen = bottoms(on, s)
  const r = await $.session.compact({ trigger: 'auto', messages: handled(rows) })
  if (!('messages' in r)) throw new Error('compaction returned no messages')
  expect(r.messages?.map(m => m.text)).toEqual(rows.map(m => m.text))
  expect(seen.engineCompactions).toBe(0)
  expect(logEvents(seen).find(e => e.event === 'escape')).toBeDefined()
})

const NOTE_REPLY = '## 목표\n- g\n\n'

// Regression caught: a merge withdrawing an instruction the user never gave was counted as valid, or a reply without 사용자 지시 was refused.
test('a withdraw naming no current instruction is rejected and a reply without instructions is accepted', async () => {
  const ok = parseMerge(NOTE_REPLY + '<ops>[]</ops>', new Set(), 1000, ['old'])
  expect(typeof ok === 'string' ? ok : ok.withdrawn).toEqual([])
  const r = parseMerge(NOTE_REPLY + '<ops>[{"op":"withdraw","instruction":"never said"},{"op":"withdraw","instruction":"old"}]</ops>', new Set(), 1000, ['old'])
  if (typeof r === 'string') throw new Error(r)
  expect(r.withdrawn).toEqual(['old'])
  expect(r.rejected).toBe(1)
})

// Regression caught: a long instruction was truncated before the model could retrieve its source.
test('a long instruction remains whole behind its transcript address', async () => {
  const prompt = 'line one\n' + 'x'.repeat(2100)
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- f'
  const dropped = [M('user', prompt)]
  const first = preserveInstructions(fallbackLedger(prev, dropped), [], dropped, '/ledger.md')
  expect(first.notes).toContain(JSON.stringify(prompt))
  expect(first.fullNotes.split(JSON.stringify(prompt)).length).toBe(2)
  // The next fold reads the file's values back as prior; the same prompt dropped again stays one line.
  const again = preserveInstructions(first.fullNotes, [prompt], dropped, '/ledger.md')
  expect(again.fullNotes.split(JSON.stringify(prompt)).length).toBe(2)
  expect(again.notes.split(JSON.stringify(prompt)).length).toBe(2)
})

// Regression caught: the removed instruction cap hid older or newer directives from the address index source.
test('instruction preservation has no character cap', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- f'
  const old = Array.from({ length: 12 }, (_, i) => `old instruction ${i} ${'x'.repeat(24)}`)
  const out = preserveInstructions(prev, old, [M('user', 'newest correction')], '/ledger.md')
  expect(out.notes).toContain('- "newest correction"')
  expect(out.notes).toContain(JSON.stringify(old[0]))
  expect(out.notes).toContain(JSON.stringify(old[11]))
})

// Regression caught: a global prohibition given three folds ago silently dropped out of context while an unrelated task was focused.
test('a global prohibition stays indexed across folds and its address recalls the full transcript row', async () => {
  const full = 'Do not change generated files. Keep every existing lockfile byte-for-byte stable, including all metadata and ordering.'
  const rawRows = [
    JSON.stringify({ uuid: 'c130a62d-1111-4111-8111-111111111111', type: 'user', message: { role: 'user', content: full } }),
    JSON.stringify({ uuid: 'd230b7ef-2222-4222-8222-222222222222', parentUuid: 'c130a62d-1111-4111-8111-111111111111', type: 'assistant', message: { role: 'assistant', content: 'Understood.' } }),
    JSON.stringify({ uuid: 'e330c1ab-3333-4333-8333-333333333333', parentUuid: 'd230b7ef-2222-4222-8222-222222222222', type: 'user', message: { role: 'user', content: 'Fix the unrelated parser task.' } }),
  ]
  const top = {
    id: 's1-a', title: 'unrelated parser task', status: 'doing', origin: { session: 's1', repo: 'github.com/o/r', cwd: '/w' },
    notes: ['last parser note'], linked: [], updated: '2026-10-15T00:00:00Z',
  } satisfies Issue
  const row = residentLedgerText(top, '@e330c1ab', 2, 1, [
    { address: '@c130a62d', issue: null, text: full },
  ], new Set(['s1-a']))
  expect(row).toContain('unrelated parser task — last parser note @e330c1ab')
  expect(row).toContain(`${[...full].slice(0, 80).join('')} @c130a62d`)
  expect(row).not.toContain(full)
  expect(row).not.toContain('pending task title')
  expect(recallTranscriptAddress(rawRows.join('\n'), '@c130a62d')).toEqual({ text: rawRows[0] })
  expect(recallTranscriptAddress(rawRows.join('\n'), '@c130a62d..@e330c1ab')).toEqual({ text: rawRows.join('\n') })
})

// Regression caught: the compact row exposed every task instead of the six scoped sections.
test('the six-section ledger keeps actions under the focused task and requests global', async () => {
  const issue = (id: string, title: string, status: Issue['status'], parent?: string, notes: string[] = []) => ({
    id, title, status, ...(parent ? { parent } : {}), notes, linked: [],
    origin: { session: 's1', repo: 'github.com/o/r', cwd: '/w' }, updated: '2026-10-15T00:00:00Z',
  } satisfies Issue)
  const top = issue('s1-1', 'focused build', 'doing', undefined, ['last build note'])
  const child = issue('s1-2', 'run focused tests', 'todo', top.id)
  const unrelated = issue('s1-3', 'unrelated docs', 'todo')
  const uncertain = issue('s1-4', 'verify package checksum', 'uncertain', undefined, ['check the release digest'])
  const row = residentLedgerText(top, '@e330c1ab', 2, 1, [], new Set([top.id]), {
    where: ['Build verification: tests are next.'], children: [child, unrelated],
    requests: [{ id: 'R1', text: 'Rebuild the package.', quote: 'Please rebuild the package', status: 'open' }],
    constraints: ['- preserve generated outputs — quote: "build tool generated this file" @aabbccdd'],
    uncertain: [uncertain], learned: ['- the build tool failed once — quote: "exit code 1"'],
  })
  expect([...row.matchAll(/^## (.+)$/gm)].map(match => match[1])).toEqual([
    'where we are', 'what to do', 'what to request', 'constraints & preferences', 'uncertain', 'learned',
  ])
  expect(row).toContain('focused build — last build note @e330c1ab')
  expect(row).toContain('Build verification: tests are next.')
  expect(row).toContain('run focused tests')
  expect(row).not.toContain('unrelated docs')
  expect(row).toContain('[R1] Rebuild the package.')
  expect(row).toContain('preserve generated outputs')
  expect(row).toContain('verify package checksum — settling check: check the release digest')
  expect(row).toContain('the build tool failed once')
  expect(row).toContain('Stack size\n2\nPending count\n1')
})

// Regression caught: the merge model received B and moved it into the summary even though the swap keeps B verbatim.
test('the merge and review inputs exclude the verbatim tail after split selection', BG_OPTS, async ($, on) => {
  const rows = [
    M('user', 'protected request'),
    M('user', 'A completed topic'), M('assistant', `A summary source ${'A'.repeat(6000)}`),
    M('user', 'B active topic'), M('assistant', 'B-TAIL-ONLY secret details'),
  ]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2, 'A topic', 'A summary', 'A summary')] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const result = compactedMessages(await $.session.compact(compactInput('plugin', handled(rows))) as SessionCompactResult)
  expect(seen.splitPrompts[0]).toContain('B-TAIL-ONLY secret details')
  expect(seen.reviewPrompts[0]).toContain('A completed topic')
  expect(seen.reviewPrompts[0]).not.toContain('B-TAIL-ONLY secret details')
  expect(result.slice(2)).toEqual(rows.slice(3))
})

// Regression caught: an unverified constraint disappeared after the next fold because it was stored with decaying lessons.
test('a quoted tool constraint survives two folds without entering topic decay', OPTS, async ($, on) => {
  const first = `## 목표\n- build work\n\n<ops>${JSON.stringify([{ op: 'fact', kind: 'constraint', text: 'The build tool requires generated artifacts to stay checked in.', evidence: [{ ref: 'tu_a', quote: 'log: make fails at' }] }])}</ops>`
  const second = '## 목표\n- build work continues\n\n<ops>[]</ops>'
  const s: State = { rows: ROWS, replies: [first, second] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(section(seen.results[0].messages[1].text, 'constraints & preferences')).toContain('generated artifacts to stay checked in')
  const firstMessages = seen.results[0].messages
  s.rows = [...ROWS, ...firstMessages, ...ROWS.slice(4)]
  await turnEnds($, s, seen)
  expect(section(seen.results[1].messages[1].text, 'constraints & preferences')).toContain('generated artifacts to stay checked in')
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('[constraint] The build tool requires generated artifacts to stay checked in.')
})

// Regression caught: a done claim without verified evidence was shown as active work instead of awaiting verification.
test('an unevidenced done becomes uncertain with a settling check', OPTS, async ($, on) => {
  const ops = JSON.stringify([{ op: 'create', title: 'verify the package checksum', status: 'done' }])
  const s: State = { rows: ROWS, replies: [`## 목표\n- build summary\n\n<ops>${ops}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(snapshot(parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? '')).find(issue => issue.title === 'verify the package checksum')?.status).toBe('uncertain')
  expect(section(row, 'uncertain')).toContain('verify the package checksum — settling check: verify the claim')
})

// Regression caught: a new merge kept sending already-small old topics back to the model.
test('age decay leaves a floor-sized old topic untouched on the next merge', async () => {
  const topics = [
    { sourceTokens: 1000, currentTokens: 1000, floorTokens: 50, seq: 1 },
    { sourceTokens: 800, currentTokens: 800, floorTokens: 50, seq: 2 },
  ]
  const beforeC = ageDecayPlan(topics, 1300)
  expect(beforeC.targets[0]).toBe(500)
  expect(beforeC.targets[1]).toBe(800)
  expect(beforeC.rewrite).toEqual([0])

  const afterC = ageDecayPlan([...topics, { sourceTokens: 600, currentTokens: 600, floorTokens: 50, seq: 3 }], 1040)
  expect(afterC.targets[0]).toBeGreaterThanOrEqual(160)
  expect(afterC.targets[0]).toBeLessThanOrEqual(180)
  expect(afterC.targets[1]).toBeGreaterThanOrEqual(260)
  expect(afterC.targets[1]).toBeLessThanOrEqual(280)
  expect(afterC.targets[2]).toBe(600)

  const atFloor = ageDecayPlan([
    { sourceTokens: 1000, currentTokens: 100, floorTokens: 100, seq: 1 },
    { sourceTokens: 800, currentTokens: afterC.targets[1]!, floorTokens: 50, seq: 2 },
    { sourceTokens: 600, currentTokens: 600, floorTokens: 50, seq: 3 },
  ], 900)
  expect(atFloor.targets[0]).toBe(100)
  expect(atFloor.rewrite).not.toContain(0)
})

// Regression caught: a withdrawn instruction disappeared from the full ledger file along with the visible notes.
test('a withdrawn instruction stays in fullNotes as withdrawn but leaves visible notes', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- f'
  const out = preserveInstructions(prev, ['keep this', 'take this back'], [], '/ledger.md', ['take this back'])
  expect(out.notes).toContain('- "keep this"')
  expect(out.notes).not.toContain('take this back')
  expect(out.fullNotes).toContain('- (withdrawn) "take this back"')
})

// Regression caught: re-issuing a previously withdrawn instruction stayed hidden because withdrawal state was sticky.
test('a re-issued withdrawn instruction becomes visible in its newest slot', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- (withdrawn) "use tabs"\n\n## 핵심 사실·경로\n- f'
  const out = preserveInstructions(prev, instructionValues(prev), [M('user', 'use tabs')], '/ledger.md')
  expect(out.notes).toContain('- "use tabs"')
})

// Regression caught: a model TaskUpdate's subject and description were dropped silently, or an unknown task id got a deny that never said where the change belongs.
test('a model TaskUpdate records retitle and note, and an unknown id is sent to the reply text', OPTS, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => ({ result: { task: { id: 'panel-1', subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$: any, e: any) => ({ result: { success: true, taskId: e.taskId, updatedFields: [] } }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'event task', description: 'created' })
  const r = await $.tool.call({ tool: 'TaskUpdate', taskId: 'panel-1', subject: 'renamed task', description: 'more detail' })
  if (!('deny' in r)) throw new Error('model TaskUpdate was not denied')
  expect(r.deny).toContain('clm이 트래커에 기록했다')
  expect(r.deny).toContain('renamed task')
  expect(seen.logs).toContain("작업 'event task' 재조정 -> 'renamed task'")
  expect(seen.logs).toContain("작업 'renamed task' 메모: more detail")
  const unknown = await $.tool.call({ tool: 'TaskUpdate', taskId: 'nope', status: 'completed' })
  if (!('deny' in unknown)) throw new Error('unknown TaskUpdate was not denied')
  expect(unknown.deny).toContain('답변 본문에 적어라')
})

// Regression caught: two task calls in flight at once each read the log before the other wrote, and one issue was lost or both got the same id.
test('two concurrent model TaskCreate calls keep both issues with distinct ids', OPTS, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => ({ result: { task: { id: `panel-${++n}`, subject: e.subject } } }))
  await Promise.all([
    $.tool.call({ tool: 'TaskCreate', subject: 'first', description: '' }),
    $.tool.call({ tool: 'TaskCreate', subject: 'second', description: '' }),
  ])
  const issues = snapshot(parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? ''))
  expect(issues.map(i => i.title).sort()).toEqual(['first', 'second'])
  expect(new Set(issues.map(i => i.id)).size).toBe(2)
})

// Regression caught: instruction lines from a ledger written before JSON-quoted instructions failed to parse and were deleted for good on the first fold after the upgrade.
test('legacy free-form instruction lines survive preserveInstructions verbatim', async () => {
  const legacy = ['"headless only, no visible windows, no input events" (UI 검증)', 'PR 병합에 대해: "ㅇ 일단 다 머지하고 생각해보자"']
  const notes = `## 목표\n- g\n\n## 사용자 지시\n${legacy.map(l => `- ${l}`).join('\n')}\n- "quoted one"\n- [additional user instructions in /ledger.md]\n\n## 핵심 사실·경로\n- f`
  const out = preserveInstructions(notes, instructionValues(notes), [], '/ledger.md')
  expect(instructionValues(out.fullNotes)).toEqual([...legacy, 'quoted one'])
})

// Escape-path rows: the oldest turn's tool result is the only thing that can be withheld.
const ESCAPE_ROWS = [
  M('user', 'start'), M('user', 'a'), use('tu_a', 'Bash'), res('tu_a', 'r'.repeat(4000)), M('assistant', 'A'.repeat(2000)),
  M('user', 'b'), M('assistant', 'B'.repeat(2200)), M('user', 'go'), M('assistant', 'w'.repeat(2200)),
]
const WITHHELD_FILE = '/home/t/.claude-work/plans/clm-s1.withheld-0-tu_a.txt'

// Regression caught: on the escape path the retry fold dropped the row holding the withheld pointer, the merge saw only the pointer, and the prune deleted the file, losing the tool output with no record.
test('a tool result folded away on the escape path keeps its withheld file and a ledger pointer to it', OPTS, async ($, on) => {
  const s: State = { rows: ESCAPE_ROWS, replies: [new Error('merge down'), ledger('x')], usage: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 6000 } } }
  const seen = bottoms(on, s)
  const r = await $.session.compact({ trigger: 'auto', messages: handled(ESCAPE_ROWS) })
  if (!('messages' in r)) throw new Error('compaction returned no messages')
  expect(seen.engineCompactions).toBe(0)
  expect(seen.files[WITHHELD_FILE]).toBe('r'.repeat(4000))
  expect(storedLedger(seen)).toContain(`- 보존된 출력: ${WITHHELD_FILE}`)
  expect(seen.files[LEDGER_FILE]).toContain(`- 보존된 출력: ${WITHHELD_FILE}`)
  expect(r.messages?.some(m => m.toolResults?.some(x => x.tool_use_id === 'tu_a'))).toBe(false)
})

// Regression caught: the escape retry calibrated against the usage reading from before the results were withheld, inflating overhead so the next fold shrank the tail to one turn.
test('an escape retry leaves meta.overhead as it was', OPTS, async ($, on) => {
  const s: State = { rows: ESCAPE_ROWS, replies: [new Error('merge down'), ledger('x')], usage: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 6000 } } }
  const seen = bottoms(on, s)
  seen.store['ledger:s1'] = { seq: 0, fails: 0, overhead: 100, ratio: 1 }
  const r = await $.session.compact({ trigger: 'auto', messages: handled(ESCAPE_ROWS) })
  if (!('messages' in r)) throw new Error('compaction returned no messages')
  expect(seen.engineCompactions).toBe(0)
  expect(storedOverhead(seen.store['ledger:s1'])).toBe(100)
})

// Regression caught: when the merge failed twice, the escape retry delegated a second summary to the engine.
test('a failed escape retry stays inside the compaction job', OPTS, async ($, on) => {
  const s: State = { rows: ESCAPE_ROWS, replies: [new Error('merge down'), new Error('still down')] }
  const seen = bottoms(on, s)
  const messages = compactedMessages(await $.session.compact(compactInput('auto', handled(ESCAPE_ROWS))))
  expect(seen.engineCompactions).toBe(0)
  expect(messages.map(m => m.text)).toEqual(ESCAPE_ROWS.map(m => m.text))
  expect(messages.some(m => m.toolResults?.some(result => result.tool_use_id === 'tu_a'))).toBe(true)
  expect(seen.files[WITHHELD_FILE]).toBe('r'.repeat(4000))
})

// Regression caught: precompute invoked an extra summary, or a subagent compaction bypassed its transcript's clm job.
test('precompute skips and a subagent compaction uses its own clm job', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [] }
  const seen = bottoms(on, s)
  const r: any = await $.session.compact(compactInput('precompute', handled(ROWS)))
  expect(r.skip).toBe('clm replaces compaction')
  expect(seen.engineCompactions).toBe(0)
  expect(seen.prompts.length).toBe(0)
  // A subagent's own transcript is still the engine's to compact.
  const child = compactedMessages(await $.session.compact(compactInput('auto', handled(ROWS), { agentId: 'a1' })))
  expect(child[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: every ledger row showed the latest fold's duration, deferred time leaked into it, expanded rows were hidden, and ledger-like user text was intercepted.
test('each folded ledger renders its own compact duration and ledger-like user text passes through', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('FIRST-FACT'), ledger('FIRST-FACT; SECOND-FACT')], mergeDelays: [1200, 3400] }
  const seen = bottoms(on, s)
  let passed = 0
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    passed++
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.text] })
  })

  const firstCompact = $.session.compact({ trigger: 'manual', messages: handled(ROWS) })
  await seen.clock.settle()
  await seen.clock.advance(1200)
  const first = await firstCompact
  if (!('messages' in first)) throw new Error('first compaction returned no messages')
  const firstRow = first.messages.find((m: any) => m.text.startsWith('[clm ledger'))
  s.rows = [...ROWS, ...first.messages, M('user', 'add docs'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'docs added'), M('user', 'push'), M('assistant', 'pushed')]
  const secondCompact = $.session.compact({ trigger: 'manual', messages: handled(s.rows) })
  await seen.clock.settle()
  await seen.clock.advance(3400)
  const second = await secondCompact
  if (!('messages' in second)) throw new Error('second compaction returned no messages')
  const secondRow = second.messages.find((m: any) => m.text.startsWith('[clm ledger'))

  const firstLedger = await $.ui.mount({
    plugin: 'clm', surface: 'terminal', component: 'UserMessage',
    props: { text: firstRow.text, origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await firstLedger.drawn()).children).toEqual(['* clm compacted in 1.2 s'])
  const secondLedger = await $.ui.mount({
    plugin: 'clm', surface: 'terminal', component: 'UserMessage',
    props: { text: secondRow.text, origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await secondLedger.drawn()).children).toEqual(['* clm compacted in 3.4 s'])
  expect(passed).toBe(0)

  const expanded = await $.ui.mount({
    plugin: 'clm', surface: 'terminal', component: 'UserMessage',
    props: { text: firstRow.text, origin: { kind: 'composer' }, isExpanded: true },
  })
  expect((await expanded.drawn()).children).toEqual([firstRow.text])
  expect(passed).toBe(1)

  const ordinary = await $.ui.mount({
    plugin: 'clm', surface: 'terminal', component: 'UserMessage',
    props: { text: "[clm ledger is what I'd call it", origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await ordinary.drawn()).children).toEqual(["[clm ledger is what I'd call it"])
  expect(passed).toBe(2)
})

test('board page escapes a model-written title, so a <script> title cannot run in the browser', () => {
  const html = boardHtml([{ id: 'a1', title: '<script>alert(1)</script>', status: 'todo', repo: 'github.com/x/y', updated: '2026-01-01T00:00:00Z' }], 'github.com/x/y', 'now')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('<script>alert(1)')
})

// Regression caught: a session opened by /clear kept that command row as its first request, so every fold drew "/clear" above the ledger.
test('fold row renders /clear or ledger text instead of the compacted line', OPTS, async ($, on) => {
  const CLEAR = '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>'
  const rows = [M('user', CLEAR), M('user', '<local-command-stdout></local-command-stdout>'), ...ROWS]
  const s: State = { rows, replies: [ledger('fact')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out.some((m: any) => m.text.includes('<command-name>/clear') || m.text.includes('<local-command-'))).toBe(false)
  expect(out[0].text).toBe('please investigate the build')
  const row = out.find((m: any) => m.text.startsWith('[clm ledger'))
  expect(row.text).not.toContain('## 핵심 사실·경로')
  expect(storedLedger(seen)).toContain('## 핵심 사실·경로\n- fact')
  const drawn = await $.ui.mount({ plugin: 'clm', surface: 'terminal', component: 'UserMessage', props: { text: row.text, origin: { kind: 'composer' }, isExpanded: false } })
  expect((await drawn.drawn()).children[0]).toMatch(/^\* clm compacted/)
})

// A main-loop tool call, answered by the test's Bash bottom.
async function bashCall($: any, on: any, command: string): Promise<void> {
  await $.tool.call({ tool: 'Bash', command, tool_use_id: 'tu_make' })
}

// Regression caught: steps reached the tracker, its notices and the task panel only when a fold landed, so the panel sat still for a whole turn.
// The step's done lands as in_progress: only a fold's reviewer completes it.
test('a step updates the panel before any fold, with its done held as in progress', OPTS, async ($, on) => {
  const s: State = { rows: [...ROWS.slice(0, 2)], replies: [], stepDelay: 10_000, stepReplies: ['<ops>[{"op":"create","title":"빌드 로그 확인","status":"done","note":"make: a.ts:12","evidence":[{"ref":"tu_make","quote":"make fails at a.ts:12"}]}]</ops>'] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'make fails at a.ts:12', stderr: '', interrupted: false } }))
  // Only clock.advance below wakes the step model, so a hook that awaited it would never let this call resolve.
  await bashCall($, on, 'make')
  await seen.clock.settle()
  // The step model was called and is still asleep on the mocked clock: the call returned without waiting for it.
  expect(seen.stepPrompts.length).toBe(1)
  expect(seen.taskCalls.length).toBe(0)
  await seen.clock.advance(10_000)
  await seen.clock.settle()
  expect(seen.stepPrompts[0]).toContain('-> Bash {"command":"make"}')
  expect(seen.taskCalls.map(c => c.tool === 'TaskCreate' ? c.subject : c.status)).toEqual(['빌드 로그 확인', 'in_progress'])
  expect(seen.prompts.length).toBe(0)
  expect(seen.results.length).toBe(0)
})

// Regression caught: a fold appended the ops of turns whose steps the per-tool-call path had already emitted, so the panel and 한 일 showed each step twice.
test('fold re-emits steps already emitted per tool call', OPTS, async ($, on) => {
  const step = '<ops>[{"op":"create","title":"a.ts:12 수정","status":"done","note":"edited"}]</ops>'
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"a.ts:12 수정","status":"done","note":"fold"},{"op":"create","title":"테스트 통과","status":"done"}]')], stepReplies: [step] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  await bashCall($, on, 'git diff')
  await seen.clock.settle()
  await turnEnds($, s, seen)
  const issues = snapshot(parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? ''))
  expect(issues.map(i => i.title)).toEqual(['a.ts:12 수정'])
  expect(seen.taskCalls.filter(c => c.tool === 'TaskCreate').length).toBe(1)
})

// Regression caught: when a step update failed, the fold also skipped the dropped turns' ops, and those steps were lost.
test('a fold after a failed per-tool step still records the dropped turns', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"테스트 통과","status":"done"}]')], stepReplies: ['no ops here'] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  await bashCall($, on, 'npm test')
  await seen.clock.settle()
  await turnEnds($, s, seen)
  const issues = snapshot(parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? ''))
  expect(issues.map(i => i.title)).toEqual(['테스트 통과'])
})

// Regression caught: a session folded before /clear became a system row kept [/clear, ledger] as its head, so the next fold pinned the stale ledger above the new one.
test('a fold over an older fold drops the /clear row and the stale ledger', OPTS, async ($, on) => {
  const CLEAR = '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>'
  const OLD = '[clm ledger #3 · 2026-10-06T00:00:00.000Z] Earlier turns of this session were folded into these notes by the harness (file: x). They are your memory of that work.\n\n## 목표\n- old'
  const s: State = { rows: [M('user', CLEAR), M('user', OLD), ...ROWS], replies: [ledger('fact')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out.some((m: any) => m.text.includes('<command-name>/clear'))).toBe(false)
  expect(out.filter((m: any) => m.text.startsWith('[clm ledger')).map((m: any) => m.text.slice(0, 14))).toEqual(['[clm ledger #1'])
  expect(out[0].text.startsWith('[clm ledger #1')).toBe(true)
})

// --- evidence gate and review ------------------------------------------------

const section = (ledgerText: string, name: string) => new RegExp(`## ${name}\n([\\s\\S]*?)(\n\n|$)`).exec(ledgerText)?.[1] ?? ''
// The PR #<pr> incident: the assistant recommended closing the PR, the only tool result showed it OPEN, and the ledger recorded it closed.
const PR_ROWS = [
  M('user', 'check PR #<pr> and close it if it is stale'), use('tu_pr', 'Bash'), res('tu_pr', 'PR <pr> state: OPEN ' + BIG), M('assistant', 'I recommend closing PR #<pr>; closed it.'),
  ...ROWS.slice(4),
]

// Regression caught (a): a done step resting on the assistant's own recommendation, or on a tool result that shows the opposite, reached 한 일.
test('a close the assistant only recommended, with the PR still OPEN, ends not done', OPTS, async ($, on) => {
  const ops = [
    // Cites a real quote that the reviewer must see does not prove the close.
    { op: 'create', title: 'PR #<pr> 닫기', status: 'done', evidence: [{ ref: 'tu_pr', quote: 'PR <pr> state: OPEN' }] },
    // Quotes the assistant's prose under tu_pr's ref: the mechanical check fails it because the text is not in tu_pr.
    { op: 'create', title: 'PR #<pr> 정리', status: 'done', evidence: [{ ref: 'tu_pr', quote: 'I recommend closing PR #<pr>; closed it' }] },
  ]
  const s: State = {
    rows: PR_ROWS, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`],
    reviewReplies: ['{"verdicts":[{"id":"op1","accept":false,"reason":"tu_pr shows the PR OPEN; closing was only recommended"},{"id":"op2","accept":true,"reason":"ok"}]}'],
  }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(section(storedLedger(seen), '한 일')).not.toContain('PR #<pr>')
  expect(section(row, 'uncertain')).toContain('PR #<pr> 닫기')
  expect(section(row, 'uncertain')).toContain('PR #<pr> 정리')
  expect(seen.reviewPrompts[0]).toContain('"quote":"PR <pr> state: OPEN"')
  expect(seen.reviewPrompts[0]).toContain('[assistant] I recommend closing PR #<pr>; closed it.')
  const events = logEvents(seen)
  expect(events.find(e => e.event === 'evidence-rejected')?.reason).toContain('PR #<pr> 정리" as done: done moved to uncertain (quote "I recommend closing PR #<pr>; closed it" is not in tu_pr)')
  expect(events.find(e => e.event === 'review-rejected')?.reason).toContain('done moved to uncertain')
})

// Regression caught (b): a fact whose quote appears nowhere in the folded rows was kept as if the user or a tool had said it.
test('a fabricated quote is rejected for a fact', OPTS, async ($, on) => {
  const ops = [
    { op: 'fact', text: 'the build passes', evidence: [{ ref: 'tu_a', quote: 'the build passed cleanly' }] },
    { op: 'fact', text: 'the build log is long', evidence: [{ ref: 'tu_a', quote: 'log: make fails at' }] },
  ]
  const s: State = { rows: ROWS, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('the build log is long')
  expect(row).toContain('the build log is long — quote:')
  expect(row).not.toContain('the build passes')
  expect(logEvents(seen).find(e => e.event === 'evidence-rejected')?.reason).toContain('"the build passed cleanly" is not in tu_a')
})

// Regression caught (6): the reviewer could add a "missing instruction" quoted from a tool result, so text the user never wrote landed under 사용자 지시.
test('a tool_result ref cited as an instruction is refused', OPTS, async ($, on) => {
  const s: State = {
    rows: ROWS, replies: [ledger('fact')],
    reviewReplies: ['{"verdicts":[{"id":"fact1","accept":true,"reason":"ok"}],"missing_instructions":[{"ref":"tu_a","quote":"log: make fails at"}]}'],
  }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(section(storedLedger(seen), '사용자 지시')).toBe('- "now fix it"')
  expect(seen.reviewPrompts[0]).not.toContain('missing_instructions')
})

// Regression caught (3): a reviewer that throws or answers malformed JSON let every mechanically passing done reach 한 일 unreviewed.
// Regression caught (round 3, finding 3): the facts of a failed review reached 핵심 사실·경로 unaudited.
test('a reviewer failure records no done, holds the facts out of the ledger, and still folds', OPTS, async ($, on) => {
  const done = '[{"op":"create","title":"빌드 로그 확인","status":"done"}]'
  const s: State = { rows: ROWS, replies: [ledger('HELD-FACT-ONE', done)], reviewReplies: [new Error('review down')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(section(storedLedger(seen), '한 일')).toBe('- (none yet)')
  expect(section(row, 'uncertain')).toContain('빌드 로그 확인')
  expect(row).not.toContain('HELD-FACT-ONE')
  expect(heldIn(seen).map(h => [h.kind, h.text])).toEqual([['fact', 'HELD-FACT-ONE']])
  expect(logEvents(seen).find(e => e.event === 'review-failed')?.reason).toContain('review call failed')
  // A malformed reply takes the same path, and the first fact stays held with the new one.
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'more'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'ok'), M('user', 'push'), M('assistant', 'pushed')]
  s.replies.push(ledger('HELD-FACT-TWO', '[{"op":"create","title":"테스트 통과","status":"done"}]', [{ ref: 'tu_c', quote: 'all 12 tests passed' }]))
  s.reviewReplies = ['{"verdicts":"all fine"}']
  await turnEnds($, s, seen)
  const second = seen.results[1].messages[1].text
  expect(second).not.toContain('HELD-FACT')
  expect(section(storedLedger(seen), '한 일')).toBe('- (none yet)')
  expect(seen.reviewPrompts[1]).toContain('"id":"held1"')
  expect(heldIn(seen).map(h => h.text).sort()).toEqual(['HELD-FACT-ONE', 'HELD-FACT-TWO'])
  expect(logEvents(seen).filter(e => e.event === 'review-failed').length).toBe(2)
  // The next fold's reviewer accepts them, and only then do they reach the ledger.
  s.rows = [...s.rows, ...seen.results[1].messages, M('user', 'and again'), use('tu_e', 'Write'), res('tu_e', 'w ' + BIG), M('assistant', 'ok'), M('user', 'last'), M('assistant', 'fine')]
  s.replies.push(ledger('third', '[]', [{ ref: 'tu_e', quote: 'w ' + 'x'.repeat(40) }]))
  await turnEnds($, s, seen)
  const third = seen.results[2].messages[1].text
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('HELD-FACT-ONE')
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('HELD-FACT-TWO')
  expect(seen.store['held:s1']).toBeUndefined()
})

// Regression caught: nothing evicted a held fact, so with the reviewer down each fold added its facts for good, the resent set outgrew the 2048-token verdict reply, and the truncated JSON failed the review again.
test('a failing reviewer cannot grow the held facts past the cap or truncate the verdict reply', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('NEWEST-FACT')], reviewReplies: [new Error('review down')] }
  const seen = bottoms(on, s)
  const src = { kind: 'tool_result', text: 'log: make fails at a.ts:12', tool: 'Bash', isError: false }
  seen.store['held:s1'] = Array.from({ length: 30 }, (_, i) => ({
    key: `fact:old-${i}`, nonce: `n${i}`, kind: 'fact', text: `OLD-FACT-${i}`, evidence: [{ ref: 'tu_old', quote: 'log: make fails at' }], sources: { tu_old: src },
  }))
  await turnEnds($, s, seen)
  expect(seen.reviewPrompts[0]).toContain('"id":"held30"')
  expect(seen.reviewMaxTokens[0]).toBeGreaterThan(2048)
  const held = heldIn(seen).map(h => h.text)
  expect(held.length).toBe(20)
  expect(held.at(-1)).toBe('NEWEST-FACT')
  expect(held).not.toContain('OLD-FACT-10')
  expect(held).toContain('OLD-FACT-11')
  expect(logEvents(seen).find(e => e.event === 'review-dropped')?.reason).toContain('11 held fact(s) settled unreviewed')
})

// Regression caught: a failed review still applied the merge's retracts and notes, so an accepted fact vanished and a to-do line got "PR #<pr> closed" with no verdict on either.
test('a failed review drops the merge\'s retracts and note ops instead of applying them unreviewed', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('ACCEPTED-FACT', '[{"op":"create","title":"PR 정리","status":"todo"}]')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const tracker = () => snapshot(parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? ''))
  const issue = tracker().find(i => i.title === 'PR 정리')!
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('ACCEPTED-FACT')
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'more'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'ok'), M('user', 'push'), M('assistant', 'pushed')]
  const factLine = section(storedLedger(seen), '핵심 사실·경로').split('\n').find(l => l.includes('ACCEPTED-FACT'))!.replace(/^- /, '')
  const ops = [{ op: 'retract', fact: factLine }, { op: 'note', issue: issue.id, text: 'PR #<pr> closed' }, { op: 'retitle', issue: issue.id, title: 'PR #<pr> 닫힘' }]
  s.replies.push(`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`)
  s.reviewReplies = [new Error('review down')]
  await turnEnds($, s, seen)
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('ACCEPTED-FACT')
  const after = tracker().find(i => i.id === issue.id)!
  expect(after.title).toBe('PR 정리')
  expect(after.notes).not.toContain('PR #<pr> closed')
  expect(logEvents(seen).find(e => e.event === 'review-failed')?.reason).toContain('2 unreviewed op(s) dropped')
})

// Regression caught (4): a reviewer reply with no verdict for a claim accepted it, so an empty verdict list let every done and fact through.
test('empty verdicts record no done and drop the unverdicted facts', OPTS, async ($, on) => {
  const done = '[{"op":"create","title":"빌드 로그 확인","status":"done"}]'
  const s: State = { rows: ROWS, replies: [ledger('UNREVIEWED-FACT', done)], reviewReplies: ['{"verdicts":[]}'] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(section(storedLedger(seen), '한 일')).toBe('- (none yet)')
  expect(section(row, 'uncertain')).toContain('빌드 로그 확인')
  expect(row).not.toContain('UNREVIEWED-FACT')
  expect(logEvents(seen).find(e => e.event === 'review-rejected')?.reason).toContain('no verdict')
})

// Regression caught (1): a done the per-tool-call step emitted reached 한 일 on the mechanical check alone, with no reviewer ever reading it.
test('a step-path done stays doing until a fold reviewer accepts it', OPTS, async ($, on) => {
  const step = '<ops>[{"op":"create","title":"빌드 로그 확인","status":"done","evidence":[{"ref":"tu_make","quote":"make fails at a.ts:12"}]}]</ops>'
  const s: State = { rows: ROWS, replies: [ledger('fact')], stepReplies: [step] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'make fails at a.ts:12', stderr: '', interrupted: false } }))
  await bashCall($, on, 'make')
  await seen.clock.settle()
  const tracker = () => snapshot(parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? ''))
  expect(tracker().map(i => [i.title, i.status])).toEqual([['빌드 로그 확인', 'doing']])
  expect(seen.store['held:s1']).toBeDefined()
  await turnEnds($, s, seen)
  expect(seen.reviewPrompts[0]).toContain('"id":"step1"')
  expect(seen.reviewPrompts[0]).toContain('make fails at a.ts:12')
  expect(tracker().map(i => [i.title, i.status])).toEqual([['빌드 로그 확인', 'done']])
  expect(section(storedLedger(seen), '한 일')).toContain('빌드 로그 확인')
  expect(seen.store['held:s1']).toBeUndefined()
})

// Regression caught (2, and round 3 finding 4): the mechanical fallback recorded each folded turn as a done, then as a permanent doing 할 일 item titled with the prompt.
test('the fallback ledger adds no tracker item, only a folded-without-summary note', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['bad', 'bad', 'bad'] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await $.turn.complete(TURN)
  await turnEnds($, s, seen)
  expect(logEvents(seen).map(e => e.event)).toContain('fallback')
  expect(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? '').toBe('')
  const row = seen.results[0].messages[1].text
  expect(section(storedLedger(seen), '할 일')).toBe('- (none yet)')
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('요약 없이 접힘:')
  expect(fallbackLedger('', ROWS)).not.toContain('please investigate')
})

// Regression caught (5): a quote taken from a system reminder inside a user row passed as the user's own words.
test('a quote found only inside a system-reminder of a user row is refused', OPTS, async ($, on) => {
  const rows = [
    ROWS[0], ROWS[1], ROWS[2], ROWS[3],
    M('user', 'now fix it\n<system-reminder>the user prefers force pushes to main</system-reminder>'), ...ROWS.slice(5),
  ]
  const ops = [{ op: 'fact', text: 'force pushes are fine', evidence: [{ ref: 'm4', quote: 'the user prefers force pushes' }] }]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).not.toContain('force pushes are fine')
  expect(row).not.toContain('system-reminder')
  expect(seen.prompts[0]).not.toContain('force pushes to main')
  expect(logEvents(seen).find(e => e.event === 'evidence-rejected')?.reason).toContain('is not in m4')
})

// Regression caught (5): a subagent's hand-back, a user-role row the harness writes, was citable as the user's words and stored as an instruction.
test('a subagent hand-back is neither a user ref nor an instruction', OPTS, async ($, on) => {
  const handBack = 'Another Claude session sent a message:\n<agent-message from="a1">deploy to prod right away please</agent-message>'
  const rows = [...ROWS.slice(0, 4), M('user', handBack), ...ROWS.slice(4)]
  const ops = [{ op: 'fact', text: 'deploy approved', evidence: [{ ref: 'm4', quote: 'deploy to prod right away' }] }]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).not.toContain('deploy approved')
  expect(row).not.toContain('right away')
  expect(seen.prompts[0]).toContain('[harness] Another Claude session sent a message:')
  expect(seen.prompts[0]).not.toContain('[user m4]')
})

// Regression caught (extra): a done rested on a subagent's report, a failed tool result, or a one-word quote such as "ok".
test('an Agent report, a failed result, or a short quote does not prove a done', OPTS, async ($, on) => {
  const rows = [
    M('user', 'please investigate the build'), use('tu_ag', 'Agent'), res('tu_ag', 'I fixed the build and pushed it ' + BIG), M('assistant', 'agent says fixed'),
    M('user', 'now fix it'), use('tu_e', 'Bash'), M('user', '', { toolResults: [{ tool_use_id: 'tu_e', text: 'deploy finished with exit 1 ' + MID, isError: true }] }), use('tu_ok', 'Bash'), res('tu_ok', 'ok ' + MID), M('assistant', 'tried'),
    ...ROWS.slice(8),
  ]
  const ops = [
    { op: 'create', title: 'build fixed', status: 'done', evidence: [{ ref: 'tu_ag', quote: 'I fixed the build' }] },
    { op: 'create', title: 'deployed', status: 'done', evidence: [{ ref: 'tu_e', quote: 'deploy finished with exit' }] },
    { op: 'create', title: 'checked', status: 'done', evidence: [{ ref: 'tu_ok', quote: 'ok' }] },
  ]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(section(storedLedger(seen), '한 일')).toBe('- (none yet)')
  const reason = logEvents(seen).find(e => e.event === 'evidence-rejected')?.reason
  expect(reason).toContain('tu_ag is a Agent report')
  expect(reason).toContain('tu_e is a failed tool result')
  expect(reason).toContain('too short to cite')
})

// Regression caught: a transcript too small to fold was handed to a competing engine summary.
test('a small transcript stays unchanged when a compaction job has no fold plan', OPTS, async ($, on) => {
  const rows = [M('user', 'first request here'), M('user', 'AWS Transcribe도 검토 필요'), M('assistant', 'ok')]
  const s: State = { rows, replies: [] }
  const seen = bottoms(on, s)
  const result = compactedMessages(await $.session.compact(compactInput('auto', handled(rows))))
  expect(seen.engineCompactions).toBe(0)
  expect(result.map(m => m.text)).toEqual(rows.map(m => m.text))
})

// Regression caught (round 3, finding 1): a hand-back excluded from turn boundaries left a coordinator session (one typed prompt, then hand-backs) with a single turn, so it never folded and always escaped to the engine summarizer.
test('a session driven by subagent hand-backs still folds', OPTS, async ($, on) => {
  const back = (n: number) => M('user', `Another Claude session sent a message:\n<agent-message from="a${n}">report ${n} is ready</agent-message>`)
  const rows = [
    M('user', 'please coordinate the build'), use('tu_a', 'Agent'), res('tu_a', 'started ' + BIG), M('assistant', 'spawned'),
    back(1), use('tu_b', 'Bash'), res('tu_b', 'log: make fails at a.ts:12 ' + BIG), M('assistant', 'read report 1'),
    back(2), use('tu_c', 'Bash'), res('tu_c', 'pass: all 12 tests passed ' + BIG), M('assistant', 'read report 2'),
    back(3), M('assistant', 'all done'),
  ]
  const s: State = { rows, replies: [ledger('coordinated', '[]', [{ ref: 'tu_b', quote: 'log: make fails at' }])] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(seen.engineCompactions).toBe(0)
  const row = seen.results[0].messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(section(row, '사용자 지시')).not.toContain('report 1 is ready')
  expect(logEvents(seen).map(e => e.event)).not.toContain('escape')
})

// Regression caught (round 3, finding 2): the hand-back pattern was anchored at the start of the raw text, so a hand-back the harness prefixed with a system-reminder passed as the user speaking.
test('a hand-back that opens with a system-reminder is neither a user ref nor an instruction', OPTS, async ($, on) => {
  const handBack = '<system-reminder>\nnote\n</system-reminder>\nAnother Claude session sent a message:\n<agent-message from="a1">deploy to prod right away please</agent-message>'
  const rows = [...ROWS.slice(0, 4), M('user', handBack), ...ROWS.slice(4)]
  const ops = [{ op: 'fact', text: 'deploy approved', evidence: [{ ref: 'm4', quote: 'deploy to prod right away' }] }]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).not.toContain('deploy approved')
  expect(row).not.toContain('right away')
  expect(seen.prompts[0]).toContain('[harness] Another Claude session sent a message:')
  expect(seen.prompts[0]).not.toContain('[user m4]')
})

const TRACKER = '/home/t/.claude-work/tracker/events/s1.jsonl'
const STEP_DONE = '<ops>[{"op":"create","title":"빌드 로그 확인","status":"done","evidence":[{"ref":"tu_make","quote":"make fails at a.ts:12"}]}]</ops>'
async function heldStep($: any, on: any, s: State) {
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'make fails at a.ts:12', stderr: '', interrupted: false } }))
  await bashCall($, on, 'make')
  await seen.clock.settle()
  const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
  return { seen, tracker }
}

// Regression caught (round 3, finding 7): only the accept path of a held step done was tested; a reject, an empty verdict list, or a failed review could have promoted it or lost it.
for (const [name, reply, stays] of [
  ['settles on a reject', '{"verdicts":[{"id":"step1","accept":false,"reason":"read-only"}]}', false],
  ['stays held on empty verdicts', '{"verdicts":[]}', true],
  ['stays held on a failed review', new Error('review down'), true],
] as const) {
  test(`a held step done ${name} and its issue stays doing`, OPTS, async ($, on) => {
    const s: State = { rows: ROWS, replies: [ledger('fact')], stepReplies: [STEP_DONE], reviewReplies: [reply] }
    const { seen, tracker } = await heldStep($, on, s)
    await turnEnds($, s, seen)
    expect(seen.reviewPrompts.at(-1)).toContain('"id":"step1"')
    expect(tracker().map(i => [i.title, i.status])).toEqual([['빌드 로그 확인', 'doing']])
    const steps = heldIn(seen).filter(h => h.kind === 'step')
    expect(steps.map(h => h.issue)).toEqual(stays ? [tracker()[0]!.id] : [])
  })
}

// Regression caught (round 3, finding 5): a held create was keyed by its title, so once the issue was retitled the lookup missed it (or found another issue of that title) and the reviewed done never reached the issue the step created.
test('a held step create promotes the issue it created, even after a retitle', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact')], stepReplies: [STEP_DONE] }
  const { seen, tracker } = await heldStep($, on, s)
  const created = tracker()[0]!
  expect(heldIn(seen).map(h => h.issue)).toEqual([created.id])
  s.stepReplies!.push(`<ops>[{"op":"retitle","issue":"${created.id}","title":"빌드 실패 원인 확인"}]</ops>`)
  await bashCall($, on, 'make')
  await seen.clock.settle()
  expect(tracker().map(i => [i.id, i.title, i.status])).toEqual([[created.id, '빌드 실패 원인 확인', 'doing']])
  await turnEnds($, s, seen)
  expect(tracker().map(i => [i.id, i.status])).toEqual([[created.id, 'done']])
})

// Regression caught (round 3, finding 6): a step that re-held the same issue between the fold reading the held list and applying it lost its fresh, unreviewed entry, since settling went by key alone.
test('an entry a step re-holds after the fold read the held list survives the fold', { options: { budget: 5000, tailTarget: 3000, queueTarget: 1, ledgerTarget: 750, reserve: 100 } }, async ($, on) => {
  const open = '<ops>[{"op":"create","title":"빌드 로그 확인","status":"doing"}]</ops>'
  const s: State = { rows: ROWS, replies: [ledger('fact')], splitReplies: [splitAnswer(2)], stepReplies: [open], reviewReplies: ['{"verdicts":[{"id":"step1","accept":false,"reason":"no"}]}'] }
  const { seen, tracker } = await heldStep($, on, s)
  const id = tracker()[0]!.id
  const done = `<ops>[{"op":"status","issue":"${id}","status":"done","evidence":[{"ref":"tu_make","quote":"make fails at a.ts:12"}]}]</ops>`
  s.stepReplies!.push(done)
  await bashCall($, on, 'make')
  await seen.clock.settle()
  const first = heldIn(seen)[0]
  await $.turn.complete(TURN)
  await waitForPending(seen)
  expect(seen.store['pending:s1']).toBeDefined()
  s.stepReplies!.push(done)
  await bashCall($, on, 'make')
  await seen.clock.settle()
  const again = heldIn(seen)[0]
  expect([again.key, again.nonce === first.nonce]).toEqual([first.key, false])
  seen.results.push(await $.session.compact({ trigger: 'plugin', messages: handled(s.rows) }))
  expect(seen.engineCompactions).toBe(0)
  expect(heldIn(seen).map(h => h.nonce)).toEqual([again.nonce])
})

// --- quote matching, drops, directive noise, KST ------------------------------

const issueAt = (issues: readonly { id: string }[], n: number): string => {
  const issue = issues[n]
  if (!issue) throw new Error(`no issue at ${n}; the tracker holds ${issues.length}`)
  return issue.id
}

// Regression caught: a quote copied from a clipped tool result kept the clip's `…`, or came from text past the clip, and was rejected, so 핵심 사실·경로 stayed empty.
test('a quote ending in the clip ellipsis or taken from past the clip still holds', OPTS, async ($, on) => {
  const rows = [...ROWS]
  rows[2] = res('tu_a', 'log: make fails at a.ts:12 ' + BIG + ' linker exit code 2 at stage three')
  const ops = [
    { op: 'fact', text: 'FACT-PAST-CLIP', evidence: [{ ref: 'tu_a', quote: 'linker exit code 2 at stage three' }] },
    { op: 'fact', text: 'FACT-ELLIPSIS', evidence: [{ ref: 'tu_a', quote: 'make fails at a.ts:12 xxxx…' }] },
  ]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const facts = section(storedLedger(seen), '핵심 사실·경로')
  expect(facts).toContain('FACT-PAST-CLIP')
  expect(facts).toContain('FACT-ELLIPSIS')
})

// Regression caught: a drop with no quote of the user abandoning that direction reached the tracker, or a failed review landed a user-quoted drop no reviewer had matched to its issue, or lost it instead of holding it.
test('a drop lands only on a user quote, and a failed review holds it for the next review', OPTS, async ($, on) => {
  const rows = [...ROWS]
  rows[4] = M('user', 'stop the build work and switch to the login bug instead')
  const s: State = { rows, replies: [], reviewReplies: [new Error('review down')] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  await $.tool.call({ tool: 'TaskCreate', subject: 'login work', description: 'l' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'build work', description: 'b' })
  const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
  const login = issueAt(tracker(), 0), build = issueAt(tracker(), 1)
  const ops = [
    { op: 'status', issue: build, status: 'dropped', evidence: [{ ref: 'm4', quote: 'stop the build work and switch' }] },
    { op: 'status', issue: login, status: 'dropped', evidence: [{ ref: 'tu_a', quote: 'log: make fails at' }] },
  ]
  s.replies.push(`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`)
  await turnEnds($, s, seen)
  expect(tracker().map(i => [i.title, i.status])).toEqual([['login work', 'todo'], ['build work', 'todo']])
  expect(heldIn(seen).map(h => [h.kind, h.issue])).toEqual([['drop', build]])
  expect(logEvents(seen).find(e => e.event === 'evidence-rejected')?.reason).toContain('drop discarded')
  // The next fold's reviewer accepts the held drop, and only then does it land.
  s.rows = [...seen.results[0].messages, ...rows.slice(4)]
  s.replies.push(ledger('fact'))
  await turnEnds($, s, seen)
  expect(seen.reviewPrompts.at(-1)).toContain('"id":"step1"')
  expect(tracker().map(i => [i.title, i.status])).toEqual([['login work', 'todo'], ['build work', 'dropped']])
  expect(seen.store['held:s1']).toBeUndefined()
})

const runClm = ($: { command: { run(e: { command: string; args: string }): Promise<unknown> } }, args: string) => $.command.run({ command: 'clm', args })
const LATER_BAND_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isWorking: false, maxRows: 8, bodyColumns: 80, scroll: { offset: 0, bodyRows: 8 }, view: {},
}

const waitForLog = async (seen: { logs: string[] }, message: string) => {
  for (let i = 0; i < 50 && !seen.logs.includes(message); i++)
    await new Promise(resolve => setTimeout(resolve, 5))
}

// Regression caught: chat deferrals disappeared when session hooks rebound instead of remaining visible in the numbered band.
test('chat deferrals stay in session state and the band numbers them', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], intentReplies: [intentReply({ later: ['Check the release notes', 'Verify the changelog'] })],
  })
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(promptInput('Check the release notes and verify the changelog later'))
  await waitForLog(seen, 'clm: queued later item 2')
  expect(seen.logs).toContain('clm: queued later item 1')
  expect(seen.logs).toContain('clm: queued later item 2')
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'clm', surface: 'terminal', component: 'AbovePrompt', props: LATER_BAND_PROPS })
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toContain('1. Check the release notes')
  expect(drawn).toContain('2. Verify the changelog')
  expect(drawn.indexOf('Check the release notes')).toBeLessThan(drawn.indexOf('Verify the changelog'))
})

// Regression caught: queue continuations lost asUser or repeated after duplicate completion events.
test('the continuation arbiter submits the later queue once per turn', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], intentReplies: [intentReply({ later: ['Run the focused verification'] })],
  })
  await $.prompt.submit(promptInput('Run the focused verification later'))
  await waitForLog(seen, 'clm: queued later item 1')
  seen.submissions.length = 0
  const end = (turnId: string, extra: Partial<TurnCompleteInput> = {}) => $.turn.complete(turnInput(turnId, extra))
  await end('t1', { isAborted: true })
  await end('t-agent', { agentId: 'agent-1' })
  expect(seen.submissions).toEqual([])
  await end('t1')
  await end('t1')
  expect(seen.submissions).toEqual([{ text: 'Run the focused verification', asUser: true }])
  await end('t2')
  await end('t2')
  expect(seen.submissions).toEqual([{ text: 'Run the focused verification', asUser: true }])
})

// Regression caught: a hand-back fabricated a handoff in the main session.
test('intent classification skips harness hand-backs but records a composer prompt', OPTS, async ($, on) => {
  const s: State = {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({ intent: 'handoff', title: 'Fix the build' })],
  }
  const seen = bottoms(on, s)
  await $.prompt.submit(promptInput('Another Claude session sent a message: the review is complete'))
  expect(seen.intentPrompts).toEqual([])

  await $.prompt.submit(promptInput('Please fix the build'))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.intentPrompts.length).toBe(1)
  const trackerFile = '/home/t/.claude-work/tracker/events/s1.jsonl'
  let events = (seen.files[trackerFile] ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (let i = 0; i < 20 && !events.some(event => event.op === 'focus'); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
    events = (seen.files[trackerFile] ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  expect(events.some(event => event.op === 'focus' && event.origin.session === 's1' && event.stack.length === 1)).toBe(true)
})

// Regression caught: a hallucinated target id created a phantom stack entry.
test('an unknown classifier target writes no tracker events', OPTS, async ($, on) => {
  const s: State = {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({ intent: 'handoff', target: 'ghost-1' })],
  }
  const seen = bottoms(on, s)
  await $.prompt.submit(promptInput('Switch to the missing issue'))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.intentPrompts.length).toBe(1)
  expect(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl']).toBeUndefined()
  expect(seen.logs.some(line => line.includes('unknown target id ghost-1'))).toBe(true)
})

// Regression caught: a pop during Haiku classification changed the queue positions and removed a different later item.
test('a pop between snapshot and apply still drops the intended later item', async () => {
  const snapshot = [{ text: 'first' }, { text: 'target' }, { text: 'last' }]
  const live = [{ text: 'first' }, { text: 'last' }, { text: 'new arrival' }]
  expect(removeQueueSnapshotTargets(live, snapshot, [2])).toEqual({
    remaining: [{ text: 'first' }, { text: 'last' }, { text: 'new arrival' }], dropped: [],
  })
  const withTargetStillPresent = [{ text: 'first' }, { text: 'target' }, { text: 'last' }, { text: 'new arrival' }]
  expect(removeQueueSnapshotTargets(withTargetStillPresent, snapshot, [2])).toEqual({
    remaining: [{ text: 'first' }, { text: 'last' }, { text: 'new arrival' }], dropped: [{ item: 'target', number: 2 }],
  })
})

// Regression caught: a slow earlier classifier overwrote the focus chosen by a newer prompt.
test('B landing before A leaves focus on B and drops A', OPTS, async ($, on) => {
  let releaseA!: () => void
  let startedA!: () => void
  const gate = new Promise<void>(resolve => { releaseA = resolve })
  const started = new Promise<void>(resolve => { startedA = resolve })
  const seen = bottoms(on, {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({ intent: 'handoff', title: 'A task' }), intentReply({ intent: 'handoff', title: 'B task' })],
    intentBlocks: [async () => { startedA(); await gate }],
  })
  await $.prompt.submit(promptInput('Start A'))
  await started
  await $.prompt.submit(promptInput('Switch to B'))
  const path = '/home/t/.claude-work/tracker/events/s1.jsonl'
  for (let i = 0; i < 100; i++) {
    const events = parseLog(seen.files[path] ?? '')
    const focused = snapshot(events).find(issue => issue.id === focusOf(events, 's1').stack.at(-1))
    if (focused?.title === 'B task') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  releaseA()
  await waitForLog(seen, 'dropped older focus result 1')
  const events = parseLog(seen.files[path] ?? '')
  const focused = snapshot(events).find(issue => issue.id === focusOf(events, 's1').stack.at(-1))
  expect(focused?.title).toBe('B task')
  expect(seen.logs).toContain('clm intent: dropped older focus result 1 (applied 2)')
})

// Regression caught: a valid deferred request vanished when the independent focus label was malformed.
test('valid later survives invalid focus output', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [], intentReplies: [intentReply({ intent: 'not-an-intent', later: ['Please verify the release notes'] })],
  })
  await $.prompt.submit(promptInput('Please verify the release notes later'))
  await waitForLog(seen, 'clm: queued later item 1')
  const band = await $.ui.mount({ plugin: 'clm', surface: 'terminal', component: 'AbovePrompt', props: LATER_BAND_PROPS })
  expect(JSON.stringify(await band.drawn())).toContain('1. Please verify the release notes')
  expect(seen.logs.some(line => line.includes('unknown intent not-an-intent'))).toBe(true)
})

// Regression caught: a concrete rebuild request without a question mark was omitted from the request ledger.
test('a rebuild request without a question mark is stored', OPTS, async ($, on) => {
  const prompt = 'Please rebuild the configuration before release.'
  const seen = bottoms(on, {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({ raised: [{ text: 'Rebuild the configuration before release.', quote: 'rebuild the configuration before release' }] })],
  })
  await $.prompt.submit(promptInput(prompt))
  for (let i = 0; i < 100 && !Array.isArray(seen.store['requests:s1:main']); i++)
    await new Promise(resolve => setTimeout(resolve, 2))
  expect(seen.store['requests:s1:main']).toEqual([
    expect.objectContaining({ text: 'Rebuild the configuration before release.', status: 'open' }),
  ])
})

// Regression caught: one assistant response could answer several queued requests, but only the last one was closed.
test('one assistant answer resolves every matching open request', OPTS, async ($, on) => {
  const quote = 'The configuration was rebuilt and the docs were updated'
  const seen = bottoms(on, {
    rows: [M('user', 'earlier prompt'), M('assistant', quote)], replies: [],
    intentReplies: [
      intentReply({ raised: [
        { text: 'Rebuild the configuration.', quote: 'Please rebuild the configuration' },
        { text: 'Update the docs.', quote: 'also update the docs' },
      ] }),
      intentReply({ resolved: [
        { id: 'R1', how: 'answered', quote },
        { id: 'R2', how: 'answered', quote },
      ] }),
    ],
  })
  await $.prompt.submit(promptInput('Please rebuild the configuration, and also update the docs.'))
  for (let i = 0; i < 100 && !Array.isArray(seen.store['requests:s1:main']); i++) await new Promise(resolve => setTimeout(resolve, 2))
  await $.prompt.submit(promptInput('Those two requests are finished.'))
  for (let i = 0; i < 100 && (seen.store['requests:s1:main'] as { status?: string }[] | undefined)?.some(item => item.status === 'open'); i++)
    await new Promise(resolve => setTimeout(resolve, 2))
  expect(seen.intentPrompts[1]).toContain('<open_requests>\nR1 | Rebuild the configuration.\nR2 | Update the docs.')
  expect((seen.store['requests:s1:main'] as { status: string }[]).map(request => request.status)).toEqual(['answered', 'answered'])
})

// Regression caught: an assistant-authored phrase became a user request without a supporting user quote.
test('a request quoted only from assistant text is rejected', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: [M('assistant', 'I might rebuild the configuration next week.')], replies: [],
    intentReplies: [intentReply({ raised: [{ text: 'Rebuild the configuration.', quote: 'I might rebuild the configuration' }] })],
  })
  await $.prompt.submit(promptInput('Let us discuss priorities.'))
  for (let i = 0; i < 100 && !seen.logs.some(line => line.includes('dropped unsupported raised quote')); i++)
    await new Promise(resolve => setTimeout(resolve, 2))
  expect(seen.store['requests:s1:main']).toBeUndefined()
  expect(seen.logs.some(line => line.includes('dropped unsupported raised quote'))).toBe(true)
})

// Regression caught: a chat deferral was silently dropped instead of being queued alongside the active focus label.
test('a mixed chat queues exactly its deferred part and still applies its focus label', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [], intentReplies: [intentReply({ intent: 'handoff', title: 'A 고쳐', later: ['B 고쳐'] })],
  })
  await $.prompt.submit(promptInput('A 고쳐, B는 나중에'))
  await waitForLog(seen, 'clm: queued later item 1')
  const events = parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? '')
  const focus = focusOf(events, 's1')
  const focusedIssue = snapshot(events).find(issue => issue.id === focus.stack.at(-1))
  expect(focusedIssue?.title).toBe('A 고쳐')
  expect(focusedIssue?.status).toBe('doing')
})

// Regression caught: a later item re-queued itself forever when the arbiter replayed it as a plugin continuation.
test('a replayed later continuation is not classified', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [], intentReplies: [intentReply({ intent: 'pending', title: 'Run the focused verification', later: ['Run the focused verification'] })],
  })
  await $.prompt.submit(promptInput('Run the focused verification later'))
  await waitForLog(seen, 'clm: queued later item 1')
  await $.turn.complete({ ...TURN, turnId: 'later-replay-turn' })
  expect(seen.submissions).toContainEqual({ text: 'Run the focused verification', asUser: true })
  expect(seen.intentPrompts).toHaveLength(1)
})

// Regression caught: replaying a linked later item did not return its tracker issue to the doing focus, or reconciliation repeated writes.
test('a linked later replay reconciles once to its issue and then stays unchanged', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], intentReplies: [intentReply({ intent: 'pending', title: 'Do deferred task', later: ['Do deferred task'] })],
  })
  await $.prompt.submit(promptInput('Do deferred task later'))
  await waitForLog(seen, 'clm: queued later item 1')
  await $.turn.complete(turnInput('defer-turn'))
  expect(seen.submissions).toContainEqual({ text: 'Do deferred task', asUser: true })
  await $.turn.complete(turnInput('replay-finished'))
  const path = '/home/t/.claude-work/tracker/events/s1.jsonl'
  const afterReconcile = seen.files[path] ?? ''
  const events = parseLog(afterReconcile)
  const focus = focusOf(events, 's1')
  const top = snapshot(events).find(issue => issue.id === focus.stack.at(-1))
  expect(top?.title).toBe('Do deferred task')
  expect(top?.status).toBe('doing')
  await $.turn.complete(turnInput('next-turn'))
  expect(seen.files[path]).toBe(afterReconcile)
})

// Regression caught: assistant-only wording entered the queue, or a queue-wide drop ran without a queue reference in the user's prompt.
test('assistant wording is rejected and an unsupported all drop is ignored', OPTS, async ($, on) => {
  const s: State = {
    rows: [], replies: [], intentReplies: [
      intentReply({ later: ['Keep this queued item'] }),
      intentReply({ later: ['secret phrase from the assistant'], laterDrop: 'all' }),
    ],
  }
  const seen = bottoms(on, s)
  await $.prompt.submit(promptInput('Keep this queued item later'))
  await waitForLog(seen, 'clm: queued later item 1')
  s.rows = [M('assistant', 'The secret phrase from the assistant was: secret phrase from the assistant')]
  await $.prompt.submit(promptInput('Continue the current task'))
  await waitForLog(seen, 'ignored laterDrop=all without a queue reference')
  expect(seen.logs).toContain('clm: later item dropped (not supported by prompt): secret phrase from the assistant')
  const band = await $.ui.mount({ plugin: 'clm', surface: 'terminal', component: 'AbovePrompt', props: LATER_BAND_PROPS })
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toContain('1. Keep this queued item')
  expect(drawn).not.toContain('secret phrase')
})

// Regression caught: chat removal deleted the wrong queued item or changed the order of the remaining requests.
test('a chat drop removes exactly the named item and keeps the rest in order', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [], intentReplies: [
      intentReply({ later: ['first request', 'second request', 'third request'] }),
      intentReply({ laterDrop: [2] }),
    ],
  })
  await $.prompt.submit(promptInput('Do these later: first request, second request, third request'))
  await waitForLog(seen, 'clm: queued later item 3')
  await $.prompt.submit(promptInput('later 2번 빼'))
  await waitForLog(seen, 'clm: dropped later item 2: second request')
  const band = await $.ui.mount({ plugin: 'clm', surface: 'terminal', component: 'AbovePrompt', props: LATER_BAND_PROPS })
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toContain('1. first request')
  expect(drawn).toContain('2. third request')
  expect(drawn.indexOf('first request')).toBeLessThan(drawn.indexOf('third request'))
  expect(drawn).not.toContain('second request')
  expect(seen.logs).toContain('clm: dropped later item 2: second request')
})

// Regression caught: a failed continuation submission consumed the queue head and blocked retrying the same turn.
test('a rejected continuation submission restores its queue head and clears its turn claim', async () => {
  let currentWorkflow: ClmWorkflow = workflow({ lastSubmittedTurn: 'retry-turn' })
  const logs: string[] = []
  const submitted = await submitWithRecovery(
    async () => { throw new Error('settings hook refused prompt') },
    async () => { currentWorkflow = restoreFailedContinuation(currentWorkflow, 'retry-turn', { text: 'next item', asUser: true, source: 'later' }) },
    message => logs.push(message),
  )
  expect(submitted).toBe(false)
  expect(currentWorkflow.later).toEqual([{ text: 'next item' }])
  expect(currentWorkflow.lastSubmittedTurn).toBeNull()
  expect(logs).toContain('clm: continuation submit failed (Error: settings hook refused prompt)')
})

// Regression caught: clm skipped a queued resume after consuming the higher-priority later queue.
test('the continuation selector consumes a resume request after the later queue', async () => {
  const start = workflow({ later: [{ text: 'verify the release' }], resumeRequest: { text: 'time-budget resume' } })
  const queue = chooseContinuation(start, 't1')
  expect(queue.continuation).toEqual({ text: 'verify the release', asUser: true, source: 'later' })
  const resumed = chooseContinuation(queue.workflow, 't2')
  expect(resumed.continuation?.text).toBe('time-budget resume')
  expect(chooseContinuation(resumed.workflow, 't3').continuation).toBeUndefined()
})

// Regression caught: task notifications cleared queued away-resume requests, or a human return left one stale.
test('only human-origin prompts clear queued resumes', async () => {
  const pending: ClmWorkflow = {
    later: [], resumeRequest: { text: 'stale away reminder' },
    lastSubmittedTurn: 'claimed-turn', activeTurnId: null,
  }
  expect(resetUserWorkflow(pending, { kind: 'task-notification' })).toBe(pending)
  const returned = resetUserWorkflow(pending, { kind: 'composer' })
  expect(returned.resumeRequest).toBeNull()
  expect(returned.lastSubmittedTurn).toBeNull()
})

// Regression caught: tasks of an abandoned direction stayed open with no way for the user to clear them, or `/clm drop` left their panel tasks behind.
test('/clm drop drops one named issue, then every open issue of the session', OPTS, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  for (const t of ['a', 'b', 'c']) await $.tool.call({ tool: 'TaskCreate', subject: `task ${t}`, description: t })
  const issues = () => snapshot(parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? ''))
  const tracker = () => issues().map(i => i.status)
  await runClm($, `drop ${issueAt(issues(), 1)}`)
  expect(tracker()).toEqual(['todo', 'dropped', 'todo'])
  await runClm($, 'drop all')
  expect(tracker()).toEqual(['dropped', 'dropped', 'dropped'])
  expect(seen.taskCalls.filter(c => c.tool === 'TaskUpdate' && c.status === 'deleted').length).toBe(3)
})

// Regression caught: `!` shell echoes, slash-command wrappers and bare go-aheads ("ㄱㄱ", "지금?") filled 30-40% of 사용자 지시.
test('wrapper rows and short acknowledgements stay out of 사용자 지시', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- "ㄱ"\n\n## 핵심 사실·경로\n- f'
  const dropped = ['<bash-input>adb uninstall com.x</bash-input>', '<bash-stdout>Success</bash-stdout>', '<local-command-stdout>ok</local-command-stdout>', 'ㄱㄱ', '지금?', '빨리 하쇼', 'OK', 'keep the API stable'].map(t => M('user', t))
  const out = preserveInstructions(prev, instructionValues(prev), dropped, '/ledger.md')
  expect(section(out.fullNotes, '사용자 지시')).toBe('- "keep the API stable"')
})

// Regression caught: the ledger header went back to a UTC ISO time the user cannot read at a glance, or a KST header stopped being recognized as a ledger row.
test('the ledger header carries a KST time and is still read as a ledger row', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact'), ledger('fact')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · \d{4}-\d\d-\d\d \d\d:\d\d KST\]\n\n## where we are/)
  s.rows = [...seen.results[0].messages, ...ROWS.slice(4)]
  await turnEnds($, s, seen)
  expect(seen.results[1].messages.filter((m: any) => m.text.startsWith('[clm ledger')).length).toBe(1)
})

// Regression caught: short pieces scattered across a row ("push…to…origin…main") each matched somewhere, so a quote the row never says held as evidence.
test('a quote of short pieces scattered across a row is refused, a long piece ending in the clip ellipsis holds', OPTS, async ($, on) => {
  const rows = [...ROWS]
  rows[2] = res('tu_a', 'error: failed to push some refs to origin; branch main is behind its remote counterpart')
  const ops = [
    { op: 'fact', text: 'FACT-SCATTERED', evidence: [{ ref: 'tu_a', quote: 'push…to…origin…main' }] },
    { op: 'fact', text: 'FACT-ONE-PIECE', evidence: [{ ref: 'tu_a', quote: 'failed to push some refs to origin…' }] },
  ]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const facts = section(storedLedger(seen), '핵심 사실·경로')
  expect(facts).not.toContain('FACT-SCATTERED')
  expect(facts).toContain('FACT-ONE-PIECE')
})

// Regression caught: a length cutoff filed short directives (하지마, push, 멈춰) as noise, and since stored lines pass the same filter the next fold deleted them for good.
test('short directives stay in 사용자 지시 and survive the next fold reading them back', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- "ㄱ"\n\n## 핵심 사실·경로\n- f'
  const rows = ['하지마', 'push', '멈춰', 'ㅇㅋ', '넵', 'y'].map(t => M('user', t))
  const want = '- "하지마"\n- "push"\n- "멈춰"'
  const first = preserveInstructions(prev, instructionValues(prev), rows, '/ledger.md')
  expect(section(first.fullNotes, '사용자 지시')).toBe(want)
  const again = preserveInstructions(first.fullNotes, instructionValues(first.fullNotes), [], '/ledger.md')
  expect(section(again.fullNotes, '사용자 지시')).toBe(want)
})

// Regression caught: a dropped issue is hidden from <issues>, so the next fold re-created its title as a fresh open issue and the abandoned work came back.
test('a fold cannot re-create the title of an issue dropped in this session', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"build work","status":"todo"}]')] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  await $.tool.call({ tool: 'TaskCreate', subject: 'build work', description: 'b' })
  const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
  await runClm($, `drop ${issueAt(tracker(), 0)}`)
  await turnEnds($, s, seen)
  expect(tracker().map(i => [i.title, i.status])).toEqual([['build work', 'dropped']])
})

// Regression caught: a step-path drop waited for a fold's reviewer, so a session that never folds kept the abandoned direction's tasks open for good.
test('a step drop with a user quote lands with no fold', OPTS, async ($, on) => {
  const steps: string[] = []
  const s: State = { rows: [M('user', 'please investigate the build'), M('user', 'stop the build work and switch to the login bug instead')], replies: [], stepReplies: steps }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'build work', description: 'b' })
  const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
  const build = issueAt(tracker(), 0)
  steps.push(`<ops>[{"op":"status","issue":"${build}","status":"dropped","evidence":[{"ref":"m2","quote":"stop the build work and switch"}]}]</ops>`)
  await bashCall($, on, 'git status')
  await seen.clock.settle()
  expect(tracker().map(i => [i.title, i.status])).toEqual([['build work', 'dropped']])
  expect(heldIn(seen)).toEqual([])
})

// Regression caught: a dropped issue was hidden from <issues>, so a status op on its id was rejected and resuming that direction could never re-open it.
test('a step re-opens a dropped issue by its id when the user resumes it', OPTS, async ($, on) => {
  const steps: string[] = []
  const s: State = { rows: [M('user', 'actually resume the build work')], replies: [], stepReplies: steps }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'build work', description: 'b' })
  const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
  const build = issueAt(tracker(), 0)
  await runClm($, `drop ${build}`)
  steps.push(`<ops>[{"op":"status","issue":"${build}","status":"doing","evidence":[{"ref":"m1","quote":"actually resume the build work"}]}]</ops>`)
  await bashCall($, on, 'make')
  await seen.clock.settle()
  expect(seen.stepPrompts.at(-1)).toContain(`${build} | dropped | build work`)
  expect(tracker().map(i => [i.id, i.status])).toEqual([[build, 'doing']])
})

// Regression caught: once dropped issues were listed to the models, a done or doing citing a stale pre-pivot tool row re-opened an issue the user had abandoned.
test('a step done on a dropped issue citing only a tool result leaves it dropped', OPTS, async ($, on) => {
  const steps: string[] = []
  const s: State = { rows: [M('user', 'please investigate the build')], replies: [], stepReplies: steps }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'make fails at a.ts:12', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'build work', description: 'b' })
  const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
  const build = issueAt(tracker(), 0)
  await runClm($, `drop ${build}`)
  steps.push(`<ops>[{"op":"status","issue":"${build}","status":"done","evidence":[{"ref":"tu_make","quote":"make fails at a.ts:12"}]}]</ops>`)
  await bashCall($, on, 'make')
  await seen.clock.settle()
  expect(tracker().map(i => [i.id, i.status])).toEqual([[build, 'dropped']])
  expect(heldIn(seen)).toEqual([])
  expect(logEvents(seen).find(e => e.event === 'evidence-rejected')?.reason).toContain('re-open discarded')
})

// Regression caught: a fold re-opened a dropped issue on a tool-row quote, or a failed review landed a user-quoted re-open no reviewer had matched to that issue.
for (const [name, status, cite, review] of [
  ['citing only a tool result', 'done', [{ ref: 'tu_a', quote: 'log: make fails at' }], undefined],
  ['on a failed review, even citing the user', 'doing', [{ ref: 'm4', quote: 'resume the build work please' }], new Error('review down')],
] as const) {
  test(`a fold move out of dropped ${name} leaves the issue dropped`, OPTS, async ($, on) => {
    const rows = [...ROWS]
    rows[4] = M('user', 'resume the build work please')
    const s: State = { rows, replies: [], ...(review ? { reviewReplies: [review] } : {}) }
    const seen = bottoms(on, s)
    panelHandlers(on, seen)
    await $.tool.call({ tool: 'TaskCreate', subject: 'build work', description: 'b' })
    const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
    const build = issueAt(tracker(), 0)
    await runClm($, `drop ${build}`)
    s.replies.push(`## 목표\n- -\n\n<ops>${JSON.stringify([{ op: 'status', issue: build, status, evidence: cite }])}</ops>`)
    await turnEnds($, s, seen)
    expect(tracker().map(i => [i.id, i.status])).toEqual([[build, 'dropped']])
  })
}
