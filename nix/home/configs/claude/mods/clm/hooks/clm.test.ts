import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { SessionCompactResult, SessionMessage, ToolCallInput } from 'claude-code'

import { boardHtml } from './board'
import { sessionIssues, STEP_SYSTEM, trackIssue } from './register'
import type { Meta } from './register'

import { fallbackLedger, instructionValues, MERGE_SYSTEM, parseMerge, preserveInstructions, REVIEW_SYSTEM } from './ledger'
import { parseLog, snapshot } from './tracker'

const M = (role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) =>
  ({ role, text, toolUses: [], ...extra }) as any
const use = (id: string, tool: string) => M('assistant', '', { toolUses: [{ tool_use_id: id, tool, input: { id }, text: 'ok' }] })
const res = (id: string, text: string) => M('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] })
const BIG = 'x'.repeat(4000) // ~1000 tokens
const MID = 'y'.repeat(800) // ~200 tokens

// ~2250 estimated tokens over four turns. With a 1200-token tail target the
// newest two turns fit and the first request's tool work plus "now fix it" fold.
const ROWS = [
  M('user', 'please investigate the build'), use('tu_a', 'Bash'), res('tu_a', 'log ' + BIG), M('assistant', 'make fails at a.ts:12'),
  M('user', 'now fix it'), use('tu_b', 'Edit'), res('tu_b', 'edited ' + MID), M('assistant', 'fixed a.ts:12'),
  M('user', 'run tests'), use('tu_c', 'Bash'), res('tu_c', 'pass ' + BIG), M('assistant', 'tests pass'),
  M('user', 'commit it'), M('assistant', 'done'),
]
// The merge model writes 목표 and an <ops> array; facts arrive as fact ops,
// clm keeps 사용자 지시 itself and the tracker renders the other three. Every
// fact and done claim here cites the first tool result of ROWS ("log ..."),
// which tests not about evidence rely on to pass the mechanical check.
const CITE = [{ ref: 'tu_a', quote: 'log' }]
const ledger = (fact: string, ops = '[]', cite = CITE) =>
  `## 목표\n- -\n\n<ops>${JSON.stringify([{ op: 'fact', text: fact, evidence: cite }, ...JSON.parse(ops).map((o: any) => (o.status === 'done' && !o.evidence ? { ...o, evidence: cite } : o))])}</ops>`
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any
const OPTS = { options: { budget: 2000, tailTarget: 1200, reserve: 100 } }
const LEDGER_FILE = '/home/t/.claude-work/plans/clm-s1.md'
const LOG_FILE = '/home/t/.claude-work/plans/clm-s1.log.jsonl'
const ids = (m: any) => [...m.toolUses.map((u: any) => u.tool_use_id), ...(m.toolResults ?? []).map((r: any) => r.tool_use_id)]
const est = (m: any) => Math.ceil((m.text.length + m.toolUses.reduce((k: number, u: any) => k + JSON.stringify(u.input).length + u.tool.length, 0) + (m.toolResults ?? []).reduce((k: number, x: any) => k + x.text.length, 0)) / 4)
const shape = (out: any[]) => out.map((m: any) => m.text || ids(m).join())
const handled = (rows: any[]) => rows.map((m, i) => ({ ...m, handle: `h${i}` }))

type State = { rows: any[]; replies: (string | null | Error)[]; turnReplies?: string[]; stepReplies?: string[]; stepDelay?: number; usage?: any; mergeDelays?: number[]; reviewReplies?: (string | Error)[] }
function bottoms(on: any, s: State) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-06T00:00:00Z') })
  const seen = { clock, store: {} as Record<string, unknown>, files: {} as Record<string, string>, prompts: [] as string[], reviewPrompts: [] as string[], turnPrompts: [] as string[], stepPrompts: [] as string[], logs: [] as string[], results: [] as SessionCompactResult[], taskCalls: [] as ToolCallInput[], engineCompactions: 0, engineInputs: [] as (readonly SessionMessage[])[] }
  on('store.get', (_$: any, e: any) => ({ value: seen.store[e.key] }))
  on('store.set', (_$: any, e: any) => { seen.store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete seen.store[e.key]; return { value: undefined } })
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: s.rows }))
  on('session.usage', () => ({ value: s.usage ?? { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
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
    if (e.system === STEP_SYSTEM) {
      seen.stepPrompts.push(e.prompt)
      if (s.stepDelay) await clock.sleep(s.stepDelay)
      return { value: { isAnswered: true, text: s.stepReplies?.shift() ?? '<ops>[]</ops>', usage: {} } }
    }
    if (e.system === REVIEW_SYSTEM) {
      seen.reviewPrompts.push(e.prompt)
      const text = s.reviewReplies?.shift() ?? '{"verdicts":[],"missing_instructions":[]}'
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
  on('ui.log', (_$: any, e: any) => { seen.logs.push(e.text); return { value: undefined } })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('turn.complete', () => ({ text: '' }))
  // Stands for the engine summarizer: any call reaching it is a compaction clm failed to replace.
  on('session.compact', (_$: any, e: any) => { seen.engineCompactions++; seen.engineInputs.push(e.messages); return { messages: [M('user', 'ENGINE SUMMARY')] } })
  return seen
}
// The plugin raises its compaction from turn.complete; the engine answers by
// running the chain again with the live transcript, which a test raises itself.
async function turnEnds($: any, s: State, seen: { results: SessionCompactResult[] }, answer = '') {
  await $.turn.complete({ ...TURN, answer })
  seen.results.push(await $.session.compact({ trigger: 'plugin', messages: handled(s.rows) }))
}
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

// Regression caught: a stale projected task id used to hide completion instead of relinking to a fresh task.
test('fold issues project to the task panel', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"clm 조사하기","status":"todo","note":"조사 메모"}]'), ledger('fact 2', '[{"op":"status","issue":"s1-1","status":"done"}]', [{ ref: 'm1', quote: 'run tests' }])] }
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
  expect(seen.results[0].messages[1].text).toContain('clm 조사하기')
  expect(seen.logs).toContain("작업 'clm 조사하기' 추가")
})

// Regression caught: a `<changes>` block in the merge reply leaked into the ledger notes or was announced as a 맥락 갱신 line at fold time.
test('a merge reply carrying a changes block folds without announcing it', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [`<changes>핵심 사실: 순서가 바뀐 응답</changes>\n\n${ledger('fact')}`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(seen.results[0].messages[1].text).toContain('fact')
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
  expect(seen.results[0].messages[1].text).toContain('fact')
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
  expect(out[1].text).toContain('a.ts:12 is the bad import')
  expect(shape(out.slice(2))).toEqual(['run tests', 'tu_c', 'tu_c', 'tests pass', 'commit it', 'done'])
  expect(out.some((m: any) => m.handle !== undefined)).toBe(false)
  expect(seen.prompts[0]).toContain('fixed a.ts:12')
  expect(seen.prompts[0]).not.toContain('tests pass')
  expect(seen.files[LEDGER_FILE]).toContain('## 핵심 사실·경로')
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: a second fold loses the first ledger (not fed back from the file) or stacks a second ledger row beside the first.
test('the ledger round-trips through its file and survives a second fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('FIRST-FACT'), ledger('SECOND-FACT', '[]', [{ ref: 'm1', quote: 'run tests' }])] }
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
  expect(out[1].text).toContain('SECOND-FACT')
  expect(out.map((m: any) => m.text).filter(Boolean)).toEqual(['please investigate the build', out[1].text, 'commit it', 'done', 'add docs', 'docs added', 'push', 'pushed'])
})

// Regression caught: a merged ledger missing a section replaces the memory anyway and silently drops that section.
test('a merged ledger without its 목표 header skips the fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['## 핵심 사실·경로\n- a heading the merge no longer writes\n\n<ops>[]</ops>'] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(seen.files[LEDGER_FILE]).toBeUndefined()
  expect((seen.store['ledger:s1'] as any).lastSkip).toContain('expected the 1 note sections')
  expect(logEvents(seen).map(e => e.event)).toEqual(['merge-invalid'])
})

// Regression caught: after a fold, reads include the pre-boundary transcript so totals double-count rows the model no longer sees; and /clm output lands in the model's transcript.
test('/clm prints the ledger, a budget line counting only post-boundary rows, and the last decisions', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('LEDGER-ONLY-FACT')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const after = seen.results[0].messages
  s.rows = [...ROWS, ...after]
  const r: any = await $.command.run({ command: 'clm' } as any)
  expect(r.text).toBeUndefined()
  const text = seen.logs.at(-1)!
  const expected = after.reduce((n: number, m: any) => n + est(m), 0)
  expect(text.split('\n')[0]).toBe(`clm budget: ${expected}/2000 tokens (${Math.round(expected / 20)}%); folds above 1900, tail target 1200, ratio 1`)
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

// Regression caught: a deferred plan used a tail-relative boundary, so one appended turn forced a second merge.
test('a plan deferred past one appended turn is applied without a second merge', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('planned ledger')] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect(seen.store['pending:s1']).toBeDefined()
  s.rows = [...ROWS, M('user', 'new turn'), M('assistant', 'new result')]
  const out: any = await $.session.compact({ trigger: 'auto', messages: handled(s.rows) } as any)
  expect(seen.prompts.length).toBe(1)
  expect(out.messages[1].text).toContain('planned ledger')
  expect(out.messages.some((m: any) => m.text === 'new turn')).toBe(true)
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
  expect(out[1].text).toContain('- 출력 과다: Bash {"id":"tu_e"}')
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
  const notes = seen.results[0].messages[1].text.split('\n').filter((l: string) => l.includes('출력 과다:'))
  expect(notes.length).toBe(5)
  expect(notes[0]).toContain('old-b')
  expect(notes[4]).toContain('tu_e')
  expect(seen.results[0].messages[1].text).toContain('kept fact')
})

