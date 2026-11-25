import { test, expect } from 'claude-code/testing'

import { appendAll } from './store'
import { evaluate } from './eval'
import { countUserRows, dropWayseekerTurns, landWayseekerTurn, renderInstructions, turnIsLive, wayseekerKey } from './render'
import { promptFingerprint, reconcilePrompts } from './rewind'

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
// instructions, and a want the agent already did (say(done(p))) staying there.
test('only open user wants render as instructions', () => {
  const OBSERVED = ['decl exist(thing) key(thing) "{thing}이 존재한다"', 'decl done(task) key(task) "{task}이 완료되었다"', 'panel := "패널"']
  const said = ['@1 user: say(not(exist(panel)))', '@1 user: say(done(rebuild))', '@2 user: want(use(serving, vllm))']
  expect(render([...OBSERVED, ...said])).toBe('## user instructions\n\n- 서빙에 vllm을(를) 쓴다. (@2)')
  expect(render([...OBSERVED, ...said, '@3 agent: say(done(use(serving, vllm)))'])).toBe('## user instructions\n\n- (none yet)')
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
