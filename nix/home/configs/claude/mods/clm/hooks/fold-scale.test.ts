import { test, expect } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import { estTokens, fingerprint, type QueuedMessage } from './fold'
import { M, bottoms, compactInput, compactedMessages, handled, logEvents, TURN } from './clm-test-support'
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
// - snapshots copying coveredRows: state passes the linear byte bound at fold 32;
// - the size guard counting chars: the eb5734aa-sized test sees the host refuse 4 writes;
// - a split that overflows tailTarget being dropped: no fold plan is written on fold 3,
//   whose summarizer keeps every turn after the first;
// - queued messages retired after the state writes: A is still queued after fold 5,
//   whose compact has every state write fail.
type Fold = { n: number; bad: boolean; oversized: boolean }

// The kit stops a test after 5 s, so the folds run as a chain of tests that hand the
// session (rows, state files, store, queue, clock) from one to the next.
const FOLDS = 42
const PER_TEST = 6
const FAIL_AT = 5
const MID_FOLD_AT = 9
const A: QueuedMessage = { uuid: 'qa', text: `queued-A ${text('queued', 'qa', 600)}`, at: 0 }
const B: QueuedMessage = { uuid: 'qb', text: `queued-B ${text('queued', 'qb', 600)}`, at: 0 }
const carry = {
  rows: [M('user', text('prompt', 'p0', 400)), M('assistant', text('reply', 'a0', 200))] as SessionMessage[],
  files: {} as Record<string, string>, engineStore: {} as Record<string, unknown>, now: 0,
  queue: {} as Record<string, QueuedMessage[]>, queueVersion: 0, consumed: '',
  retiredAt: {} as Record<string, number>, summarized: [] as string[], refusals: 0,
}
// One goal per fold, as eb5734aa's store held 45 clauses after 32 folds (36,838 B).
const ops = (n: number) => [{ clause: `goal('I-focus', 'topic${n}').`, kind: 'goal', text: `topic${n}: ${text('summary', `s${n}`, 200)}`, evidence: [] }]
const hits = (rows: readonly SessionMessage[], marker: string) => rows.filter(m => m.text.includes(marker)).length

