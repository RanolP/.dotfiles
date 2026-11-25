// Projection regressions moved from nix/home/configs/claude/mods/clm/hooks/clm.test.ts.
import { test, expect } from 'claude-code/testing'
import { projectSession, type ProjectionIo } from './events'
import type { PanelIo } from './panel'
import { parseLog, snapshot, type Payload, type TrackerEvent } from './tracker'

const origin = { session: 's1', repo: 'github.com/o/repo', cwd: '/w' }
const source = '/home/t/.claude-work/tracker/events/s1.jsonl'
const own = '/home/t/.claude-work/task-panel/s1.jsonl'
const harness = () => {
  const files: Record<string, string> = { [source]: '', [own]: '' }
  const calls: Parameters<PanelIo['toolCall']>[0][] = []
  const logs: string[] = []
  const io: ProjectionIo = {
    exists: async path => path in files,
    read: async path => files[path] ?? '',
    write: async (path, text) => { files[path] = text },
    toolCall: async input => {
      calls.push(input)
      return { result: { task: { id: `panel-${calls.filter(call => call.tool === 'TaskCreate').length}` }, success: true } }
    },
    log: text => { logs.push(text) },
  }
  const append = (...payloads: Payload[]) => {
    const old = parseLog(files[source] ?? '')
    const events: TrackerEvent[] = payloads.flatMap((payload, index) => payload.op === 'create'
      ? [{ ...payload, issue: payload.issue ?? `s1-${old.length + index + 1}`, origin, seq: old.length + index + 1, ts: '2026-10-06T00:00:00Z' }]
      : 'issue' in payload ? [{ ...payload, origin, seq: old.length + index + 1, ts: '2026-10-06T00:00:00Z' }] : [])
    files[source] += events.map(event => JSON.stringify(event)).join('\n') + '\n'
  }
  return { files, calls, logs, io, append, run: () => projectSession(io, '/home/t', 's1') }
}

// Regression caught: projection could overwrite clm's event log or duplicate tasks on the next hook.
test('two issues write two own links, preserve clm bytes, and project once across concurrent hooks and reloads', async () => {
  const h = harness()
  h.append({ op: 'create', title: 'A', status: 'todo' }, { op: 'create', title: 'B', status: 'todo' })
  const before = h.files[source]
  await Promise.all([h.run(), h.run()])
  expect(h.calls.map(call => call.tool)).toEqual(['TaskCreate', 'TaskCreate'])
  expect(parseLog(h.files[own] ?? '').map(event => event.op)).toEqual(['task', 'task'])
  expect(h.files[source]).toBe(before)
  await projectSession({ ...h.io }, '/home/t', 's1')
  expect(h.calls.length).toBe(2)
  h.append({ op: 'status', issue: 's1-1', status: 'doing' })
  await h.run()
  expect(h.calls.at(-1)).toMatchObject({ tool: 'TaskUpdate', taskId: 'panel-1', status: 'in_progress' })
})

test('fold issues project to the task panel', async () => {
  const h = harness()
  h.append({ op: 'create', title: 'clm 조사하기', status: 'todo', note: '조사 메모' })
  await h.run()
  expect(h.calls[0]).toMatchObject({ subject: 'clm 조사하기', description: '조사 메모' })
  h.append({ op: 'status', issue: 's1-1', status: 'done' })
  h.io.toolCall = async input => {
    h.calls.push(input)
    return input.tool === 'TaskUpdate' && input.taskId === 'panel-1'
      ? { isError: true, result: { error: 'stale task id' } }
      : { result: { task: { id: 'panel-2' }, success: true } }
  }
  await h.run()
  expect(h.calls.at(-1)).toMatchObject({ taskId: 'panel-2', status: 'completed' })
  expect(h.logs.some(line => line.includes('panel-relink'))).toBe(true)
})

test('a session with 8 done issues shows only the latest 5 in the panel', async () => {
  const h = harness()
  for (let i = 1; i <= 8; i++) {
    h.append({ op: 'create', title: `done ${i}`, status: 'todo' })
    await h.run()
  }
  for (let i = 1; i <= 8; i++) {
    h.append({ op: 'status', issue: `s1-${i}`, status: 'done' })
    await h.run()
  }
  const last = new Map(h.calls.flatMap(call => call.tool === 'TaskUpdate' ? [[call.taskId, call.status]] : []))
  expect([1, 2, 3].map(i => last.get(`panel-${i}`))).toEqual(['deleted', 'deleted', 'deleted'])
  expect([4, 5, 6, 7, 8].map(i => last.get(`panel-${i}`))).toEqual(Array(5).fill('completed'))
})

test('a TaskUpdate answered success false relinks the issue to a new panel task', async () => {
  const h = harness()
  h.append({ op: 'create', title: 'lost task', status: 'todo' })
  await h.run()
  h.io.toolCall = async input => {
    h.calls.push(input)
    return { result: input.tool === 'TaskUpdate' && input.taskId === 'panel-1'
      ? { success: false, error: 'Task not found' } : { success: true, task: { id: 'panel-2' } } }
  }
  h.append({ op: 'status', issue: 's1-1', status: 'doing' })
  await h.run()
  expect(h.calls.at(-1)).toMatchObject({ taskId: 'panel-2', status: 'in_progress' })
  expect(h.logs.some(line => line.includes('Task not found'))).toBe(true)
})

test('several fold issues create one panel task each', async () => {
  const h = harness()
  h.append({ op: 'create', title: 'A', status: 'todo' }, { op: 'create', title: 'B', status: 'done' }, { op: 'create', title: 'C', status: 'todo' })
  await h.run()
  expect(h.calls.filter(call => call.tool === 'TaskCreate').map(call => call.subject)).toEqual(['A', 'B', 'C'])
  expect(h.calls.filter(call => call.tool === 'TaskUpdate')).toEqual([{ tool: 'TaskUpdate', taskId: 'panel-2', subject: 'B', description: 'B', status: 'completed' }])
})

test('a refused TaskCreate still leaves tracker issues intact', async () => {
  const h = harness()
  h.append({ op: 'create', title: 'clm 조사하기', status: 'todo' })
  h.io.toolCall = async () => ({ deny: 'refused in test' })
  await h.run()
  expect(snapshot(parseLog(h.files[source] ?? '')).map(issue => issue.title)).toEqual(['clm 조사하기'])
  expect(h.files[own]).toBe('')
  expect(h.logs.some(line => line.includes('not projected'))).toBe(true)
})

// Regression caught: dropping a tracker issue must remove its projected native task.
test('dropped issues delete their native tasks', async () => {
  const h = harness()
  h.append({ op: 'create', title: 'drop me', status: 'todo' })
  await h.run()
  h.append({ op: 'status', issue: 's1-1', status: 'dropped' })
  await h.run()
  expect(h.calls.at(-1)).toMatchObject({ tool: 'TaskUpdate', taskId: 'panel-1', status: 'deleted' })
})
