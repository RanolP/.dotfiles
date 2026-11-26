import { test, expect, type Engine } from 'claude-code/testing'

import { evaluate } from './eval'
import { renderRange } from './evidence'
import { extractTurn } from './extract'
import { readWayseekerLedger, wayseekerKey } from './render'
import { sayLines } from './say'
import { debateRubric, judgeRubric, parseRubric, writeStepRule, writeVerdicts, type JudgeIo, type ModelIo, type RubricItem } from './stepped'
import { appendAll, type Ledger } from './store'

const answer = (text: string) => ({ isAnswered: true, text, reason: '' })
const ITEMS: RubricItem[] = [{ id: 'tests', kind: 'command', argv: ['bun', 'test'] }, { id: 'types', kind: 'command', argv: ['tsc'] }]
const holds = (ledger: Ledger, fact: string) => evaluate(ledger).facts.get(fact)?.value === 'true'
const pass = (id: string) => ({ id, pass: true, reason: 'exit 0' })
const fail = (id: string) => ({ id, pass: false, reason: 'exit 1' })
// A goal grouping two steps, the agent's own lines as say would land them.
const goalLedger = (): Ledger => {
  let ledger = appendAll(['decl ready(goal) key(goal) "{goal}을 시작할 수 있다"'])
  ledger = writeStepRule(ledger, 'parser', ITEMS).ledger
  ledger = writeStepRule(ledger, 'docs', [{ id: 'readme', kind: 'command', argv: ['true'] }]).ledger
  return sayLines(ledger, ['done(parser), done(docs) -> ready(ship)', 'ready(ship) -> done(ship)'], 'agent').ledger
}

// Regression caught: the agent closes a rubric step by saying so, skipping the check its rubric exists for.
test('an agent or worker line asserting done or pass of a rubric step is rejected; other steps and goal rules stand', async () => {
  const ledger = goalLedger()
  const said = sayLines(ledger, ['say(done(parser))', 'say(pass(parser, tests))', 'pass(parser, types) -> done(parser)', 'say(done(other))'], 'agent')
  expect(said.rejected.map(r => r.line.replace(/^@\d+ agent: /, ''))).toEqual(['say(done(parser))', 'say(pass(parser, tests))', 'pass(parser, types) -> done(parser)'])
  expect(said.rejected[0]?.error).toContain('call the check tool')
  expect(said.landed).toHaveLength(1)
  expect(sayLines(ledger, ['say(done(docs))'], 'worker').rejected).toHaveLength(1)
  // A check line may not be smuggled in through extraction either.
  const extracted = await extractTurn({ complete: async () => answer('\x60\x60\x60\n@9 check: say(pass(parser, tests))\n\x60\x60\x60') }, ledger, 'x', '')
  expect(extracted.appended).toEqual([])
  // Nor an agent's done claim, which extraction lands without the say tool's checks.
  const claimed = await extractTurn({ complete: async () => answer('\x60\x60\x60\n@9 agent: say(done(parser))\n\x60\x60\x60') }, ledger, 'x', '')
  expect(claimed.appended).toEqual([])
})

// Regression caught: re-recording a step whose new rubric reuses an item id keeps done(step) on the old run's pass.
test('re-recording a step withdraws its old passes, so done(step) waits for a new check', async () => {
  let ledger = writeStepRule(appendAll([]), 'parser', ITEMS).ledger
  ledger = writeVerdicts(ledger, 'parser', [pass('tests'), pass('types')]).ledger
  expect(holds(ledger, 'done(parser)')).toBe(true)
  ledger = writeStepRule(ledger, 'parser', [{ id: 'tests', kind: 'command', argv: ['bun', 'test', 'new'] }]).ledger
  expect(holds(ledger, 'done(parser)')).toBe(false)
  ledger = writeVerdicts(ledger, 'parser', [pass('tests')]).ledger
  expect(holds(ledger, 'done(parser)')).toBe(true)
})

