import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, SessionMessage, SessionStartInput, ToolCallInput, TurnCompleteInput } from 'claude-code'

import { boardHtml } from './board'
import { clmStatus as readClmStatus } from './panel'
import { chooseContinuation, clmStatus, resetUserWorkflow, restoreFailedContinuation, sessionIssues, submitWithRecovery, trackIssue, TASK_TOOL } from './register'
import { INTENT_SYSTEM } from './intent'
import type { ClmWorkflow } from '../types'

import { focusOf, parseLog, snapshot, toEvents, type Issue, type Payload } from './tracker'
import { M, intentReply, use, res, BIG, MID, ROWS, TURN, OPTS, LEDGER_FILE, LOG_FILE, storedLedger, promptInput, turnInput, commandInput, workflow, bottoms, logEvents, panelHandlers, sixDone, TRACKER, seedTracker, issueAt, runClm, waitForLog } from './clm-test-support'
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

// Regression caught: the host rejects state files by UTF-8 bytes, while Korean text uses three bytes per character.
test('session state takes the over-cap path when UTF-8 bytes exceed the host limit', OPTS, async ($, on) => {
  const maxStateBytes = 4_194_304
  const koreanText = '가'.repeat(Math.floor(maxStateBytes / 3) + 1)
  const seen = bottoms(on, {
    rows: [],
    fsWriteBlock: async (path, text) => {
      const bytes = new TextEncoder().encode(text).length
      if (path.endsWith('.state.json') && bytes > maxStateBytes)
        throw new Error(`$.fs.write: ${path} refused: ${bytes} bytes is over the ${maxStateBytes}-byte limit`)
    },
  })

  expect(koreanText.length < maxStateBytes).toBe(true)
  expect(new TextEncoder().encode(koreanText).length > maxStateBytes).toBe(true)
  await $.prompt.submit(promptInput(koreanText))

  expect(seen.logs.some(line => line.includes('prompt state update failed'))).toBe(false)
  expect((seen.files['/home/t/.claude-work/plans/clm-s1.state.json'] ?? '').includes('address-index:s1:main')).toBe(false)
})

// Regression caught: haiku fenced its JSON reply in ```json, and no session ever got a focus event.
test('a fenced intent reply still sets the main focus', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [], intentReplies: ['```json\n' + intentReply({ intent: 'handoff', title: 'Main task' }) + '\n```'] })
  await $.prompt.submit(promptInput('Start the main task'))
  await waitForLog(seen, '주 작업 초점 갱신 (handoff)')
  const events = parseLog(seen.files[TRACKER] ?? '')
  expect(snapshot(events).find(issue => issue.id === focusOf(events, 's1').stack.at(-1))?.title).toBe('Main task')
})

// Regression caught: clm status omitted the main focus stack, pending work, and live subagent roots.
test('clm status names the focus top, stack depth, pending and live subagent tasks', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: [],
    intentReplies: [
      intentReply({ intent: 'handoff', title: 'Main task' }),
      intentReply({ intent: 'interleave', title: 'Focused subtask' }),
      intentReply({ intent: 'pending', title: 'Deferred task' }),
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
    readAll: async () => parseLog(seen.files[TRACKER] ?? ''),
    sessionId: async () => 's1',
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

// Regression caught: a TaskUpdate answered with success: false and no isError counted as success, so a missing panel task was never relinked.
test('a TaskUpdate answered success false relinks the issue to a new panel task', OPTS, async ($, on) => {
  const s: State = { rows: ROWS }
  const seen = bottoms(on, s)
  panelHandlers(on, seen, id => (id === 'panel-1' ? { success: false, error: 'Task not found' } : { success: true }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'lost task', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 'panel-1', status: 'in_progress' })
  expect(seen.taskCalls.filter(c => c.tool === 'TaskCreate').map(c => c.subject)).toEqual(['lost task', 'lost task'])
  expect(seen.taskCalls.some(c => c.tool === 'TaskUpdate' && c.taskId === 'panel-2' && c.status === 'in_progress')).toBe(true)
  expect(logEvents(seen).some(e => e.event === 'panel-relink' && e.reason.includes('Task not found'))).toBe(true)
})

// Regression caught: a completed TaskUpdate notice was delayed and could be repeated on turn completion.
test('a TaskUpdate to completed logs its notice immediately and is not repeated', OPTS, async ($, on) => {
  const s: State = { rows: ROWS }
  const seen = bottoms(on, s)
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => ({ result: { task: { id: 'panel-1', subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$: any, e: any) => ({ result: { success: true, taskId: e.taskId, updatedFields: [] } }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'event task', description: 'created in the turn' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: 'panel-1', status: 'completed' })
  expect(seen.logs.filter(l => l === "작업 'event task' 완수").length).toBe(1)
  await $.turn.complete(TURN)
  expect(seen.logs.filter(l => l === "작업 'event task' 완수").length).toBe(1)
})

// Regression caught: the model stays denied while clm centralizes its task change into tracker and panel writes.
test('model task calls are denied outside clm projection', OPTS, async ($, on) => {
  const s: State = { rows: [] }
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

