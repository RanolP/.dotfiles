import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, RenderPropsOf, SessionCompactInput, SessionCompactResult, SessionMessage, SessionStartInput, ToolCallInput, TurnCompleteInput } from 'claude-code'

import { boardHtml } from './board'
import { clmStatus as readClmStatus } from './panel'
import { chooseContinuation, clmStatus, isHeld, resetUserWorkflow, removeQueueSnapshotTargets, restoreFailedContinuation, sessionIssues, submitWithRecovery, trackIssue, recallTranscriptAddress, residentLedgerText, TASK_TOOL } from './register'
import type { Held, Meta } from './register'
import { INTENT_SYSTEM } from './intent'
import type { ClmWorkflow } from '../types'

import { ageDecayPlan, fallbackLedger, instructionValues, LEDGER_COMPACT_SYSTEM, MERGE_SYSTEM, parseMerge, preserveInstructions, REVIEW_SYSTEM, SPLIT_MERGE_SYSTEM } from './ledger'
import { focusOf, parseLog, snapshot, toEvents, type Issue, type Payload } from './tracker'
import { fingerprint } from './fold'
import { M, intentReply, use, res, BIG, MID, ROWS, CITE, ledger, splitAnswer, compressedTopics, TURN, OPTS, LEDGER_FILE, LOG_FILE, storedLedger, ids, est, shape, handled, compactInput, promptInput, turnInput, commandInput, compactedMessages, workflow, heldIn, isMetaValue, metaIn, bottoms, turnEnds, waitForPending, BG_OPTS, logEvents, panelHandlers, sixDone, storedOverhead, NOTE_REPLY, ESCAPE_ROWS, WITHHELD_FILE, section, PR_ROWS, TRACKER, seedTracker, issueAt, runClm, LATER_BAND_PROPS, waitForLog } from './clm-test-support'
import type { State, On, Seen, PanelReply } from './clm-test-support'

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
    focus: null,
    stackDepth: 0,
    pending: [],
    agents: [],
    later: [{ text: 'review the release' }],
    resumeRequest: { text: 'continue the audit' },
    lastFoldAt: 1_791_926_400_000,
    ledgerPath: '/home/t/.claude-work/plans/clm-status-session.md',
    openIssues: 3,
  })
})

// Regression caught: haiku fenced its JSON reply in ```json, and no session ever got a focus event.
test('a fenced intent reply still sets the main focus', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [], intentReplies: ['```json\n' + intentReply({ intent: 'handoff', title: 'Main task' }) + '\n```'] })
  await $.prompt.submit(promptInput('Start the main task'))
  await waitForLog(seen, '주 작업 초점 갱신 (handoff)')
  const events = parseLog(seen.files[TRACKER] ?? '')
  expect(snapshot(events).find(issue => issue.id === focusOf(events, 's1').stack.at(-1))?.title).toBe('Main task')
})

// Regression caught: clm status omitted the main focus stack, pending work, and live subagent roots.
test('clm status names the focus top, stack depth, pending and live subagent tasks', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [],
    intentReplies: [
      intentReply({ intent: 'handoff', title: 'Main task' }),
      intentReply({ intent: 'interleave', title: 'Focused subtask' }),
      intentReply({ intent: 'pending', title: 'Deferred task', later: ['Deferred task'] }),
    ],
  })
  const agentId = 'worker-agent-123456'
  on('agent.spawn', () => ({ model: 'haiku', agentId }))
  const submit = async (text: string, notice: string) => {
    await $.prompt.submit(promptInput(text))
    await waitForLog(seen, notice)
  }
  await submit('Start the main task', '주 작업 초점 갱신 (handoff)')
  await submit('Do a focused subtask', '주 작업 초점 갱신 (interleave)')
  await submit('Do the deferred task later', '주 작업 초점 갱신 (pending)')

  const spawned = await $.agent.spawn({ prompt: 'Run the focused checks', description: 'Agent checks' })
  if ('deny' in spawned || !spawned.agentId) throw new Error('worker did not spawn')
  const root = snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.title === 'Agent checks')
  if (!root) throw new Error('spawned worker has no assigned task root')
  const started = await $.tool.call({ tool: TASK_TOOL, id: root.id, status: 'doing', agentId: spawned.agentId } satisfies ToolCallInput)
  if ('deny' in started) throw new Error(started.deny)

  const status = await readClmStatus({
    readWorkflow: async () => workflow(),
    readMeta: async () => ({}),
    readAll: async () => parseLog(seen.files[TRACKER] ?? ''),
    sessionId: async () => 's1',
    ledgerPath: async () => LEDGER_FILE,
    storeGet: async key => seen.store[key],
  })
  const focusId = focusOf(parseLog(seen.files[TRACKER] ?? ''), 's1').stack.at(-1)
  expect(status.focus).toEqual({ id: focusId, title: 'Focused subtask', status: 'doing' })
  expect(status.stackDepth).toBe(2)
  expect(status.pending.map(item => item.title)).toEqual(['Deferred task'])
  expect(status.agents).toEqual([{
    agentId, taskId: root.id, title: 'Agent checks', status: 'doing',
  }])
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