// Regression caught: a done claim or a done rule the agent wrote before the step had a rubric still closes it.
test('recording a step withdraws earlier agent done claims and done rules for it', async () => {
  let ledger = appendAll(['decl done(task) key(task) "{task}을 마쳤다"', 'decl ok(x) key(x) "{x} ok"'])
  // One say call per line: lines of one call share an @n, and reject withdraws the whole id.
  for (const line of ['say(done(parser))', 'ok(parser) -> done(parser)', 'ok(?x) -> done(?x)', 'say(done(other))']) ledger = sayLines(ledger, [line], 'agent').ledger
  expect(holds(ledger, 'done(parser)')).toBe(true)
  ledger = writeStepRule(ledger, 'parser', ITEMS).ledger
  expect(holds(ledger, 'done(parser)')).toBe(false)
  const said = sayLines(ledger, ['say(ok(parser))'], 'agent')
  expect(said.rejected).toEqual([])
  expect(holds(said.ledger, 'done(parser)')).toBe(false)
  // A step without a rubric keeps the agent's own claim.
  expect(holds(said.ledger, 'done(other)')).toBe(true)
})

// Regression caught: the rubric rule or the goal rules fail the term-cycle guard or never derive done of the goal.
test('check pass lines derive done(step), and through the goal rules done(goal)', async () => {
  let ledger = goalLedger()
  expect(writeStepRule(ledger, 'parser', ITEMS).errors).toEqual([])
  ledger = writeVerdicts(ledger, 'parser', [pass('tests'), fail('types')]).ledger
  expect(holds(ledger, 'done(parser)')).toBe(false)
  ledger = writeVerdicts(ledger, 'parser', [pass('tests'), pass('types')]).ledger
  ledger = writeVerdicts(ledger, 'docs', [pass('readme')]).ledger
  const result = evaluate(ledger)
  expect(result.fuelExhausted).toBe(false)
  expect(holds(ledger, 'done(parser)')).toBe(true)
  expect(holds(ledger, 'done(ship)')).toBe(true)
  // A re-run of a still-passing item writes nothing new.
  expect(writeVerdicts(ledger, 'parser', [pass('tests'), pass('types')]).landed).toEqual([])
})

// Regression caught: a step that passed once stays done after its check starts failing.
test('a later failing check withdraws the pass and with it done(step) and done(goal)', async () => {
  let ledger = goalLedger()
  ledger = writeVerdicts(ledger, 'parser', [pass('tests'), pass('types')]).ledger
  ledger = writeVerdicts(ledger, 'docs', [pass('readme')]).ledger
  expect(holds(ledger, 'done(ship)')).toBe(true)
  const rerun = writeVerdicts(ledger, 'parser', [pass('tests'), fail('types')])
  expect(rerun.landed).toHaveLength(1)
  expect(rerun.landed[0]).toMatch(/check: reject\(@\d+\)$/)
  expect(holds(rerun.ledger, 'done(parser)')).toBe(false)
  expect(holds(rerun.ledger, 'done(ship)')).toBe(false)
  // The agent cannot withdraw check's verdict in turn.
  expect(sayLines(rerun.ledger, ['reject(@' + /@(\d+)/.exec(rerun.landed[0]!)![1] + ')'], 'agent').rejected).toHaveLength(1)
})

// Regression caught: a rubric item no command or quote can settle, or whose id is no ledger atom, is stored and judged.
test('parseRubric rejects an empty argv, a duplicate id, a relative cwd and a hyphenated id', async () => {
  expect(parseRubric('{"items":[{"id":"tests","kind":"command","argv":["bun","test"]}]}')).toEqual([{ id: 'tests', kind: 'command', argv: ['bun', 'test'] }])
  expect(typeof parseRubric('{"items":[{"id":"a","kind":"command","argv":[]}]}')).toBe('string')
  expect(typeof parseRubric('{"items":[{"id":"a","kind":"evidence","criterion":"x"},{"id":"a","kind":"evidence","criterion":"y"}]}')).toBe('string')
  expect(typeof parseRubric('{"items":[{"id":"a","kind":"command","argv":["ls"],"cwd":"rel"}]}')).toBe('string')
  expect(typeof parseRubric('{"items":[{"id":"tests-pass","kind":"command","argv":["ls"]}]}')).toBe('string')
  expect(typeof parseRubric('{"items":[]}')).toBe('string')
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
      return answer(JSON.stringify({ items: [{ id: 'v' + drafts, kind: 'evidence', criterion: 'version ' + drafts }] }))
    },
  }
  const input = { goal: 'g', step: 's', notes: [], siblings: [], cwd: '/w' }
  expect(await debateRubric(io, input)).toEqual([{ id: 'v3', kind: 'evidence', criterion: 'version 3' }])
  expect(systems).toEqual(['draft', 'attack', 'draft', 'attack', 'draft'])
  expect(await debateRubric({ complete: async () => ({ isAnswered: false, text: '', reason: 'timeout' }) }, input)).toContain('timeout')
})

