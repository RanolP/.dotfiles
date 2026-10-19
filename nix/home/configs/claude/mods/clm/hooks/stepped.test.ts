import { test, expect } from 'claude-code/testing'

import { parseStepped } from './intent'
import { attemptState, debateRubric, judgeRubric, parseRubric, steppedRootOf, type JudgeIo, type ModelIo } from './stepped'
import { describe, snapshot, toEvents, type Issue, type Payload } from './tracker'

const origin = { session: 'step-session', repo: 'github.com/o/repo', cwd: '/w' }
const answer = (text: string) => ({ isAnswered: true, text, reason: '' })
const RUBRIC = JSON.stringify({ items: [{ id: 'tests', kind: 'command', argv: ['bun', 'test'] }] })

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
  ]
  const events = toEvents(payloads, origin, 0, '2026-10-19T00:00:00Z')
  const issues = snapshot(events)
  const byId = new Map(issues.map(i => [i.id, i]))
  expect(byId.get('root')?.stepped).toBe(true)
  const step = byId.get('step')
  expect(step?.rubric).toEqual([{ id: 'tests', kind: 'command', argv: ['bun', 'test'] }])
  expect(step?.attempts?.map(a => [a.method, a.verdict])).toEqual([['patch the parser', 'fail']])
  expect(step?.methods).toEqual([{ text: 'patch the parser', failed: true }])
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
})

// Regression caught: a classifier reply in the older shape, without `stepped`, marks every request as a stepped goal.
test('parseStepped reads only a literal true', async () => {
  expect(parseStepped('{"intent":"continue","stepped":true}')).toBe(true)
  expect(parseStepped('{"intent":"continue"}')).toBe(false)
  expect(parseStepped('{"intent":"continue","stepped":"yes"}')).toBe(false)
})
