import { test, expect } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { estTokens } from './fold'
import { M, bottoms, compactInput, compactedMessages, handled, TURN } from './clm-test-support'
import type { State } from './clm-test-support'

// Shape measured on 2026-11-12 from real session eb5734aa (its transcript, its clm
// state file and its clm log), as aggregates only; no text from it is copied here.
// - Host settings: window 200000, threshold 0.6, fixed prefix 60113 tokens, so
//   budget 61935, tailTarget 30967, ledgerTarget 7741, reserve 2048, queueTarget 8000.
// - Turns (1907): tokens p10 573, p50 2836, p90 15472, p99 134856; 109 turns (5.7%)
//   were larger than tailTarget alone. Rows per turn p50 7; about 3 tool calls per turn.
// - Rows by kind (count, mean chars, Hangul share of chars): prompt 2007/1213/0.053,
//   tool input 5895/645/0.050, tool result 5895/5048/0.018, assistant text
//   2080/647/0.417, queued message 297/944/0.027, ledger row 138/6358/0.314.
// - State file at the end: 4,194,028 UTF-8 bytes for 3,032,782 chars (1.383 B/char);
//   ledger-snapshots 3,557,582 B of which coveredRows 2,754,032 B over 31 snapshots
//   (coveredRows grew 89 -> 1549 fingerprints, about 50 per fold, mean 95.1 B each);
//   address-index 576,786 B. The log held 73 refused state writes, 10 background folds
//   dropped for a split overflowing tailTarget and 8 that gave up.
const OVERHEAD = 60113
const OPTIONS = { budget: 61935, tailTarget: 30967, ledgerTarget: 7741, reserve: 2048, queueTarget: 8000 }
const FOLD_AT = OPTIONS.budget - OPTIONS.reserve
const SCALE = { options: OPTIONS }
const STATE_FILE = (session: string) => `/home/t/.claude-work/plans/clm-${session}.state.json`
const MIB4 = 4 * 1024 * 1024
const utf8 = (text: string | undefined) => new TextEncoder().encode(text ?? '').length

// Deterministic synthetic text: random Hangul syllables and ASCII words mixed at a
// kind's measured Hangul share. Every row starts with a unique id so fingerprints differ.
let seed = 0x2545f491
const rand = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000 }
const pool = (hangul: number, length: number) => {
  const out: string[] = []
  let size = 0
  while (size < length) {
    const word = rand() < hangul / (hangul + (1 - hangul) / 5)
      ? Array.from({ length: 1 + Math.floor(rand() * 3) }, () => String.fromCharCode(0xac00 + Math.floor(rand() * 11172))).join('')
      : Array.from({ length: 3 + Math.floor(rand() * 6) }, () => String.fromCharCode(97 + Math.floor(rand() * 26))).join('')
    out.push(word)
    size += word.length + 1
  }
  return out.join(' ')
}
const POOLS = { prompt: pool(0.053, 1 << 17), input: pool(0.05, 1 << 16), result: pool(0.018, 1 << 18), reply: pool(0.417, 1 << 16), queued: pool(0.027, 1 << 13), summary: pool(0.314, 1 << 15) }
const RATE = Object.fromEntries(Object.entries(POOLS).map(([k, v]) => [k, estTokens(M('user', v)) / v.length])) as Record<keyof typeof POOLS, number>
let cursor = 0
const text = (kind: keyof typeof POOLS, id: string, tokens: number): string => {
  const source = POOLS[kind]
  const length = Math.min(source.length >> 1, Math.ceil(tokens / RATE[kind]))
  cursor = (cursor * 31 + 977) % (source.length - length)
  return `${id} ${source.slice(cursor, cursor + length)}`
}

