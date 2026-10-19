import { test, expect } from 'claude-code/testing'

import { parseStepped } from './intent'
import { attemptState, debateRubric, judgeRubric, parseRubric, steppedRootOf, type JudgeIo, type ModelIo } from './stepped'
import { describe, parseLog, snapshot, toEvents, type Issue, type Payload } from './tracker'
import { M, seedTracker, TRACKER } from './clm-test-support'
import type { Worktree } from './worktree'

const origin = { session: 'step-session', repo: 'github.com/o/repo', cwd: '/w' }
const answer = (text: string) => ({ isAnswered: true, text, reason: '' })
const RUBRIC = JSON.stringify({ items: [{ id: 'tests', kind: 'command', argv: ['bun', 'test'] }] })
const BASE_SHA = 'a'.repeat(40)
const CHECKPOINT_SHA = 'b'.repeat(40)
const STEP_WORKTREE: Worktree = {
  dir: '/home/t/.claude-work/clm/worktrees/s1/s1-root', baseSha: BASE_SHA, headSha: BASE_SHA,
  originBranch: 'main', repoRoot: '/work/repo', worktreesRoot: '/home/t/.claude-work/clm/worktrees',
}

let steppedFixtureMtime = 10
function steppedStopFixture(
  on: any,
  payloads: Payload[],
  run: (argv: string[], options: any) => { exitCode: number; stdout: string; stderr: string } | Error = defaultProcessResult,
  options: { messages?: any[]; modelComplete?: () => unknown } = {},
) {
  const files: Record<string, string> = {}
  seedTracker({ files }, payloads)
  const mtimes: Record<string, number> = { [TRACKER]: ++steppedFixtureMtime }
  const store: Record<string, unknown> = {}
  const logs: string[] = []
  const commands: string[][] = []
  let panelId = 0
  on('session.id', () => ({ value: 's1' }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('session.messages', () => ({ value: options.messages ?? [M('assistant', 'checked the step')] }))
  on('env.get', () => ({ value: '/home/t' }))
  on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
  on('store.set', (_$: any, e: any) => { store[e.key] = e.value; return { value: undefined } })
  on('state.get', () => ({ value: undefined, version: 0 }))
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv]
    commands.push(argv)
    const result = run(argv, e)
    if (result instanceof Error) throw result
    return { value: result }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files || Object.keys(files).some(path => path.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$: any, e: any) => ({
    value: Object.keys(files).filter(path => path.startsWith(`${e.path}/`) && !path.slice(e.path.length + 1).includes('/'))
      .map(path => ({ name: path.slice(e.path.length + 1), kind: 'file', size: files[path]!.length, mtimeMs: mtimes[path] ?? 0, isLink: false })),
  }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] ?? '' }))
  on('fs.write', (_$: any, e: any) => {
    files[e.path] = e.text
    mtimes[e.path] = ++steppedFixtureMtime
    return { value: undefined }
  })
  on('model.complete', () => ({ value: options.modelComplete?.() ?? { isAnswered: true, text: '{"pass":true,"reason":"evidence verified"}', usage: {} } }))
  on('ui.log', (_$: any, e: any) => { logs.push(e.text); return { value: undefined } })
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: `panel-${++panelId}` } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$: any, e: any) => ({ result: { taskId: e.taskId, success: true } }))
  return { files, logs, commands }
}

