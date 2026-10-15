import { test, expect, mock } from 'claude-code/testing'
import type { SessionCompactInput, SessionMessage } from 'claude-code'

import { describe, focusOf, injected, parseLog, snapshot, toEvents, type Issue, type TrackerEvent } from './tracker'
import { compose } from './intent'
import { describeOp } from './evidence'

const at = (session: string, repo: string) => ({ session, repo, cwd: '/w' })
const line = (e: TrackerEvent) => JSON.stringify(e)

const issue = (id: string, title: string, status: Issue['status'] = 'todo'): Issue => ({
  id, title, status, origin: at('old-session', 'github.com/o/repo'), notes: [], linked: [], updated: '2026-10-06T00:00:00Z',
})

// Regression caught: tracker changes were written without a matching display notice for each operation.
test('describes every tracker operation and suppresses a repeated status', async () => {
  const origin = at('s1', 'github.com/o/repo')
  const events: TrackerEvent[] = [
    { ts: '2026-10-06T01:00:00Z', seq: 1, issue: 's1-1', origin, op: 'create', title: 'new task', status: 'todo' },
    { ts: '2026-10-06T01:00:01Z', seq: 2, issue: 's1-1', origin, op: 'status', status: 'done' },
    { ts: '2026-10-06T01:00:02Z', seq: 3, issue: 'old-1', origin, op: 'status', status: 'doing' },
    { ts: '2026-10-06T01:00:03Z', seq: 4, issue: 'old-1', origin, op: 'status', status: 'doing' },
    { ts: '2026-10-06T01:00:04Z', seq: 5, issue: 'old-1', origin, op: 'status', status: 'todo' },
    { ts: '2026-10-06T01:00:05Z', seq: 6, issue: 'old-1', origin, op: 'status', status: 'question' },
    { ts: '2026-10-06T01:00:06Z', seq: 7, issue: 'old-1', origin, op: 'status', status: 'dropped' },
    { ts: '2026-10-06T01:00:07Z', seq: 8, issue: 'old-1', origin, op: 'progress', done: 4, total: 5 },
    { ts: '2026-10-06T01:00:08Z', seq: 9, issue: 'old-1', origin, op: 'retitle', title: 'renamed task' },
    { ts: '2026-10-06T01:00:09Z', seq: 10, issue: 'old-1', origin, op: 'note', text: 'first line\nsecond line' },
    { ts: '2026-10-06T01:00:10Z', seq: 11, issue: 'old-1', origin, op: 'link' },
    { ts: '2026-10-06T01:00:11Z', seq: 12, issue: 'old-1', origin, op: 'parent', parent: 's1-1' },
    { ts: '2026-10-06T01:00:12Z', seq: 13, issue: 's1', origin, op: 'focus', stack: ['old-1'], pending: [], intent: 'continue', rule: 'Always cite the result.' },
  ]
  expect(describe(events, [issue('old-1', 'old task')])).toEqual([
    "작업 'new task' 추가",
    "작업 'new task' 완수",
    "작업 'old task' 착수",
    "작업 'old task' 대기",
    "작업 'old task' 질문 대기",
    "작업 'old task' 중단",
    "작업 'old task' 진행 (4/5)",
    "작업 'old task' 재조정 -> 'renamed task'",
    "작업 'renamed task' 메모: first line",
    "작업 'renamed task' 연결: github.com/o/repo",
    "작업 'renamed task' 상위 작업: new task",
    '주 작업 초점 갱신 (continue)',
  ])
  expect(focusOf(events, 's1')).toEqual({ stack: ['old-1'], pending: [] })
  expect(focusOf(events, 'other-session')).toEqual({ stack: [], pending: [] })
  expect(describeOp({ op: 'parent', issue: 'old-1', parent: null })).toBe('issue old-1 gets parent (none)')
  expect(describeOp({ op: 'focus', stack: ['old-1'], pending: [], intent: 'continue' })).toBe('focus -> [old-1] (continue)')
  const [child] = snapshot(toEvents([
    { op: 'create', issue: 's1-child', title: 'child', status: 'todo' },
    { op: 'parent', issue: 's1-child', parent: 's1-parent' },
  ], origin, 0, '2026-10-06T00:00:00Z'))
  expect(child?.parent).toBe('s1-parent')
})