// Turn sizes cycle through the measured percentiles; ids are ASCII so refs stay valid.
const SIZES = [573, 2836, 15472, 2836, 573, 2836, 6000, 2836]
let turnNo = 0
const turn = (tokens: number): SessionMessage[] => {
  const n = ++turnNo
  const share = (f: number) => Math.max(8, Math.round(tokens * f))
  const rows: SessionMessage[] = [M('user', text('prompt', `p${n}`, 25))]
  for (let k = 0; k < 3; k++) {
    const id = `toolu_${n}_${k}`
    rows.push(M('assistant', '', { toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: text('input', id, share(0.04)) }, text: '' }] }))
    rows.push(M('user', '', { toolResults: [{ tool_use_id: id, text: text('result', `r${id}`, share(0.25)), isError: false }] }))
  }
  rows.push(M('assistant', text('reply', `a${n}`, share(0.13))))
  return rows
}
const total = (rows: readonly SessionMessage[]) => rows.reduce((n, m) => n + estTokens(m), 0)

// Regressions caught, each seen red with its fix reverted (2026-11-12):
// - snapshots copying coveredRows: state passes the linear byte bound at fold 24;
// - the size guard counting chars: the eb5734aa-sized test sees the host refuse 4 writes.
// The split overflow and queued-message regressions found with this chain are ordering, which
// spec/fold-job.qnt owns and fold-conformance.test.ts replays.
type Fold = { n: number; bad: boolean; oversized: boolean }

// The kit stops a test after 5 s, so the folds run as a chain of tests that hand the
// session (rows, state files, store, queue, clock) from one to the next.
const FOLDS = 42
const PER_TEST = 6
const carry = {
  rows: [M('user', text('prompt', 'p0', 400)), M('assistant', text('reply', 'a0', 200))] as SessionMessage[],
  files: {} as Record<string, string>, engineStore: {} as Record<string, unknown>, now: 0, consumed: '', refusals: 0,
}
// One goal per fold, as eb5734aa's store held 45 clauses after 32 folds (36,838 B).
const ops = (n: number) => [{ clause: `goal('I-focus', 'topic${n}').`, kind: 'goal', text: `topic${n}: ${text('summary', `s${n}`, 200)}`, evidence: [] }]