function defaultProcessResult(argv: string[], options: any) {
  if (argv[0] !== 'git') {
    if (argv[0] === 'false') return { exitCode: 1, stdout: '', stderr: 'deliberate rubric failure' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const cIndex = argv.indexOf('-C')
  const gitCwd = cIndex < 0 ? options.cwd : argv[cIndex + 1]
  if (argv.includes('remote')) return { exitCode: 0, stdout: 'https://github.com/o/repo.git', stderr: '' }
  if (argv.includes('list')) return { exitCode: 0, stdout: `worktree /work/repo\nworktree ${STEP_WORKTREE.dir}\n`, stderr: '' }
  if (argv.includes('--show-toplevel')) return { exitCode: 0, stdout: `${gitCwd || '/work/repo'}\n`, stderr: '' }
  if (argv.at(-1) === 'HEAD') return { exitCode: 0, stdout: `${CHECKPOINT_SHA}\n`, stderr: '' }
  return { exitCode: 0, stdout: argv.includes('--abbrev-ref') ? 'main\n' : '', stderr: '' }
}

const stepPayloads = (extra: Payload[] = []): Payload[] => [
  { op: 'create', issue: 's1-root', title: 'Ship the feature', status: 'doing' },
  { op: 'stepped', issue: 's1-root' },
  { op: 'worktree', issue: 's1-root', ...STEP_WORKTREE },
  { op: 'create', issue: 's1-step-1', title: 'Implement the parser', status: 'doing' },
  { op: 'parent', issue: 's1-step-1', parent: 's1-root' },
  { op: 'rubric', issue: 's1-step-1', items: [{ id: 'tests', kind: 'command', argv: ['true'] }] },
  { op: 'method', issue: 's1-step-1', text: 'replace parser state', failed: false },
  { op: 'focus', stack: ['s1-root'], pending: [], intent: 'continue' },
  ...extra,
]

// Regression caught: the stepped ops land in the log but snapshot drops them, so B reads no rubric, attempts or methods.
test('snapshot folds the stepped marker, the latest rubric, attempts and per-text methods', async () => {
  const payloads: Payload[] = [
    { op: 'create', issue: 'root', title: 'goal', status: 'doing' },
    { op: 'stepped', issue: 'root' },
    { op: 'create', issue: 'step', title: 'step one', status: 'doing' },
    { op: 'parent', issue: 'step', parent: 'root' },
    { op: 'rubric', issue: 'step', items: [{ id: 'old', kind: 'evidence', criterion: 'old' }] },
    { op: 'rubric', issue: 'step', items: [{ id: 'tests', kind: 'command', argv: ['bun', 'test'] }] },
    { op: 'attempt', issue: 'step', method: 'patch the parser', verdict: 'fail' },
    { op: 'method', issue: 'step', text: 'patch the parser', failed: false },
    { op: 'method', issue: 'step', text: 'patch the parser', failed: true },
    { op: 'method', issue: 'step', text: 'patch the parser', failed: false },
  ]
  const events = toEvents(payloads, origin, 0, '2026-10-19T00:00:00Z')
  const issues = snapshot(events)
  const byId = new Map(issues.map(i => [i.id, i]))
  expect(byId.get('root')?.stepped).toBe(true)
  const step = byId.get('step')
  expect(step?.rubric).toEqual([{ id: 'tests', kind: 'command', argv: ['bun', 'test'] }])
  expect(step?.attempts?.map(a => [a.method, a.verdict])).toEqual([['patch the parser', 'fail']])
  expect(step?.methods).toEqual([{ text: 'patch the parser', failed: true, failures: 1 }])
  expect(step?.activeMethod).toBe('patch the parser')
  expect(steppedRootOf('step', byId)?.id).toBe('root')
  expect(steppedRootOf('root', byId)).toBeUndefined()
  expect(describe(events.slice(4), issues)).toContain("작업 'step one' 완료 기준 1개 확정")
})

// Regression caught: a rubric item no command or quote can settle is stored and later judged as passing.
test('parseRubric rejects an empty argv, a duplicate id and a relative cwd', async () => {
  expect(parseRubric(RUBRIC)).toEqual([{ id: 'tests', kind: 'command', argv: ['bun', 'test'] }])
  expect(typeof parseRubric('{"items":[{"id":"a","kind":"command","argv":[]}]}')).toBe('string')
  expect(typeof parseRubric('{"items":[{"id":"a","kind":"evidence","criterion":"x"},{"id":"a","kind":"evidence","criterion":"y"}]}')).toBe('string')
  expect(typeof parseRubric('{"items":[{"id":"a","kind":"command","argv":["ls"],"cwd":"rel"}]}')).toBe('string')
})

// Regression caught: the debate stops after one round or keeps the first draft instead of the final revision.
test('debateRubric runs two review rounds and returns the last revision, failing soft on a model error', async () => {
  const systems: string[] = []
  let drafts = 0
  const io: ModelIo = {
    complete: async request => {
      systems.push(request.system.startsWith('You are the adversarial') ? 'attack' : 'draft')
      if (systems.at(-1) === 'attack') return answer('{"points":[]}')
      drafts += 1
      return answer(JSON.stringify({ items: [{ id: `v${drafts}`, kind: 'evidence', criterion: `version ${drafts}` }] }))
    },
  }
  const input = { goal: 'g', step: 's', notes: [], siblings: [], cwd: '/w' }
  expect(await debateRubric(io, input)).toEqual([{ id: 'v3', kind: 'evidence', criterion: 'version 3' }])
  expect(systems).toEqual(['draft', 'attack', 'draft', 'attack', 'draft'])
  const failing: ModelIo = { complete: async () => ({ isAnswered: false, text: '', reason: 'timeout' }) }
  expect(await debateRubric(failing, input)).toContain('timeout')
})

const QUOTE = 'all 42 tests passed in the auth suite'

// Regression caught: an evidence item passes on an uncited or fabricated quote, or a command passes on a non-zero exit.
test('judgeRubric passes commands on exit 0 and evidence only on a held quote the judge accepts', async () => {
  let judged = 0
  const io: JudgeIo = {
    run: async argv => ({ exitCode: argv[0] === 'true' ? 0 : 1, stdout: '', stderr: 'boom' }),
    sources: async () => new Map([['m1', { kind: 'tool_result' as const, text: `bun test: ${QUOTE}` }]]),
    complete: async () => { judged += 1; return answer('{"pass":true,"reason":"shows the suite passing"}') },
  }
  const issue: Pick<Issue, 'rubric'> = {
    rubric: [
      { id: 'ok', kind: 'command', argv: ['true'] },
      { id: 'bad', kind: 'command', argv: ['false'] },
      { id: 'proved', kind: 'evidence', criterion: 'auth tests pass' },
      { id: 'fake', kind: 'evidence', criterion: 'auth tests pass' },
      { id: 'uncited', kind: 'evidence', criterion: 'auth tests pass' },
    ],
  }
  const verdicts = await judgeRubric(issue, io, { proved: { ref: 'm1', quote: QUOTE }, fake: { ref: 'm1', quote: 'all 43 tests passed in the payment suite' } })
  expect(verdicts.map(v => [v.id, v.pass])).toEqual([['ok', true], ['bad', false], ['proved', true], ['fake', false], ['uncited', false]])
  expect(judged).toBe(1)
})

// Regression caught: B rolls back before two failed tries with one methodology, or never stops after five failed methodologies.
test('attemptState counts trailing failures of the current method and failed methodologies', async () => {
  const at = (method: string, verdict: 'pass' | 'fail') => ({ method, verdict, ts: '' })
  expect(attemptState({ attempts: [at('a', 'fail'), at('b', 'fail')] })).toMatchObject({ method: 'b', triesWithMethod: 1, rollback: false })
  expect(attemptState({ attempts: [at('a', 'fail'), at('b', 'fail'), at('b', 'fail')] })).toMatchObject({ triesWithMethod: 2, rollback: true })
  const methods = ['a', 'b', 'c', 'd', 'e'].map(text => ({ text, failed: true }))
  expect(attemptState({ methods: methods.slice(0, 4) }).stop).toBe(false)
  expect(attemptState({ methods }).stop).toBe(true)
  expect(attemptState({ activeMethod: 'a', attempts: [at('a', 'fail'), at('a', 'fail')], methods: [{ text: 'a', failed: true, failures: 1 }] }))
    .toMatchObject({ triesWithMethod: 2, failedMethods: 1, rollback: true })
})

// Regression caught: the second failed check for one method left partial edits in place without recording that method as failed.
test('the same methodology failing twice rolls back and records a failed method', async ($, on) => {
  const fixture = steppedStopFixture(on, stepPayloads([
    { op: 'rubric', issue: 's1-step-1', items: [{ id: 'tests', kind: 'command', argv: ['false'] }] },
  ]))
  const first = await $.classic.Stop({ stop_hook_active: false })
  expect(first.block).toContain('rubric failed')
  const second = await $.classic.Stop({ stop_hook_active: false })
  expect(second.block).toContain('rolled back')
  expect(second.block).toContain('different method')
  expect(fixture.commands.some(argv => argv.includes('reset') && argv.includes('--hard') && argv.includes(BASE_SHA))).toBe(true)
  const events = parseLog(fixture.files[TRACKER] ?? '')
  expect(events.some(event => event.op === 'method' && event.issue === 's1-step-1' && event.text === 'replace parser state' && event.failed)).toBe(true)
})

// Regression caught: a stepped task kept blocking Stop after five methodologies had already failed.
test('five failed methodologies allow stop and surface the stopped goal', async ($, on) => {
  const methods = ['rewrite parser', 'replace parser', 'split parser', 'cache parser', 'regenerate parser']
  const fixture = steppedStopFixture(on, stepPayloads(methods.map(text => ({ op: 'method', issue: 's1-step-1', text, failed: true }))))
  const result = await $.classic.Stop({ stop_hook_active: false })
  expect(result.block).toBeUndefined()
  expect(fixture.logs.join('\n')).toContain('stopped after five failed methodologies')
  for (const method of methods) expect(fixture.logs.join('\n')).toContain(method)
})

// Regression caught: a passing rubric completed a step without a checkpoint or a handoff to the next recorded step.
test('an all-pass rubric checkpoints the step and advances to the next step', async ($, on) => {
  const fixture = steppedStopFixture(on, stepPayloads([
    { op: 'create', issue: 's1-step-2', title: 'Update parser tests', status: 'todo' },
    { op: 'parent', issue: 's1-step-2', parent: 's1-root' },
  ]))
  const result = await $.classic.Stop({ stop_hook_active: false })
  expect(result.block).toContain('Step done: Implement the parser')
  expect(result.block).toContain('Next step: Update parser tests')
  expect(fixture.commands.some(argv => argv.includes('commit') && argv.includes('--allow-empty'))).toBe(true)
  const issues = snapshot(parseLog(fixture.files[TRACKER] ?? ''))
  expect(issues.find(issue => issue.id === 's1-step-1')?.status).toBe('done')
  expect(issues.find(issue => issue.id === 's1-step-1')?.checkpoints).toEqual([{ sha: CHECKPOINT_SHA, ts: expect.any(String) }])
})

// Regression caught: a broken process runner turned an internal judge error into a Stop loop the user could not leave.
test('an internal judge error allows stop and reports its command diagnostics', async ($, on) => {
  const fixture = steppedStopFixture(on, stepPayloads([
    { op: 'rubric', issue: 's1-step-1', items: [{ id: 'tests', kind: 'evidence', criterion: 'the tests passed' }] },
  ]), defaultProcessResult, {
    messages: [M('user', QUOTE), M('assistant', 'checked the step')],
    modelComplete: () => ({ isAnswered: false, text: '', reason: 'judge timeout' }),
  })
  const result = await $.classic.Stop({
    stop_hook_active: false,
    last_assistant_message: `<clm-step-citations>[{"id":"tests","ref":"m1","quote":"${QUOTE}"}]</clm-step-citations>`,
  })
  expect(result.block).toBeUndefined()
  const log = fixture.logs.join('\n')
  expect(log).toContain('judge internal error')
  expect(log).toContain('issue=s1-step-1')
  expect(log).toContain('reason=judge did not answer')
  expect(log).toContain('exitCode=unavailable')
  expect(log).toContain('judge timeout')
})

// Regression caught: a classifier reply in the older shape, without `stepped`, marks every request as a stepped goal.
test('parseStepped reads only a literal true', async () => {
  expect(parseStepped('{"intent":"continue","stepped":true}')).toBe(true)
  expect(parseStepped('{"intent":"continue"}')).toBe(false)
  expect(parseStepped('{"intent":"continue","stepped":"yes"}')).toBe(false)
})