const localIssue = (id: string, title: string, status: Issue['status']): Issue => ({
  ...issue(id, title, status), origin: at('s1', 'github.com/o/repo'),
})

// Regression caught: returning to a lower task left the interleaved task doing alongside it.
test('interleave then continue back pops the side task and restores one doing issue', async () => {
  const issues = [localIssue('s1-a', 'main task', 'doing'), localIssue('s1-b', 'side task', 'todo')]
  const interleaved = compose({ stack: ['s1-a'], pending: [] }, {
    intent: 'interleave', target: 's1-b', title: null, rule: null, later: [], laterDrop: [],
  }, issues, () => 'unused')
  const afterInterleave = issues.map(issue => {
    const status = interleaved.payloads.filter(p => p.op === 'status' && p.issue === issue.id).at(-1)
    return status?.op === 'status' ? { ...issue, status: status.status } : issue
  })
  const returned = compose(interleaved.next, {
    intent: 'continue', target: 's1-a', title: null, rule: null, later: [], laterDrop: [],
  }, afterInterleave, () => 'unused')
  const afterReturn = afterInterleave.map(issue => {
    const status = returned.payloads.filter(p => p.op === 'status' && p.issue === issue.id).at(-1)
    return status?.op === 'status' ? { ...issue, status: status.status } : issue
  })
  expect(returned.next).toEqual({ stack: ['s1-a'], pending: ['s1-b'] })
  expect(afterReturn.filter(issue => issue.status === 'doing').map(issue => issue.id)).toEqual(['s1-a'])
})

// Regression caught: a handed-off task disappeared from both the focus stack and pending set.
test('handoff moves the old focus to pending as todo', async () => {
  const result = compose({ stack: ['s1-a'], pending: [] }, {
    intent: 'handoff', target: 's1-b', title: null, rule: null, later: [], laterDrop: [],
  }, [localIssue('s1-a', 'old task', 'doing'), localIssue('s1-b', 'new task', 'todo')], () => 'unused')
  expect(result.next).toEqual({ stack: ['s1-b'], pending: ['s1-a'] })
  expect(result.payloads).toContainEqual({ op: 'status', issue: 's1-a', status: 'todo' })
})

// Regression caught: every follow-up prompt rewrote the focused issue's status event.
test('continue to the current top emits no payloads', async () => {
  const result = compose({ stack: ['s1-a'], pending: [] }, {
    intent: 'continue', target: 's1-a', title: null, rule: null, later: [], laterDrop: [],
  }, [localIssue('s1-a', 'focused task', 'doing')], () => 'unused')
  expect(result.payloads).toEqual([])
})

// Regression caught: closed focus entries were reopened when a new task replaced the old top.
test('closed focus and pending entries are pruned before handoff', async () => {
  const result = compose({ stack: ['s1-a', 's1-done'], pending: ['s1-dropped'] }, {
    intent: 'handoff', target: 's1-b', title: null, rule: null, later: [], laterDrop: [],
  }, [
    localIssue('s1-a', 'old task', 'doing'),
    localIssue('s1-done', 'finished task', 'done'),
    localIssue('s1-dropped', 'abandoned task', 'dropped'),
    localIssue('s1-b', 'new task', 'todo'),
  ], () => 'unused')
  expect(result.next).toEqual({ stack: ['s1-b'], pending: ['s1-a'] })
  expect(result.payloads).not.toContainEqual({ op: 'status', issue: 's1-done', status: 'todo' })
  expect(result.payloads).not.toContainEqual({ op: 'status', issue: 's1-dropped', status: 'todo' })
})

// Regression caught: an untracked doing issue stayed active beside the focus stack's new top.
test('stray doing issues are demoted to preserve one doing focus', async () => {
  const result = compose({ stack: ['s1-a'], pending: [] }, {
    intent: 'handoff', target: 's1-b', title: null, rule: null, later: [], laterDrop: [],
  }, [
    localIssue('s1-a', 'old task', 'doing'),
    localIssue('s1-b', 'new task', 'todo'),
    localIssue('s1-c', 'stray task', 'doing'),
  ], () => 'unused')
  expect(result.next).toEqual({ stack: ['s1-b'], pending: ['s1-a', 's1-c'] })
  expect(result.payloads).toContainEqual({ op: 'status', issue: 's1-c', status: 'todo' })
})

