import { test, expect } from 'claude-code/testing'

import { describe, injected, parseLog, snapshot, type Issue, type TrackerEvent } from './tracker'

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
  ])
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

// Regression caught: an issue from another repository leaks into every session's ledger, or a linked one is left out.
test('an unlinked issue from another repo is not injected', async () => {
  const other = at('cccccc33', 'github.com/o/other')
  const events: TrackerEvent[] = [
    { ts: '2026-10-06T01:00:00Z', seq: 1, issue: 'cccccc-1', origin: other, op: 'create', title: 'unlinked', status: 'todo' },
    { ts: '2026-10-06T01:00:01Z', seq: 2, issue: 'cccccc-2', origin: other, op: 'create', title: 'linked', status: 'todo' },
    { ts: '2026-10-06T01:00:02Z', seq: 1, issue: 'cccccc-2', origin: at('s1', 'github.com/o/repo'), op: 'link' },
  ]
  const shown = injected(snapshot(events), { session: 's1', repo: 'github.com/o/repo' })
  expect(shown.map(i => i.title)).toEqual(['linked'])
})

// --- a fold through the plugin ------------------------------------------------

const M = (role: 'user' | 'assistant', text: string) => ({ role, text, toolUses: [] }) as any
const BIG = 'x'.repeat(4000)
const ROWS = [
  M('user', 'start'), M('assistant', BIG), M('user', 'next'), M('assistant', BIG),
  M('user', 'more'), M('assistant', 'ok'), M('user', 'last'), M('assistant', 'done'),
]
const NOTES = '## 목표\n- g\n\n## 사용자 지시\n- "start"\n\n## 핵심 사실·경로\n- f'
const LOG = '/home/t/.claude-work/tracker/events/old-session.jsonl'

// Regression caught: the merge model omits an issue it was shown and the ledger silently loses it (the old whole-ledger rewrite did exactly this).
test('a fold with no op for an existing issue keeps it in the ledger', { options: { budget: 2000, tailTarget: 1200, reserve: 100 } }, async ($, on) => {
  const files: Record<string, string> = {
    [LOG]: line({ ts: '2026-10-05T00:00:00Z', seq: 1, issue: 'old-se-1', origin: at('old-session', 'github.com/o/repo'), op: 'create', title: 'migrate the db', status: 'todo' }),
  }
  const store: Record<string, unknown> = {}
  const prompts: string[] = []
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete store[e.key]; return { value: undefined } })
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: ROWS }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
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

  const r: any = await $.session.compact({ trigger: 'auto', messages: ROWS } as any)
  expect(prompts[0]).toContain('old-se-1 | todo | migrate the db')
  const row = r.messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(row).toMatch(/## 할 일\n- migrate the db \[old-se-1\]/)
})
