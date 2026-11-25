import { test, expect } from 'claude-code/testing'

import { appendAll } from './store'
import { evaluate } from './eval'
import { renderInstructions, wayseekerKey } from './render'
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
