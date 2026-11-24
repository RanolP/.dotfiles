import { test, expect } from 'claude-code/testing'

import { ledgerRowText } from './fold'
import { addNote, appendArchive, archiveBlocks, NOTE_CHARS, NOTE_KEEP, noteStoreKey, parseArchive } from './memory'
import { M } from './clm-test-support'
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

// Regression caught: the archive copied a credential from a tool result into a second, searchable file.
test('the archive redacts credential shapes and keeps the rest', () => {
  // Built at runtime so the fixture itself carries no key-shaped literal.
  const fakeKey = 'sk' + '-' + 'q'.repeat(22)
  const row = M('user', '', { toolResults: [{ tool_use_id: 't1', text: `Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 and ${fakeKey} ok`, isError: false }] })
  const text = archiveBlocks(3, [row])
  expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz0123')
  expect(text).not.toContain(fakeKey)
  expect(text).toContain('Bearer [redacted]')
  expect(text).toContain(' ok')
})

// Regression caught: the archive grew without bound, or cutting it split a block so its address no longer parsed.
test('the archive stays within its cap and drops whole blocks oldest first', () => {
  let archive = ''
  for (let seq = 1; seq <= 50; seq++) archive = appendArchive(archive, archiveBlocks(seq, [M('assistant', 'answer ' + seq + ' ' + 'z'.repeat(900))]), 10_000)
  expect(archive.length).toBeLessThanOrEqual(10_000)
  const blocks = parseArchive(archive)
  expect(blocks.at(-1)?.address).toBe('@fold:50.0')
  expect(blocks[0]?.body.startsWith('answer ')).toBe(true)
})
