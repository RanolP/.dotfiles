import { test, expect } from 'claude-code/testing'

import { appendAll } from './store'
import { evaluate } from './eval'
import { countUserRows, dropWayseekerTurns, landWayseekerTurn, renderInstructions, turnIsLive, wayseekerKey } from './render'
import { promptFingerprint, reconcilePrompts } from './rewind'
import { writeStepRule, writeVerdicts, type RubricItem } from './stepped'
import type { Ledger } from './store'

const DECLS = [
  'decl use(role, tool) key(role) "{role}에 {tool}을 쓴다"',
  'decl raise_on(topic) key(topic) "{topic} 충돌은 사용자에게 묻는다"',
  'serving := "서빙"',
]
const render = (lines: string[]) => {
  const ledger = appendAll([...DECLS, ...lines])
  return renderInstructions(ledger, evaluate(ledger))
}

// Regression caught: a stale instruction stays resident after the user corrects it.
test('a superseded instruction (sglang replaced by vllm) is not rendered', () => {
  const out = render(['@1 user: want(use(serving, sglang))', '@2 user: reject(@1)', '@2 user: want(use(serving, vllm))'])
  expect(out).toContain('- 서빙에 vllm을(를) 쓴다. (@2)')
  expect(out).not.toContain('sglang')
})

// Regression caught: a conflict the user asked to be raised on resolves silently.
test('a raise-mode conflict appears under raises', () => {
  const out = render(['@1 user: say(raise_on(serving))', '@2 user: say(use(serving, sglang))', '@3 agent: say(use(serving, vllm))'])
  const raises = out.split('## raises')[1] ?? ''
  expect(raises).toContain('sglang')
  expect(raises).toContain('vllm')
  expect(raises).toContain('사용자에게 묻는다')
})

// Regression caught: the user's observations and reports ("there's no panel", "rebuilt.") injected every turn as
// instructions, a want the agent already did (say(done(p))) staying there, a standing preference vanishing once the
// agent reports following it (say(p)), and a conditional want (p -> want(q)) never rendering.
test('only open user wants render as instructions', () => {
  const OBSERVED = ['decl exist(thing) key(thing) "{thing}이 존재한다"', 'decl done(task) key(task) "{task}이 완료되었다"', 'panel := "패널"']
  const said = ['@1 user: say(not(exist(panel)))', '@1 user: say(done(rebuild))', '@2 user: want(use(serving, vllm))']
  expect(render([...OBSERVED, ...said])).toBe('## user instructions\n\n- 서빙에 vllm을(를) 쓴다. (@2)')
  expect(render([...OBSERVED, ...said, '@3 agent: say(use(serving, vllm))'])).toBe('## user instructions\n\n- 서빙에 vllm을(를) 쓴다. (@2)')
  expect(render([...OBSERVED, ...said, '@3 agent: say(done(use(serving, vllm)))'])).toBe('## user instructions\n\n- (none yet)')
  expect(render([...OBSERVED, '@1 user: exist(panel) -> want(use(serving, vllm))'])).toBe('## user instructions\n\n- 패널이 존재한다면 서빙에 vllm을(를) 쓴다. (@1)')
})

// Regression caught: glosses written with one particle form rendered "작업 재개이", "문제을", "방식(과제 76)로".
test('a particle after a filled column follows the filled text\'s last syllable', () => {
  const out = render([
    'decl done(task) key(task) "{task}이 완료되었다"', 'decl fix(issue, method) key(issue) "{issue}을 {method}로 고친다"',
    'resume := "작업 재개"', 'noise := "문제"', 'split := "분리하는 방식(과제 76)"', 'learned := "모델"',
    '@1 user: want(done(resume))', '@2 user: want(fix(noise, split))', '@3 user: want(done(rebuild))', '@4 user: want(fix(rebuild, learned))',
  ])
  expect(out).toContain('- 작업 재개가 완료되었다. (@1)')
  expect(out).toContain('- 문제를 분리하는 방식(과제 76)으로 고친다. (@2)')
  expect(out).toContain('- rebuild이(가) 완료되었다. (@3)')
  expect(out).toContain('- rebuild을(를) 모델로 고친다. (@4)')
})