for (let first = 1; first <= FOLDS; first += PER_TEST) {
  const last = Math.min(FOLDS, first + PER_TEST - 1)
  test(`fold scale ${first}-${last}: state stays linear in UTF-8 bytes`, SCALE, async ($, on) => {
    const s: State = { rows: carry.rows, replies: [] }
    const seen = bottoms(on, s)
    Object.assign(seen.files, carry.files)
    Object.assign(seen.engineStore, carry.engineStore)
    if (carry.now) seen.clock.advance(carry.now - seen.clock.now())
    const setUsage = () => { s.usage = { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: OVERHEAD + total(s.rows) } } }
    // The summarizer: a split whose kept turns fit well under tailTarget, except on bad folds
    // where it keeps everything after turn 1 on both attempts, so the split overflows.
    let current: Fold = { n: 0, bad: false, oversized: false }
    s.splitReplies = []
    s.splitBlock = async () => {
      const prompt = seen.splitPrompts.at(-1)!
      const turns = [...prompt.matchAll(/<turn number="(\d+)" tokens="(\d+)">/g)].map(m => Number(m[2]))
      let split = turns.length
      for (let k = 2; k <= turns.length; k++) if (turns.slice(k - 1).reduce((t, x) => t + x, 0) <= OPTIONS.tailTarget * 0.6) { split = k; break }
      s.splitReplies!.push(JSON.stringify({ split: current.bad ? 2 : split, ops: ops(current.n) }))
    }
    s.mergeBlock = async () => {
      s.replies.push(JSON.stringify({ ops: ops(current.n) }))
    }

    // The host refuses a state write above 4 MiB in UTF-8 bytes.
    s.fsWriteBlock = async (path, body) => {
      if (!path.endsWith('.state.json')) return
      if (utf8(body) > MIB4) { carry.refusals++; throw new Error(`$.fs.write ${path} refused (${utf8(body)} bytes)`) }
    }

    for (let n = first; n <= last; n++) {
      current = { n, bad: n % 7 === 3, oversized: n % 6 === 0 }
      // An oversized fold stops short by less than its 40k turn, so that turn takes the rows past FOLD_AT.
      const fill = current.oversized ? FOLD_AT - 38_000 : FOLD_AT
      for (let i = 0; total(s.rows) < fill; i++) s.rows.push(...turn(SIZES[(turnNo + i) % SIZES.length]!))
      if (current.oversized) s.rows.push(...turn(40_000))
      setUsage()
      await $.turn.complete(TURN)
      // Wait for the turn end's plan, so the compact swaps it instead of folding at the deadline.
      let pending = ''
      for (const deadline = performance.now() + 1500; performance.now() < deadline;) {
        pending = JSON.stringify(seen.store['pending:s1'] ?? '')
        if (pending !== '""' && pending !== carry.consumed) break
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      carry.consumed = pending
      const out = compactedMessages(await $.session.compact(compactInput('plugin', handled(s.rows))))
      s.rows = [...out]
      setUsage()

      // The state below is only the ledger's growth when the compact folded with a ledger row.
      expect({ fold: n, ledger: out.some(m => /^\[clm ledger #/.test(m.text)) }).toEqual({ fold: n, ledger: true })

      // Bound: 64 KiB + 80 KiB per fold, and 3 MiB overall. With this generator the fixed code
      // grew 75.4 KB per fold once the 32-snapshot cap held (folds 32-42; 1.46 MB at fold 32,
      // against 1.44 MB for eb5734aa's state less its coveredRows), because every kept snapshot
      // copies the ledger, clause store and address index, which grow a little each fold. The
      // copied coveredRows made it 2.3 MB by fold 25 and 4 MB by fold 34.
      const size = utf8(seen.files[STATE_FILE('s1')])
      expect({ fold: n, bounded: size <= 64 * 1024 + 80 * 1024 * n && size < 3 * 1024 * 1024, size }).toEqual({ fold: n, bounded: true, size })
    }
    carry.rows = s.rows
    carry.files = { ...seen.files }
    carry.engineStore = { ...seen.engineStore }
    carry.now = seen.clock.now()
    if (last === FOLDS) expect({ refusals: carry.refusals }).toEqual({ refusals: 0 })
  })
}

// Regression caught: the size guard counted UTF-16 chars while the host refuses state files over 4 MiB of UTF-8, so a
// Korean-heavy state (eb5734aa: 4,194,028 B in 3,032,782 chars) passed the guard and every later fold write was refused.
test('a fold on a state at the measured eb5734aa size never sends the host a write over 4 MiB of UTF-8', { options: OPTIONS }, async ($, on) => {
  const s: State = { rows: [], replies: [], sessionId: 's2' }
  const seen = bottoms(on, s)
  let refusals = 0
  s.fsWriteBlock = async (path, body) => {
    if (path.endsWith('.state.json') && utf8(body) > MIB4) { refusals++; throw new Error(`$.fs.write ${path} refused (${utf8(body)} bytes)`) }
  }
  // Ballast in a field snapshots carry opaquely, so no code path strips it; the ASCII
  // padding brings the file to the measured byte and char counts.
  const BYTES = 4_194_028, CHARS = 3_032_782
  const hangul = (BYTES - CHARS) / 2
  const snapshot = (ballast: string) => JSON.stringify({ 'ledger-snapshots:s2:main': [{ seq: 0, ledgerFp: 'f0', ledger: '', coveredRows: [], instructions: ballast }] })
  let ballast = ''
  while (ballast.length < hangul) ballast += POOLS.reply.replace(/[a-z ]/g, '').slice(0, hangul - ballast.length)
  ballast += 'x'.repeat(CHARS - snapshot(ballast).length)
  seen.files[STATE_FILE('s2')] = snapshot(ballast)
  expect({ bytes: utf8(seen.files[STATE_FILE('s2')]), chars: seen.files[STATE_FILE('s2')]!.length }).toEqual({ bytes: BYTES, chars: CHARS })

  for (let i = 0; total(s.rows) < FOLD_AT; i++) s.rows.push(...turn(SIZES[i % SIZES.length]!))
  s.usage = { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: OVERHEAD + total(s.rows) } }
  s.splitReplies = [JSON.stringify({ split: 2, ops: [] })]
  s.replies.push(JSON.stringify({ ops: [] }))
  await $.turn.complete(TURN)
  await $.session.compact(compactInput('plugin', handled(s.rows)))
  await new Promise(resolve => setTimeout(resolve, 50))
  expect({ refusals }).toEqual({ refusals: 0 })
})