// Regression caught (guard 3): a fold whose ledger outweighs the turns it drops makes the context bigger, and the next turn folds again.
test('a fold that would not shrink the context is skipped with both sizes logged', { options: { budget: 2000, tailTarget: 1990, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'start'), M('user', 'a'), M('assistant', 'A'), M('user', 'b'), M('assistant', 'B'), M('user', 'go'), M('assistant', 'w'.repeat(7600))]
  const s: State = { rows, replies: [ledger('p'.repeat(1700))] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect(seen.store['pending:s1']).toBeUndefined()
  const line = seen.logs.find(l => l.includes('would not shrink'))!
  expect(line).toMatch(/\(\d+ -> \d+ est\. tokens\)/)
  const ev = logEvents(seen).find(e => e.event === 'skip-not-shrinking')
  expect(ev.tokensAfter).toBeGreaterThanOrEqual(ev.tokensBefore)
})

// Regression caught (guard 4): a merge model that keeps answering badly blocks every fold, and the context grows without bound.
test('after three failed merges in a row the fold uses a mechanical ledger', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['bad', null, 'bad'] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await $.turn.complete(TURN)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect((seen.store['ledger:s1'] as any).fails).toBe(2)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(row).toContain('- "now fix it"')
  expect(row).toContain('- turn (first request, continued): tools Bash')
  expect(row).toContain('- turn "now fix it": tools Edit')
  expect((seen.store['ledger:s1'] as any).fails).toBe(0)
  expect(logEvents(seen).map(e => e.event)).toEqual(['merge-invalid', 'merge-timeout', 'merge-invalid', 'fallback', 'clear'])
})