const ITEMS: RubricItem[] = [{ id: 'tests_pass', kind: 'command', argv: ['true'] }, { id: 'banner', kind: 'evidence', criterion: 'the banner shows' }]
// A step with a rubric whose items pass as given; check writes the rule and the verdicts, as the step and check tools do.
const stepped = (ledger: Ledger, step: string, passing: readonly string[]): Ledger => {
  const ruled = writeStepRule(ledger, step, ITEMS).ledger
  return writeVerdicts(ruled, step, ITEMS.map(item => ({ id: item.id, pass: passing.includes(item.id), reason: '' }))).ledger
}

// Regression caught: step progress invisible in the resident section, so after a compaction the agent re-checks or skips steps.
test('a stepped ledger shows each step with passed k/n and whether it is done', () => {
  let ledger = appendAll([...DECLS, 'fix_login := "로그인 오류 수정"', 'deploy := "배포"', '@1 user: want(use(serving, vllm))'])
  ledger = stepped(ledger, 'fix_login', ['tests_pass'])
  ledger = stepped(ledger, 'deploy', ['tests_pass', 'banner'])
  expect(renderInstructions(ledger, evaluate(ledger))).toBe([
    '## user instructions', '- 서빙에 vllm을(를) 쓴다. (@1)',
    '## steps', '- 로그인 오류 수정 (step fix_login): 1/2 통과\n- 배포 (step deploy): 2/2 통과, 마쳤다',
  ].join('\n\n'))
})

const LONG = '아주 긴 설명이 붙은 작업 단계 '.repeat(6)
const many = (prefix: string, count: number, passing: readonly string[], start: Ledger): Ledger => {
  let ledger = start
  for (let i = 0; i < count; i++) ledger = stepped(appendAll([prefix + i + ' := "' + LONG + i + '"'], ledger), prefix + i, passing)
  return ledger
}

// Regression caught: finished steps crowding the resident section that every prompt pays for.
test('more than three done steps collapse to one count line; three stay listed', () => {
  const three = many('fin_', 3, ['tests_pass', 'banner'], appendAll(DECLS))
  expect(renderInstructions(three, evaluate(three)).match(/마쳤다/g)).toHaveLength(3)
  const four = many('fin_', 4, ['tests_pass', 'banner'], appendAll(DECLS))
  const out = renderInstructions(four, evaluate(four))
  expect(out).toContain('- 마친 step 4개')
  expect(out).not.toContain('마쳤다')
})

// Regression caught: a long-running stepped session growing the section without bound, or the cap cutting user instructions.
test('a ledger whose steps exceed the cap renders within 3000 chars and keeps every instruction and unfinished step', () => {
  const wants = ['@1 user: want(use(serving, vllm))', '@2 user: want(use(training, deepspeed))', '@3 user: want(use(eval, lm_harness))']
  const base = many('fin_', 40, ['tests_pass', 'banner'], appendAll([...DECLS, 'training := "학습"', 'eval := "평가"', ...wants]))
  const ledger = many('open_', 4, ['tests_pass'], base)
  const out = renderInstructions(ledger, evaluate(ledger))
  expect(out.length).toBeLessThanOrEqual(3000)
  for (const line of ['- 서빙에 vllm을(를) 쓴다. (@1)', '- 학습에 deepspeed을(를) 쓴다. (@2)', '- 평가에 lm_harness을(를) 쓴다. (@3)']) expect(out).toContain(line)
  for (let i = 0; i < 4; i++) expect(out).toContain('(step open_' + i + '): 1/2 통과')

  // Unfinished steps alone past the cap: the block ends on a count of the rest, and the instructions stay.
  const crowded = many('open_', 40, ['tests_pass'], appendAll([...DECLS, ...wants.slice(0, 1)]))
  const cut = renderInstructions(crowded, evaluate(crowded))
  expect(cut.length).toBeLessThanOrEqual(3000)
  expect(cut).toContain('- 서빙에 vllm을(를) 쓴다. (@1)')
  expect(cut).toMatch(/- …외 \d+개$/)
})

