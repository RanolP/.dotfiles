import { test, expect } from 'claude-code/testing'

import { residentLedger, type ResidentIo } from './resident'

const CLAUSES = {
  version: 1, nextId: 2, predicates: { forbid: { key: 1, example: 'forbid(push).' } }, clauses: [
    { id: 'C1', head: { name: 'forbid', args: [{ atom: 'push' }] }, neg: false, body: [], source: 'forbid(push).', text: 'origin에 push하지 않는다.', quote: 'push 하지 마', address: '@00000001', promptSeq: 1, issue: null, at: '2026-10-27T00:00:00Z', status: 'live' },
  ],
}
const io = (store: Record<string, unknown>, extra: Partial<ResidentIo> = {}): ResidentIo => ({
  get: async key => store[key], readLedger: async () => undefined, readMeta: async () => ({ seq: 0 }), readLegacyTopics: async () => [], readRequests: async () => [], ...extra,
})
// What the wayseeker mod's $.wayseeker.instructions answers for a ledger holding one instruction.
const WAYSEEKER_SECTION = '## user instructions\n\n- 서빙에 vllm을 쓴다. (@1)'

// Regression caught: the wayseeker path leaking into sessions that never turned the flag on, or with the mod absent.
test('flag off or wayseeker absent leaves the ledger render identical to the clauses path', async () => {
  const key = 's1:main'
  const store = { [`clauses:${key}`]: CLAUSES }
  const render = (extra?: Partial<ResidentIo>) => residentLedger(io(store, extra), key, [], { stack: [], pending: [] }, [])
  const clausesOnly = await render()
  expect(clausesOnly).toContain('- origin에 push하지 않는다. (C1 @00000001)')
  expect(await render({ wayseekerInstructions: async () => undefined })).toBe(clausesOnly)
  const asked: string[] = []
  const on = await render({ wayseekerInstructions: async k => { asked.push(k); return WAYSEEKER_SECTION } })
  expect(asked).toEqual([key])
  expect(on).toContain('- 서빙에 vllm을 쓴다. (@1)')
  expect(on).not.toContain('origin에 push하지 않는다.')
})
