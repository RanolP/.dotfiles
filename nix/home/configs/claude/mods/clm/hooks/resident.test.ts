import { test, expect } from 'claude-code/testing'

import { residentLedger, type ResidentIo } from './resident'

const io = (store: Record<string, unknown>): ResidentIo => ({
  get: async key => store[key], readLedger: async () => undefined, readMeta: async () => ({ seq: 0 }), readLegacyTopics: async () => [],
})

// Regression caught: a clause store left in session storage by an older clm reappearing as user instructions beside the wayseeker mod's own.
test('the ledger render ignores a stored clause store and carries no instruction section', async () => {
  const key = 's1:main'
  const store = { [`clauses:${key}`]: { version: 1, nextId: 2, clauses: [{ id: 'C1', text: 'origin에 push하지 않는다.', status: 'live' }] } }
  const row = await residentLedger(io(store), key, [], { stack: [], pending: [] }, [])
  expect(row).not.toContain('push하지 않는다')
  expect([...row.matchAll(/^## (.+)$/gm)].map(match => match[1])).not.toContain('user instructions')
})