// Regression caught: the first fold took observed / (0 overhead + estimate) as the ratio and saturated it at 4.
test('the first usage reading folds but sets no ratio', OPTS, async ($, on) => {
  const rows = ROWS
  const usage = (tokens: number) => ({ startedAt: 0, rateLimits: [], context: { window: 200000, tokens } })
  const s: State = { rows, replies: [ledger('x')], usage: usage(6000) }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect((seen.store['ledger:s1'] as { ratio?: number }).ratio).toBeUndefined()
  expect(seen.store['pending:s1']).toBeDefined()
})

// Regression caught (d): the trigger counted the whole usage reading, so ~35k of system prompt and tool schemas against a 32k budget folded every few calls.
test('the fold trigger ignores system-prompt tokens in the usage reading', OPTS, async ($, on) => {
  // ~1260 estimated message tokens under a 1900 trigger; the 6000-token reading is mostly system prompt.
  const s: State = { rows: ROWS.slice(4), replies: [ledger('x')], usage: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 6000 } } }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect(seen.prompts.length).toBe(0)
  expect(seen.store['pending:s1']).toBeUndefined()
  // Once a fold has set the baseline, the same overhead is subtracted from later readings.
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
  expect(Object.keys(clear).sort()).toEqual(['event', 'keptTurns', 'ratio', 'reason', 'tokensAfter', 'tokensBefore', 'ts'])
  expect(clear.keptTurns).toBe(2)
  expect(clear.tokensAfter).toBeLessThan(clear.tokensBefore)
})