// Regression caught: instructions alone past the cap growing an empty "## steps\n\n- …외 0개" block in a session with no step.
test('instructions over the cap with no step render no steps block', () => {
  const out = render(Array.from({ length: 90 }, (_, i) => '@' + (i + 1) + ' user: want(use(serving, tool_with_a_long_name_' + i + '))'))
  expect(out.length).toBeLessThanOrEqual(3000)
  expect(out).not.toContain('## steps')
  expect(out).toContain('(@90)')
  expect(out).toContain('- (older instructions omitted)')
  expect(out).not.toContain('(@1)')
})

// Regression caught: the section rebuilding the user's words from templates ("구현 언어에 Go을(를) 쓴다.") instead of quoting the prompt.
test('two wants from one prompt @3 render as one line carrying that prompt\'s exact text', () => {
  const ledger = appendAll([...DECLS, 'training := "학습"', '@3 user: want(use(serving, vllm))', '@3 user: want(use(training, deepspeed))', '@5 user: want(use(serving, sglang))'])
  const prompt = '서빙은 vllm, 학습은 deepspeed로 해줘.\n<system-reminder>harness</system-reminder>'
  const out = renderInstructions(ledger, evaluate(ledger), id => id === 3 ? prompt : undefined)
  expect(out).toBe('## user instructions\n\n- (@3) "서빙은 vllm, 학습은 deepspeed로 해줘."\n- 서빙에 sglang을(를) 쓴다. (@5)')
})

// Regression caught: an address whose prompt text is gone (midTurn prompt, lost store) vanishing from the section instead of keeping its rendered sentence.
test('an address with no prompt text falls back to the rendered sentence', () => {
  const ledger = appendAll([...DECLS, '@1 user: want(use(serving, vllm))'])
  expect(renderInstructions(ledger, evaluate(ledger), () => undefined)).toBe('## user instructions\n\n- 서빙에 vllm을(를) 쓴다. (@1)')
})

// Regression caught: one very long pasted prompt filling the section; a quote stops at 400 chars.
test('a quote is cut at 400 characters', () => {
  const ledger = appendAll([...DECLS, '@1 user: want(use(serving, vllm))'])
  const out = renderInstructions(ledger, evaluate(ledger), () => 'ㄱ'.repeat(900))
  expect(out).toBe('## user instructions\n\n- (@1) "' + 'ㄱ'.repeat(400) + '…"')
})

// Regression caught: instructions past the cap dropping the newest quotes instead of the oldest.
test('over the cap the oldest quotes go and the omitted line leads', () => {
  const ledger = appendAll([...DECLS, ...Array.from({ length: 10 }, (_, i) => '@' + (i + 1) + ' user: want(use(serving, tool_' + i + '))')])
  const out = renderInstructions(ledger, evaluate(ledger), id => 'x'.repeat(390) + id)
  expect(out.length).toBeLessThanOrEqual(3000)
  expect(out.split('\n')[2]).toBe('- (older instructions omitted)')
  expect(out).toContain('(@10)')
  expect(out).not.toContain('(@1)')
})

// Regression caught: the builtin done decl never rendering its gloss, so want(done(release)) read "done: 릴리스".
test('a want over the builtin done renders through its gloss', () => {
  expect(render(['release := "릴리스"', '@1 user: want(done(release))'])).toContain('- 릴리스를 마쳤다. (@1)')
})

// Regression caught: a rewound turn's extracted lines staying in the wayseeker ledger.
test('rewinding a prompt cuts the utterances it appended from the wayseeker ledger', () => {
  const ledger = appendAll([...DECLS, '@1 user: say(use(serving, sglang))', '@2 user: say(use(serving, vllm))'])
  const stored = { ...ledger, turns: [{ address: '@w1', firstId: 1 }, { address: '@w2', firstId: 2 }] }
  const prompts = [{ fp: promptFingerprint('sglang 써'), address: '@w1' }, { fp: promptFingerprint('vllm으로 바꿔'), address: '@w2' }]
  // The rewind took the transcript back to before "vllm으로 바꿔".
  const { rows, rewound } = reconcilePrompts(prompts, [promptFingerprint('sglang 써')])
  expect(rewound).toEqual(['@w2'])
  expect(rows).toEqual([prompts[0]])
  const trimmed = dropWayseekerTurns(stored, new Set(rewound))!
  expect(trimmed.utterances.map(u => u.id)).toEqual([1])
  expect(trimmed.turns).toEqual([{ address: '@w1', firstId: 1 }])
})