// Regression caught: stack targets produced duplicate focus ids, a self-parent, or a second pending copy.
test('stack targets normalize to continue or leave the stack before pending', async () => {
  const issues = [
    localIssue('s1-a', 'first task', 'todo'),
    localIssue('s1-b', 'middle task', 'todo'),
    localIssue('s1-c', 'top task', 'doing'),
  ]
  const handoff = compose({ stack: ['s1-a', 's1-b', 's1-c'], pending: [] }, {
    intent: 'handoff', target: 's1-a', title: null, rule: null, later: [], laterDrop: [],
  }, issues, () => 'unused')
  expect(handoff.next).toEqual({ stack: ['s1-a'], pending: ['s1-c', 's1-b'] })
  expect(handoff.payloads).not.toContainEqual({ op: 'parent', issue: 's1-a', parent: 's1-c' })

  const interleaveTop = compose({ stack: ['s1-c'], pending: [] }, {
    intent: 'interleave', target: 's1-c', title: null, rule: null, later: [], laterDrop: [],
  }, issues, () => 'unused')
  expect(interleaveTop.payloads.some(payload => payload.op === 'parent' && payload.issue === 's1-c')).toBe(false)

  const pendingStackTarget = compose({ stack: ['s1-a', 's1-c'], pending: [] }, {
    intent: 'pending', target: 's1-a', title: null, rule: null, later: [], laterDrop: [],
  }, issues, () => 'unused')
  expect(pendingStackTarget.next).toEqual({ stack: ['s1-c'], pending: ['s1-a'] })

  const pendingTop = compose({ stack: ['s1-a', 's1-c'], pending: [] }, {
    intent: 'pending', target: 's1-c', title: null, rule: null, later: [], laterDrop: [],
  }, [
    localIssue('s1-a', 'first task', 'todo'),
    localIssue('s1-c', 'top task', 'todo'),
  ], () => 'unused')
  expect(pendingTop.next).toEqual({ stack: ['s1-a'], pending: ['s1-c'] })
  expect(pendingTop.payloads).toContainEqual({ op: 'status', issue: 's1-a', status: 'doing' })
})

// Regression caught: returning to a lower task lost open todo entries between it and the old top.
test('continuing to a lower task pends every popped open issue', async () => {
  const result = compose({ stack: ['s1-a', 's1-b', 's1-c'], pending: [] }, {
    intent: 'continue', target: 's1-a', title: null, rule: null, later: [], laterDrop: [],
  }, [
    localIssue('s1-a', 'main task', 'todo'),
    localIssue('s1-b', 'intermediate task', 'todo'),
    localIssue('s1-c', 'side task', 'doing'),
  ], () => 'unused')
  expect(result.next).toEqual({ stack: ['s1-a'], pending: ['s1-c', 's1-b'] })
  expect(result.payloads).toContainEqual({ op: 'status', issue: 's1-c', status: 'todo' })
  expect(result.payloads).not.toContainEqual({ op: 'status', issue: 's1-b', status: 'todo' })
})

// Regression caught: logs read in directory order (or per file) let an older status from another session overwrite a newer one.
test('merging two session logs, the later status of one issue wins', async () => {
  const a = at('aaaaaa11', 'github.com/o/r'), b = at('bbbbbb22', 'github.com/o/r')
  const logA = [
    line({ ts: '2026-10-06T01:00:00Z', seq: 1, issue: 'aaaaaa-1', origin: a, op: 'create', title: 'ship it', status: 'todo' }),
    line({ ts: '2026-10-06T03:00:00Z', seq: 2, issue: 'aaaaaa-1', origin: a, op: 'status', status: 'done' }),
  ].join('\n')
  const logB = line({ ts: '2026-10-06T02:00:00Z', seq: 1, issue: 'aaaaaa-1', origin: b, op: 'status', status: 'doing' })
  // B's file is read last, but A's status is the later one.
  const [issue] = snapshot([...parseLog(logA), ...parseLog(logB)])
  expect(issue!.status).toBe('done')
})