// Regression caught (guard 9): a budget under 2000 or a reserve over the budget is silently replaced and the user never learns the setting was ignored.
test('a bad option is logged with the value actually used', { options: { budget: 100, tailTarget: 50000, reserve: 9999 } }, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  await ($ as any).session.start({ source: 'startup' })
  expect(seen.logs).toContain('clm: option budget=100 must be an integer of at least 2000; using 2000')
  expect(seen.logs).toContain('clm: option tailTarget=50000 must be a positive integer under the budget (2000); using 1000')
  expect(seen.logs).toContain('clm: option reserve=9999 must be a positive integer under the budget (2000); using 500')
})

// Regression caught: with no plan pending, the engine's threshold or a /compact runs its own summarizer and replaces the ledger with an engine summary.
test('auto compaction with no pending plan produces a clm ledger instead of an engine summary', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('INLINE-FACT'), 'not a ledger'] }
  const seen = bottoms(on, s)
  const auto: any = await $.session.compact({ trigger: 'auto', messages: handled(ROWS) } as any)
  expect(auto.messages[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(auto.messages[1].text).toContain('INLINE-FACT')
  // A failed merge still folds, mechanically, rather than handing over to the engine.
  const manual: any = await $.session.compact({ trigger: 'manual', messages: handled([...ROWS, ...auto.messages, M('user', 'more'), use('tu_f', 'Bash'), res('tu_f', BIG), M('assistant', 'ok')]) } as any)
  expect(manual.messages[1].text).toMatch(/^\[clm ledger #2 · /)
  expect(manual.messages.some((m: any) => m.text === 'ENGINE SUMMARY')).toBe(false)
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: an auto compaction that cannot shrink must reach the engine summarizer instead of returning the unchanged transcript.
test('a non-shrinking auto fold calls next after the escape attempt', { options: { budget: 2000, tailTarget: 1990, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'start'), M('user', 'a'), M('assistant', 'A'), M('user', 'b'), M('assistant', 'B'), M('user', 'go'), M('assistant', 'w'.repeat(7600))]
  const s: State = { rows, replies: [ledger('p'.repeat(1700))] }
  const seen = bottoms(on, s)
  const r = await $.session.compact({ trigger: 'auto', messages: handled(rows) })
  if (!('messages' in r)) throw new Error('compaction returned no messages')
  expect(r.messages?.[0]?.text).toBe('ENGINE SUMMARY')
  expect(seen.engineCompactions).toBe(1)
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

// Regression caught: the fallback stored an oversized prompt twice (clipped and whole), or without a pointer to the full text in the ledger file.
test('an oversized prompt is kept once, whole in the file and clipped with its pointer on the visible line', async () => {
  const prompt = 'line one\n' + 'x'.repeat(2100)
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- f'
  const dropped = [M('user', prompt)]
  const first = preserveInstructions(fallbackLedger(prev, dropped).notes, [], dropped, '/ledger.md')
  expect(first.notes).toContain(`…[${prompt.length - 2000} chars cut, see /ledger.md]`)
  expect(first.fullNotes.split(JSON.stringify(prompt)).length).toBe(2)
  // The next fold reads the file's values back as prior; the same prompt dropped again stays one line.
  const again = preserveInstructions(first.fullNotes, [prompt], dropped, '/ledger.md')
  expect(again.fullNotes.split(JSON.stringify(prompt)).length).toBe(2)
  expect(again.notes.match(/chars cut/g)?.length).toBe(1)
})

// Regression caught: the instruction cap kept old lines first, hiding the newest correction behind the overflow pointer.
test('the newest user instruction survives the visible instruction cap', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- f'
  const old = Array.from({ length: 12 }, (_, i) => `old instruction ${i} ${'x'.repeat(24)}`)
  const out = preserveInstructions(prev, old, [M('user', 'newest correction')], '/ledger.md', [], 180)
  expect(out.notes).toContain('- "newest correction"')
  expect(out.notes).toContain('[additional user instructions in /ledger.md]')
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
  expect(r.messages?.[1]?.text).toContain(`- 보존된 출력: ${WITHHELD_FILE}`)
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

// Regression caught: when the escape retry also failed, the engine summarized the original transcript, so withholding results never shrank what it read.
test('a failed escape retry hands the engine the withheld rows without their handles', OPTS, async ($, on) => {
  const s: State = { rows: ESCAPE_ROWS, replies: [new Error('merge down'), new Error('still down')] }
  const seen = bottoms(on, s)
  await $.session.compact({ trigger: 'auto', messages: handled(ESCAPE_ROWS) })
  expect(seen.engineCompactions).toBe(1)
  const withheld = (seen.engineInputs[0] ?? []).find((m: any) => m.toolResults?.[0]?.tool_use_id === 'tu_a')
  expect(withheld.toolResults[0].text).toBe(`[clm escape: full tool result at ${WITHHELD_FILE}]`)
  expect(withheld.handle).toBeUndefined()
  expect(seen.files[WITHHELD_FILE]).toBe('r'.repeat(4000))
})

// Regression caught: the engine spends a summarizer call ahead of time and can install that summary at the next compaction.
test('precompute skips the engine summarizer', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [] }
  const seen = bottoms(on, s)
  const r: any = await $.session.compact({ trigger: 'precompute', messages: handled(ROWS) } as any)
  expect(r.skip).toBe('clm replaces compaction')
  expect(seen.engineCompactions).toBe(0)
  expect(seen.prompts.length).toBe(0)
  // A subagent's own transcript is still the engine's to compact.
  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: handled(ROWS) } as any)
  expect(seen.engineCompactions).toBe(1)
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
  expect(row.text).toContain('## 핵심 사실·경로\n- fact')
  const drawn = await $.ui.mount({ plugin: 'clm', surface: 'terminal', component: 'UserMessage', props: { text: row.text, origin: { kind: 'composer' }, isExpanded: false } })
  expect((await drawn.drawn()).children[0]).toMatch(/^\* clm compacted/)
})

// A main-loop tool call, answered by the test's Bash bottom; returns how long clm's hook held the call.
async function bashCall($: any, on: any, command: string): Promise<number> {
  const started = performance.now()
  await $.tool.call({ tool: 'Bash', command, tool_use_id: 'tu_make' })
  return performance.now() - started
}

// Regression caught: steps reached the tracker, its notices and the task panel only when a fold landed, so the panel sat still for a whole turn.
test('panel does not update until fold', OPTS, async ($, on) => {
  const s: State = { rows: [...ROWS.slice(0, 2)], replies: [], stepDelay: 10_000, stepReplies: ['<ops>[{"op":"create","title":"빌드 로그 확인","status":"done","note":"make: a.ts:12","evidence":[{"ref":"tu_make","quote":"make fails at a.ts:12"}]}]</ops>'] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'make fails at a.ts:12', stderr: '', interrupted: false } }))
  const heldMs = await bashCall($, on, 'make')
  // The step model is still asleep on the mocked clock: the call did not wait for it.
  expect(seen.taskCalls.length).toBe(0)
  await seen.clock.advance(10_000)
  await seen.clock.settle()
  console.log(`per-tool hook held the call ${heldMs.toFixed(2)} ms`)
  expect(heldMs).toBeLessThan(50)
  expect(seen.stepPrompts[0]).toContain('-> Bash {"command":"make"}')
  expect(seen.taskCalls.map(c => c.tool === 'TaskCreate' ? c.subject : c.status)).toEqual(['빌드 로그 확인', 'completed'])
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
  M('user', 'check PR #<pr> and close it if it is stale'), use('tu_pr', 'Bash'), res('tu_pr', 'state: OPEN ' + BIG), M('assistant', 'I recommend closing PR #<pr>; closed it.'),
  ...ROWS.slice(4),
]