for (let first = 1; first <= FOLDS; first += PER_TEST) {
  const last = Math.min(FOLDS, first + PER_TEST - 1)
  test(`fold scale ${first}-${last}: state stays linear in UTF-8 bytes, no summary dropped, queued messages carried once`, SCALE, async ($, on) => {
    const s: State = { rows: carry.rows, replies: [] }
    const seen = bottoms(on, s)
    Object.assign(seen.files, carry.files)
    Object.assign(seen.engineStore, carry.engineStore)
    if (carry.now) seen.clock.advance(carry.now - seen.clock.now())
    const setUsage = () => { s.usage = { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: OVERHEAD + total(s.rows) } } }
    // Queued messages live in plugin state; this store stands in for the host's.
    on('state.get', async (_$: any, e: any, next: any) => e.plugin === 'clm' && e.key === 'queuedMessages'
      ? { value: carry.queueVersion ? { value: structuredClone(carry.queue), version: carry.queueVersion } : { version: 0 } }
      : next(e))
    on('state.set', async (_$: any, e: any, next: any) => {
      if (e.plugin !== 'clm' || e.key !== 'queuedMessages') return next(e)
      carry.queue = structuredClone(e.value)
      return { value: { isSet: true, version: ++carry.queueVersion } }
    })
    const queued = () => carry.queue['s1'] ?? []
    const enqueue = (message: QueuedMessage) => { carry.queue = { ...carry.queue, s1: [...queued(), message] }; carry.queueVersion++ }

    // The summarizer: a split whose kept turns fit well under tailTarget, except on bad folds
    // where it keeps everything after turn 1 on both attempts, so the split overflows.
    let current: Fold = { n: 0, bad: false, oversized: false }
    s.splitReplies = []
    s.splitBlock = async () => {
      const prompt = seen.splitPrompts.at(-1)!
      carry.summarized.push(prompt)
      const turns = [...prompt.matchAll(/<turn number="(\d+)" tokens="(\d+)">/g)].map(m => Number(m[2]))
      let split = turns.length
      for (let k = 2; k <= turns.length; k++) if (turns.slice(k - 1).reduce((t, x) => t + x, 0) <= OPTIONS.tailTarget * 0.6) { split = k; break }
      s.splitReplies!.push(JSON.stringify({ split: current.bad ? 2 : split, ops: ops(current.n) }))
    }
    s.mergeBlock = async () => {
      carry.summarized.push(seen.prompts.at(-1)!)
      s.replies.push(JSON.stringify({ ops: ops(current.n) }))
    }

    // The host refuses a state write above 4 MiB in UTF-8 bytes; during FAIL_AT's compact
    // every state write fails, as it did once eb5734aa's state passed that limit.
    let failing = false
    s.fsWriteBlock = async (path, body) => {
      if (!path.endsWith('.state.json')) return
      if (failing) throw new Error(`$.fs.write ${path} refused (injected)`)
      if (utf8(body) > MIB4) { carry.refusals++; throw new Error(`$.fs.write ${path} refused (${utf8(body)} bytes)`) }
    }

    for (let n = first; n <= last; n++) {
      current = { n, bad: n % 7 === 3, oversized: n % 6 === 0 }
      const fill = current.oversized ? FOLD_AT - 40_000 : FOLD_AT
      for (let i = 0; total(s.rows) < fill; i++) s.rows.push(...turn(SIZES[(turnNo + i) % SIZES.length]!))
      if (current.oversized) s.rows.push(...turn(40_000))
      if (n === FAIL_AT) {
        const anchor = s.rows.findIndex((m, i) => i > 2 && m.role === 'assistant' && m.text !== '')
        enqueue({ ...A, at: seen.clock.now(), after: fingerprint(s.rows[anchor]!) })
      }
      setUsage()
      await $.turn.complete(TURN)
      // A fold that leaves no plan shows up here; the fixed code writes one within about 100 ms.
      let pending = ''
      for (const deadline = performance.now() + 1500; performance.now() < deadline;) {
        pending = JSON.stringify(seen.store['pending:s1'] ?? '')
        if (pending !== '""' && pending !== carry.consumed) break
        await new Promise(resolve => setTimeout(resolve, 1))
      }
      const plan: any = seen.store['pending:s1']
      const written = pending !== carry.consumed && plan !== undefined
      expect({ fold: n, pendingWritten: written, recent: written ? '' : String(JSON.stringify(logEvents(seen).at(-1))).slice(0, 300) }).toEqual({ fold: n, pendingWritten: true, recent: '' })
      carry.consumed = pending
      expect({ fold: n, fallback: plan.fallback }).toEqual({ fold: n, fallback: false })
      if (n === MID_FOLD_AT) enqueue({ ...B, at: seen.clock.now(), after: fingerprint(s.rows.at(-1)!) })
      failing = n === FAIL_AT
      const out = compactedMessages(await $.session.compact(compactInput('plugin', handled(s.rows))))
      failing = false
      s.rows = [...out]
      setUsage()

      // The session-compact event is written after the result settles.
      for (let i = 0; i < 200 && logEvents(seen).filter((x: any) => x.event === 'session-compact').length < n; i++) await new Promise(resolve => setTimeout(resolve, 1))
      const events = logEvents(seen)
      const compacts = events.filter((x: any) => x.event === 'session-compact')
      const clears = events.filter((x: any) => x.event === 'clear')
      expect({ fold: n, outcome: compacts.at(-1)?.outcome, ledger: out.some(m => /^\[clm ledger #/.test(m.text)), engine: seen.engineCompactions })
        .toEqual({ fold: n, outcome: 'swap', ledger: true, engine: 0 })
      if (n !== FAIL_AT) expect({ fold: n, reason: clears.at(-1)?.reason }).toEqual({ fold: n, reason: 'clm' })
      expect({ fold: n, gaveUp: seen.logs.filter(l => /split summary dropped|gave up|summary failed/.test(l)) }).toEqual({ fold: n, gaveUp: [] })

      for (const message of [A, B]) {
        const count = hits(out, message.text.slice(0, 12))
        if (carry.retiredAt[message.uuid] !== undefined) expect({ fold: n, message: message.uuid, count }).toEqual({ fold: n, message: message.uuid, count: 0 })
        expect({ fold: n, message: message.uuid, atMostOnce: count <= 1 }).toEqual({ fold: n, message: message.uuid, atMostOnce: true })
        if (carry.retiredAt[message.uuid] === undefined && !queued().some(q => q.uuid === message.uuid) && n >= (message === A ? FAIL_AT : MID_FOLD_AT)) carry.retiredAt[message.uuid] = n
      }
      if (n === FAIL_AT) expect({ fold: n, queuedA: queued().some(q => q.uuid === 'qa') }).toEqual({ fold: n, queuedA: false })
      if (n === MID_FOLD_AT) expect({ fold: n, carriedB: hits(out, 'queued-B') }).toEqual({ fold: n, carriedB: 1 })

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
    if (last === FOLDS) {
      expect({ refusals: carry.refusals }).toEqual({ refusals: 0 })
      expect({ B: carry.summarized.some(p => p.includes('queued-B')), retired: carry.retiredAt['qb'] !== undefined }).toEqual({ B: true, retired: true })
    }
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