// Regression caught (c): every session's ledger listed the open issues of other sessions in the same repo, so one session's steps showed up as another's to-do list.
test('another session\'s tracker item does not appear in this session\'s ledger', async () => {
  const repo = 'github.com/o/repo'
  const events: TrackerEvent[] = [
    { ts: '2026-10-06T01:00:00Z', seq: 1, issue: 's1-1', origin: at('s1', repo), op: 'create', title: 'own', status: 'todo' },
    // Same repo, another session, updated a minute ago.
    { ts: '2026-10-06T01:00:01Z', seq: 1, issue: 's2-1', origin: at('s2', repo), op: 'create', title: 'other session', status: 'doing' },
    { ts: '2026-10-06T01:00:02Z', seq: 2, issue: 's2-2', origin: at('s2', repo), op: 'create', title: 'linked', status: 'todo' },
    { ts: '2026-10-06T01:00:03Z', seq: 2, issue: 's2-2', origin: at('s1', repo), op: 'link' },
  ]
  expect(injected(snapshot(events), { session: 's1' }).map(i => i.title)).toEqual(['own', 'linked'])
})

// --- a fold through the plugin ------------------------------------------------

const M = (role: 'user' | 'assistant', text: string): SessionMessage => ({ role, text, toolUses: [] } satisfies SessionMessage)
const compactInput = (trigger: SessionCompactInput['trigger'], messages: readonly SessionMessage[]) => ({ trigger, messages } satisfies SessionCompactInput)
const BIG = 'x'.repeat(4000)
const ROWS = [
  M('user', 'start'), M('assistant', BIG), M('user', 'next'), M('assistant', BIG),
  M('user', 'more'), M('assistant', 'ok'), M('user', 'last'), M('assistant', 'done'),
]
const NOTES = '## 목표\n- g'
const LOG = '/home/t/.claude-work/tracker/events/s1.jsonl'

// Regression caught: the merge model omits an issue it was shown and the ledger silently loses it (the old whole-ledger rewrite did exactly this).
test('a fold with no op for an existing issue keeps it in the ledger', { options: { budget: 2000, tailTarget: 1200, reserve: 100 } }, async ($, on) => {
  const files: Record<string, string> = {
    [LOG]: line({ ts: '2026-10-05T00:00:00Z', seq: 1, issue: 's1-1', origin: at('s1', 'github.com/o/repo'), op: 'create', title: 'migrate the db', status: 'todo' }),
  }
  const store: Record<string, unknown> = {}
  const prompts: string[] = []
  mock.clock(on, { now: Date.parse('2026-10-06T00:00:00Z') })
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete store[e.key]; return { value: undefined } })
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: ROWS }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000, tokens: 2000 }, rateLimits: [] } }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('env.get', () => ({ value: '/home/t' }))
  on('process.run', (_$: any, e: any) => ({ value: { exitCode: 0, stdout: e.argv.includes('get-url') ? 'https://github.com/o/repo.git' : 'main', stderr: '' } }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files || Object.keys(files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$: any, e: any) => ({
    value: Object.keys(files).filter(f => f.startsWith(`${e.path}/`)).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] }))
  on('fs.write', (_$: any, e: any) => { files[e.path] = e.text; return { value: undefined } })
  on('model.complete', (_$: any, e: any) => { prompts.push(e.prompt); return { value: { isAnswered: true, text: `${NOTES}\n\n<ops>[]</ops>`, usage: {} } } })
  on('ui.log', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.compact', () => ({ messages: [M('user', 'ENGINE SUMMARY')] }))

  const r = await $.session.compact(compactInput('auto', ROWS))
  if (!('messages' in r)) throw new Error('compaction returned no messages')
  expect(prompts[0]).toContain('s1-1 | todo | migrate the db')
  const row = r.messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(row).toMatch(/## Stack size\n0\n## Pending count\n0/)
  expect(row).not.toContain('migrate the db')
})