// Regression caught: a compaction or clm fold that dropped old prompts read as a rewind and wiped the ledger.
test('a compaction that rewrites the head cuts nothing and keeps the newest addresses', () => {
  const fp = promptFingerprint
  const prompts = [{ fp: fp('first'), address: '@w1' }, { fp: fp('middle'), address: '@w2' }, { fp: fp('newest'), address: '@w3' }]
  const { rows, rewound } = reconcilePrompts(prompts, [fp('summary'), fp('newest')])
  expect(rewound).toEqual([])
  expect(rows).toEqual([{ fp: fp('summary') }, { fp: fp('newest'), address: '@w3' }])
})

// Regression caught: a late extraction overwriting a rewind and resurrecting the rewound instruction.
test('a late extraction lands onto the rewound ledger and never brings the cut line back', async () => {
  const key = 's1:main'
  const before = appendAll([...DECLS, '@1 user: say(use(serving, sglang))'])
  // The rewind ran during the model call and cut @1; the extractor still answers from the ledger it read.
  const values = new Map<string, unknown>([[wayseekerKey(key), { ...before, utterances: [], turns: [] }]])
  const io = { get: async (k: string) => values.get(k), set: async (k: string, v: unknown) => { values.set(k, v) }, isLive: async () => true }
  await landWayseekerTurn(io, key, ['@2 user: say(use(serving, vllm))'], '@00000002')
  const stored = values.get(wayseekerKey(key)) as { utterances: { id: number }[]; turns: unknown[] }
  expect(stored.utterances.map(u => u.id)).toEqual([2])
  expect(stored.turns).toEqual([{ address: '@00000002', firstId: 1 }])

  const gone = { ...io, isLive: async () => false }
  const result = await landWayseekerTurn(gone, key, ['@3 user: say(use(serving, sglang))'], '@00000003')
  expect(result.rewound).toBe(true)
  expect((values.get(wayseekerKey(key)) as { utterances: unknown[] }).utterances).toHaveLength(1)
})

// Regression caught: an evaluation that ran out of fuel rendered like an empty session.
test('fuel exhaustion is raised while the settled facts still render', () => {
  const ledger = appendAll([...DECLS, '@1 user: want(use(serving, vllm))'])
  const out = renderInstructions(ledger, { ...evaluate(ledger), fuelExhausted: true })
  expect(out).toContain('- 서빙에 vllm을(를) 쓴다. (@1)')
  expect(out.split('## raises')[1] ?? '').toContain('평가 한도 초과')
})

// Regression caught: a rewound repeated prompt ("ok") counted as live because an earlier prompt had the same text.
test('of two equal-text prompts, the rewound later one is not live', () => {
  const before = [{ role: 'user', text: 'ok' }, { role: 'assistant', text: 'done' }, { role: 'user', text: '다음' }]
  const seen = countUserRows(before, 'ok') + 1 // the later "ok" at submit time
  expect(turnIsLive(before, 'ok', seen)).toBe(false) // rewound: only the earlier "ok" remains
  expect(turnIsLive([...before, { role: 'user', text: 'ok' }], 'ok', seen)).toBe(true)
})

// Regression caught: a resent prompt's extraction dropped as rewound because the address index kept the rewound row.
test('a prompt rewound and then resent is live', () => {
  // "ok" was sent and rewound; the transcript at the resend's submit no longer holds it.
  const atResend = [{ role: 'user', text: '시작' }, { role: 'assistant', text: 'done' }]
  const seen = countUserRows(atResend, 'ok') + 1
  expect(turnIsLive([...atResend, { role: 'user', text: 'ok' }], 'ok', seen)).toBe(true)
})
