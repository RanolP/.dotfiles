import { test, expect } from 'claude-code/testing'

import { ledgerRowText } from './fold'
import { addNote, NOTE_CHARS, NOTE_KEEP, noteStoreKey } from './memory'
import { residentLedger, type ResidentIo } from './resident'

const residentIoWith = (store: Record<string, unknown>): ResidentIo => ({
  get: async key => store[key],
  readLedger: async () => undefined,
  readMeta: async () => ({ seq: 1 }),
  readLegacyTopics: async () => [],
  readRequests: async () => [],
})

// Regression caught: a clm_note line is missing from the ledger row a fold writes, so the fact the model saved is lost with the folded turns.
test('a recorded note reaches the folded ledger row verbatim', async () => {
  const key = 's1:main'
  const store = { [noteStoreKey(key)]: ['deploy target is /srv/app-v2 (not /srv/app)'] }
  const ledger = await residentLedger(residentIoWith(store), key, [], { stack: [], pending: [] }, [])
  const row = ledgerRowText(2, 'now', '', ledger, 4000)
  expect(row).toContain('## facts\n- [note] deploy target is /srv/app-v2 (not /srv/app)')
})

// Regression caught: note storage grows without bound or evicts the newest note instead of the oldest.
test('notes keep the newest NOTE_KEEP and evict oldest first', () => {
  let notes: string[] = []
  for (let i = 0; i < NOTE_KEEP + 2; i++) {
    const added = addNote(notes, `fact ${i}`)
    if ('error' in added) throw new Error(added.error)
    notes = added.notes
    if (i === NOTE_KEEP) expect(added.evicted).toEqual(['fact 0'])
  }
  expect(notes.length).toBe(NOTE_KEEP)
  expect(notes[0]).toBe('fact 2')
  expect(notes.at(-1)).toBe(`fact ${NOTE_KEEP + 1}`)
  expect('error' in addNote(notes, 'x'.repeat(NOTE_CHARS + 1))).toBe(true)
})