// Regression caught (a): a done step resting on the assistant's own recommendation, or on a tool result that shows the opposite, reached 한 일.
test('a close the assistant only recommended, with the PR still OPEN, ends not done', OPTS, async ($, on) => {
  const ops = [
    // Cites a real quote that the reviewer must see does not prove the close.
    { op: 'create', title: 'PR #<pr> 닫기', status: 'done', evidence: [{ ref: 'tu_pr', quote: 'state: OPEN' }] },
    // Cites the assistant's prose, which is no citable row.
    { op: 'create', title: 'PR #<pr> 정리', status: 'done', evidence: [{ ref: 'tu_pr', quote: 'closed it' }] },
  ]
  const s: State = {
    rows: PR_ROWS, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`],
    reviewReplies: ['{"verdicts":[{"id":"op1","accept":false,"reason":"tu_pr shows the PR OPEN; closing was only recommended"},{"id":"op2","accept":true,"reason":"ok"}],"missing_instructions":[]}'],
  }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(section(row, '한 일')).not.toContain('PR #<pr>')
  expect(row).toContain('PR #<pr> 닫기')
  expect(row).toContain('PR #<pr> 정리')
  expect(seen.reviewPrompts[0]).toContain('"quote":"state: OPEN"')
  expect(seen.reviewPrompts[0]).toContain('[assistant] I recommend closing PR #<pr>; closed it.')
  const events = logEvents(seen)
  expect(events.find(e => e.event === 'evidence-rejected')?.reason).toContain('PR #<pr> 정리')
  expect(events.find(e => e.event === 'review-rejected')?.reason).toContain('done downgraded to doing')
})

// Regression caught (b): a fact or an instruction whose quote appears nowhere in the folded rows was kept as if the user or a tool had said it.
test('a fabricated quote is rejected for a fact and for a missing instruction', OPTS, async ($, on) => {
  const ops = [
    { op: 'fact', text: 'the build passes', evidence: [{ ref: 'tu_a', quote: 'build passed' }] },
    { op: 'fact', text: 'the build log is long', evidence: [{ ref: 'tu_a', quote: 'log xxxx' }] },
  ]
  const s: State = {
    rows: ROWS, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`],
    reviewReplies: ['{"verdicts":[],"missing_instructions":[{"ref":"m4","quote":"also deploy to prod"}]}'],
  }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(section(row, '핵심 사실·경로')).toContain('the build log is long')
  expect(row).not.toContain('the build passes')
  expect(row).not.toContain('deploy to prod')
  const reasons = logEvents(seen).filter(e => e.event === 'evidence-rejected').map(e => e.reason).join(' | ')
  expect(reasons).toContain('"build passed" is not in tu_a')
  expect(reasons).toContain('missing instruction refused')
})

// Regression caught (e): a reviewer that throws or answers malformed JSON blocked the fold or threw away the mechanically verified claims.
test('a reviewer failure keeps the mechanically checked claims and still folds', OPTS, async ($, on) => {
  const done = '[{"op":"create","title":"빌드 로그 확인","status":"done"}]'
  const s: State = { rows: ROWS, replies: [ledger('fact', done)], reviewReplies: [new Error('review down')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(section(row, '한 일')).toContain('빌드 로그 확인')
  expect(section(row, '핵심 사실·경로')).toContain('fact')
  expect(logEvents(seen).find(e => e.event === 'review-failed')?.reason).toContain('review call failed')
  // A malformed reply takes the same path.
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'more'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'ok'), M('user', 'push'), M('assistant', 'pushed')]
  s.replies.push(ledger('fact 2', '[]', [{ ref: 'm1', quote: 'run tests' }]))
  s.reviewReplies = ['{"verdicts":"all fine"}']
  await turnEnds($, s, seen)
  expect(seen.results[1].messages[1].text).toContain('fact 2')
  expect(logEvents(seen).filter(e => e.event === 'review-failed').length).toBe(2)
})
