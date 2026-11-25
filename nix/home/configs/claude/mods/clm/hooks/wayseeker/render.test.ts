import { test, expect } from 'claude-code/testing'

import { appendAll } from './store'
import { evaluate } from './eval'
import { countUserRows, landWayseekerTurn, renderInstructions, turnIsLive, wayseekerKey } from './render'
import { residentLedger, type ResidentIo } from '../resident'
import { observeTranscript, transcriptRowsKey, type RewindIo } from '../rewind'
import { fingerprint } from '../fold'

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
  const out = render(['@1 user: say(use(serving, sglang))', '@2 user: say(use(serving, vllm))'])
  expect(out).toContain('- 서빙에 vllm을 쓴다. (@2)')
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

const CLAUSES = {
  version: 1, nextId: 2, predicates: { forbid: { key: 1, example: 'forbid(push).' } }, clauses: [
    { id: 'C1', head: { name: 'forbid', args: [{ atom: 'push' }] }, neg: false, body: [], source: 'forbid(push).', text: 'origin에 push하지 않는다.', quote: 'push 하지 마', address: '@00000001', promptSeq: 1, issue: null, at: '2026-10-27T00:00:00Z', status: 'live' },
  ],
}
const io = (store: Record<string, unknown>, extra: Partial<ResidentIo> = {}): ResidentIo => ({
  get: async key => store[key], readLedger: async () => undefined, readMeta: async () => ({ seq: 0 }), readLegacyTopics: async () => [], readRequests: async () => [], ...extra,
})

// Regression caught: the wayseeker path leaking into sessions that never turned the flag on.
test('flag off leaves the ledger render identical to the clauses path', async () => {
  const key = 's1:main'
  const wayseeker = appendAll([...DECLS, '@1 user: say(use(serving, vllm))'])
  const render = (store: Record<string, unknown>, extra?: Partial<ResidentIo>) => residentLedger(io(store, extra), key, [], { stack: [], pending: [] }, [])
  const clausesOnly = await render({ [`clauses:${key}`]: CLAUSES })
  const off = await render({ [`clauses:${key}`]: CLAUSES, [wayseekerKey(key)]: wayseeker }, { wayseeker: false })
  expect(off).toBe(clausesOnly)
  expect(off).toContain('- origin에 push하지 않는다. (C1 @00000001)')
  const on = await render({ [`clauses:${key}`]: CLAUSES, [wayseekerKey(key)]: wayseeker }, { wayseeker: true })
  expect(on).toContain('- 서빙에 vllm을 쓴다. (@1)')
  expect(on).not.toContain('origin에 push하지 않는다.')
})

// Regression caught: a rewound turn's extracted lines staying in the wayseeker ledger.
test('rewinding a prompt cuts the utterances it appended from the wayseeker ledger', async () => {
  const key = 's1:main'
  const at = '2026-11-25T00:00:00.000Z'
  const ledger = appendAll([...DECLS, '@1 user: say(use(serving, sglang))', '@2 user: say(use(serving, vllm))'])
  const values = new Map<string, unknown>([
    [wayseekerKey(key), { ...ledger, turns: [{ address: '@00000001', firstId: 1 }, { address: '@00000002', firstId: 2 }] }],
    [`address-index:${key}`, { rows: [{ address: '@00000001', text: 'sglang 써', at }, { address: '@00000002', text: 'vllm으로 바꿔', at }], stamps: {} }],
  ])
  const M = (role: 'user' | 'assistant', text: string) => ({ role, text, toolUses: [] }) as never
  const kept = [M('user', 'sglang 써'), M('assistant', 'ok')]
  values.set(transcriptRowsKey(key), [...kept, M('user', 'vllm으로 바꿔'), M('assistant', 'ok')].map(fingerprint))
  const rewindIo = {
    storeGet: async (k: string) => values.get(k), storeSet: async (k: string, v: unknown) => { values.set(k, v) },
    storeDelete: async (k: string) => { values.delete(k) }, readMeta: async () => ({ seq: 0, fails: 0 }),
    readyFoldDropFps: () => undefined, log: () => undefined,
  } as unknown as RewindIo
  await observeTranscript(rewindIo, key, kept)
  const stored = values.get(wayseekerKey(key)) as { utterances: { id: number }[]; turns: unknown[] }
  expect(stored.utterances.map(u => u.id)).toEqual([1])
  expect(stored.turns).toEqual([{ address: '@00000001', firstId: 1 }])
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
  const ledger = appendAll([...DECLS, '@1 user: say(use(serving, vllm))'])
  const out = renderInstructions(ledger, { ...evaluate(ledger), fuelExhausted: true })
  expect(out).toContain('- 서빙에 vllm을 쓴다. (@1)')
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