const QUOTE = 'all 42 tests passed in the auth suite'
const RANGE = [
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'toolu_1', tool: 'Bash', input: { command: 'bun test' } }] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: 'bun test: ' + QUOTE, isError: false }] },
] as unknown as Parameters<typeof renderRange>[0]

// Regression caught: an evidence item passes on an uncited or fabricated quote, or a command passes on a non-zero exit.
test('judgeRubric passes commands on exit 0 and evidence only on a held quote the judge accepts', async () => {
  let judged = 0
  const cwds: (string | undefined)[] = []
  const io: JudgeIo = {
    run: async (argv, options) => { cwds.push(options.cwd); return { exitCode: argv[0] === 'true' ? 0 : 1, stdout: '', stderr: 'boom' } },
    sources: async () => renderRange(RANGE).sources,
    complete: async () => { judged += 1; return answer('{"pass":true,"reason":"shows the suite passing"}') },
  }
  const items: RubricItem[] = [
    { id: 'ok', kind: 'command', argv: ['true'] },
    { id: 'bad', kind: 'command', argv: ['false'], cwd: '/elsewhere' },
    { id: 'proved', kind: 'evidence', criterion: 'auth tests pass' },
    { id: 'fake', kind: 'evidence', criterion: 'auth tests pass' },
    { id: 'uncited', kind: 'evidence', criterion: 'auth tests pass' },
  ]
  const verdicts = await judgeRubric(items, io, { proved: { ref: 'toolu_1', quote: QUOTE }, fake: { ref: 'toolu_1', quote: 'all 43 tests passed in the payment suite' } }, '/repo')
  expect(verdicts.map(v => [v.id, v.pass])).toEqual([['ok', true], ['bad', false], ['proved', true], ['fake', false], ['uncited', false]])
  expect(judged).toBe(1)
  expect(cwds).toEqual(['/repo', '/elsewhere'])
})

// Regression caught: the step and check tools are not wired to the ledger, so the agent's calls change nothing.
test('the step tool lands the rubric rule and the check tool lands passes that make done(step) hold', async ($: Engine, on: any) => {
  const files: Record<string, string> = {}
  let exit = 0
  on('env.get', () => ({ value: '/home/t' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: [] }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] }))
  on('fs.write', (_$: any, e: any) => { files[e.path] = e.text; return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: exit, stdout: '', stderr: '' } }))
  on('model.complete', (_$: any, e: any) => ({ value: answer(e.system.startsWith('You are the adversarial') ? '{"points":[]}' : '{"items":[{"id":"tests","kind":"command","argv":["bun","test"]}]}') }))
  const call = async (tool: string, input: Record<string, unknown>) => JSON.parse(((await $.tool.call({ tool, ...input } as unknown as Parameters<Engine['tool']['call']>[0])) as { result: string }).result)
  const ledger = () => readWayseekerLedger(JSON.parse(files['/home/t/.claude-work/plans/wayseeker-s1.json'] ?? '{}')[wayseekerKey('s1:main')])
  const stepped = await call('mcp__wayseeker__step', { goal: 'ship the parser', step: 'parser', cwd: '/repo' })
  expect(stepped.landed.at(-1)).toMatch(/check: pass\(parser, tests\) -> done\(parser\)$/)
  expect((await call('mcp__wayseeker__check', { step: 'parser' })).done).toBe(true)
  exit = 1
  const failed = await call('mcp__wayseeker__check', { step: 'parser' })
  expect(failed.done).toBe(false)
  expect(failed.verdicts[0].pass).toBe(false)
  expect(holds(ledger(), 'done(parser)')).toBe(false)
})
