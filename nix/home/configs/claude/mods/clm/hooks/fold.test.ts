import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, RenderPropsOf, SessionCompactInput, SessionCompactResult, SessionMessage, SessionStartInput, ToolCallInput, TurnCompleteInput } from 'claude-code'

import { boardHtml } from './board'
import { chooseContinuation, clmStatus, isHeld, resetUserWorkflow, removeQueueSnapshotTargets, restoreFailedContinuation, sessionIssues, submitWithRecovery, trackIssue, recallTranscriptAddress, residentLedgerText, TASK_TOOL } from './register'
import type { Held, Meta } from './register'
import { INTENT_SYSTEM } from './intent'
import type { ClmWorkflow } from '../types'

import { ageDecayPlan, fallbackLedger, instructionValues, LEDGER_COMPACT_SYSTEM, MERGE_SYSTEM, parseMerge, preserveInstructions, REVIEW_SYSTEM, SPLIT_MERGE_SYSTEM } from './ledger'
import { focusOf, parseLog, snapshot, toEvents, type Issue, type Payload } from './tracker'
import { fingerprint } from './fold'
import { M, intentReply, use, res, BIG, MID, ROWS, CITE, ledger, splitAnswer, compressedTopics, TURN, OPTS, LEDGER_FILE, LOG_FILE, storedLedger, ids, est, shape, handled, compactInput, promptInput, turnInput, commandInput, compactedMessages, workflow, heldIn, isMetaValue, metaIn, bottoms, turnEnds, waitForPending, BG_OPTS, logEvents, panelHandlers, sixDone, storedOverhead, NOTE_REPLY, ESCAPE_ROWS, WITHHELD_FILE, section, PR_ROWS, TRACKER, seedTracker, issueAt, runClm, LATER_BAND_PROPS, waitForLog } from './clm-test-support'
import type { State, On, Seen, PanelReply } from './clm-test-support'
// Regression caught: the automatic fold keeps the wrong rows (drops the request, keeps folded turns, or cuts between a tool_use and its tool_result).
test('over budget, a fold keeps [first request, ledger, newest turns] with tool pairs intact', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('a.ts:12 is the bad import')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out[0].text).toBe('please investigate the build')
  expect(out[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(section(out[1].text, 'learned')).toContain('a.ts:12 is the bad import')
  expect(storedLedger(seen)).toContain('a.ts:12 is the bad import')
  expect(shape(out.slice(2))).toEqual(['run tests', 'tu_c', 'tu_c', 'tests pass', 'commit it', 'done'])
  expect(out.some((m: any) => m.handle !== undefined)).toBe(false)
  expect(seen.prompts[0]).toContain('fixed a.ts:12')
  expect(seen.prompts[0]).not.toContain('tests pass')
  expect(seen.files[LEDGER_FILE]).toContain('## 핵심 사실·경로')
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: a second fold loses the first ledger (not fed back from the file) or stacks a second ledger row beside the first.
test('the ledger round-trips through its file and survives a second fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('FIRST-FACT'), ledger('SECOND-FACT', '[]', [{ ref: 'tu_c', quote: 'all 12 tests passed' }])] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const after1 = seen.results[0].messages
  // The stored transcript keeps the pre-fold chain in front of the live one.
  s.rows = [...ROWS, ...after1, M('user', 'add docs'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'docs added'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)
  expect(seen.prompts[1]).toContain('FIRST-FACT')
  const out = seen.results[1].messages
  expect(out.filter((m: any) => m.text.startsWith('[clm ledger')).length).toBe(1)
  expect(out[1].text).toMatch(/^\[clm ledger #2 · /)
  expect(section(out[1].text, 'learned')).toContain('SECOND-FACT')
  expect(storedLedger(seen)).toContain('SECOND-FACT')
  expect(out.map((m: any) => m.text).filter(Boolean)).toEqual(['please investigate the build', out[1].text, 'commit it', 'done', 'add docs', 'docs added', 'push', 'pushed'])
})

// Regression caught: a merged ledger missing a section replaces the memory anyway and silently drops that section.
test('a merged ledger without its 목표 header skips the fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['## 핵심 사실·경로\n- a heading the merge no longer writes\n\n<ops>[]</ops>'] }
  const seen = bottoms(on, s)
  const result = compactedMessages(await $.session.compact(compactInput('manual', handled(ROWS))))
  expect(result[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('요약 없이 접힘:')
  expect(logEvents(seen).map(e => e.event)).toEqual(['merge-invalid', 'merge-invalid', 'fallback', 'clear'])
})

// Regression caught: after a fold, reads include the pre-boundary transcript so totals double-count rows the model no longer sees; and /clm output lands in the model's transcript.
test('/clm prints the ledger, a budget line counting only post-boundary rows, and the last decisions', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('LEDGER-ONLY-FACT')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const after = seen.results[0].messages
  s.rows = [...ROWS, ...after]
  const r: any = await $.command.run(commandInput('clm'))
  expect(r.text).toBeUndefined()
  const text = seen.logs.at(-1)!
  const expected = after.reduce((n: number, m: any) => n + est(m), 0)
  expect(text.split('\n')[0]).toBe(`clm budget: ${expected}/2000 tokens (${Math.round(expected / 20)}%); escape at 1900, queue target 100000, tail target 1200, ledger target 300, ratio 1`)
  expect(text).toContain('LEDGER-ONLY-FACT')
  expect(text).toContain('"event":"clear"')
})

// Regression caught (guard 1): when the newest turn alone exceeds the tail target, the fold drops it too and the model loses the turn it is working on.
test('the tail keeps the newest turn even when that turn alone exceeds the tail target', OPTS, async ($, on) => {
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', 'HEAD' + 'z'.repeat(8000) + 'TAIL'), M('assistant', 'dumped')]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(shape(out.slice(2))).toEqual(['dump logs', 'tu_e', 'tu_e', 'dumped'])
})

// Regression caught: a pending plan found the newer of two identical prompts and deleted the rows between it and the planned boundary.
test('a pending fold keeps both identical tail prompts and the turn between them', OPTS, async ($, on) => {
  const rows = [
    M('user', 'start'), M('assistant', 'x'.repeat(9000)),
    M('user', 'old work'), M('assistant', 'x'.repeat(9000)),
    M('user', 'continue'), M('assistant', 'first continuation'),
    M('user', 'between'), M('assistant', 'middle result'),
    M('user', 'continue'), M('assistant', 'second continuation'),
    M('user', 'last'), M('assistant', 'done'),
  ]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out.filter((m: any) => m.text === 'continue').length).toBe(2)
  expect(shape(out)).toContain('between')
  expect(shape(out)).toContain('first continuation')
})

// Regression caught: summary work blocks the turn, or an engine trigger races it with a duplicate summary.
test('an engine trigger joins the turn-end summary and uses its single result', BG_OPTS, async ($, on) => {
  const rows = [M('user', 'protected request'), M('assistant', 'done'), M('user', 'finished topic'), M('assistant', 'A'.repeat(6000)), M('user', 'active topic'), M('assistant', 'working')]
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let summaryStarted = false
  const s: State = { rows, replies: [], splitBlock: () => { summaryStarted = true; return gate } }
  const seen = bottoms(on, s)
  let returned = false
  const turn = $.turn.complete(TURN).then(() => { returned = true })
  for (let i = 0; i < 50 && !summaryStarted; i++) await new Promise(resolve => setTimeout(resolve, 2))
  const returnedBeforeSummary = await Promise.race([turn.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))])
  const engineCompact = $.session.compact(compactInput('auto', handled(rows)))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.splitPrompts).toHaveLength(1)
  release()
  await turn
  const compacted = compactedMessages(await engineCompact)
  expect(summaryStarted).toBe(true)
  expect(returnedBeforeSummary).toBe(true)
  expect(seen.splitPrompts).toHaveLength(1)
  expect(seen.engineCompactions).toBe(0)
  expect(compacted[0]?.text).toBe('protected request')
  expect(compacted[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(compacted.slice(2)).toEqual(rows.slice(4))
})

// Regression caught: a changed A row let the swap delete turns the summary never saw.
test('a background plan whose A rows changed is discarded with rows untouched', BG_OPTS, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(6000)), M('user', 'active B'), M('assistant', 'B result')]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2)] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  s.rows[1] = M('user', 'A changed after summary')
  const unchanged = handled(s.rows)
  const result = compactedMessages(await $.session.compact(compactInput('plugin', unchanged)))
  expect(result).toEqual(unchanged)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: a split between topics or a tail that cannot fit still produced a destructive plan.
test('a mid-topic split or tail overflow is rejected, retried once, then dropped', { options: { budget: 5000, tailTarget: 300, queueTarget: 1, ledgerTarget: 100, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(12000)), M('user', 'active B'), M('assistant', 'z'.repeat(6000))]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(1.5), splitAnswer(2)] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  for (let i = 0; i < 50 && !seen.logs.some(line => line.includes('split summary dropped')); i++) await new Promise(resolve => setTimeout(resolve, 2))
  expect(seen.splitPrompts).toHaveLength(2)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(seen.logs.some(line => line.includes('split summary dropped'))).toBe(true)
})

// Regression caught: applying a precomputed summary changed B after the model selected its split.
test('the applied background fold is head plus ledger plus B verbatim', BG_OPTS, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), use('tu_a', 'Bash'), res('tu_a', 'A'.repeat(6000)), M('assistant', 'A done'), M('user', 'active B'), use('tu_b', 'Edit'), res('tu_b', 'B result'), M('assistant', 'B done')]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2, 'B topic', 'B summary')], compressionReplies: [compressedTopics([{ topic: 'B topic', summary: 'B summary', seq: 1 }])] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const result = compactedMessages(await $.session.compact(compactInput('plugin', handled(rows))))
  const expectedTail = rows.slice(5).map(({ handle: _handle, ...message }) => message)
  expect(result[0]?.text).toBe('protected request')
  expect(result[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(result.slice(2)).toEqual(expectedTail)
  const clear = logEvents(seen).find(event => event.event === 'clear')!
  expect(typeof clear.summaryMs).toBe('number')
  expect(typeof clear.durationMs).toBe('number')
  expect(metaIn(seen).foldDurationsMs?.['1']).toBe(clear.durationMs)
})

// Regression caught: a ready fold replaced the transcript before its summary reached the escape threshold.
test('a ready fold waits below the escape threshold and swaps on the first crossing compaction', { options: { budget: 5000, tailTarget: 1200, queueTarget: 1, ledgerTarget: 300, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(6000)), M('user', 'active B'), M('assistant', 'B result')]
  const usage = (tokens: number) => ({ startedAt: 0, rateLimits: [], context: { window: 200000, tokens } })
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2)], usage: usage(4900) }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  s.usage = usage(4800)
  const belowThreshold = compactedMessages(await $.session.compact(compactInput('manual', handled(rows))))
  expect(belowThreshold).toEqual(handled(rows))
  expect(seen.store['pending:s1']).toBeDefined()

  s.usage = usage(4900)
  const crossed = compactedMessages(await $.session.compact(compactInput('auto', handled(rows))))
  expect(crossed[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(storedLedger(seen)).toContain('build summary')
  expect(seen.splitPrompts).toHaveLength(1)
})

// Regression caught: rewinding across an applied fold never restored the prior ledger snapshot.
test('a real rewind restores the prior folded ledger without another summary call', { options: { budget: 5000, tailTarget: 3000, queueTarget: 1, ledgerTarget: 750, reserve: 100 } }, async ($, on) => {
  const s: State = { rows: ROWS, replies: [], splitReplies: [splitAnswer(2, 'T1', 'A outcome'), splitAnswer(2, 'T2', 'B outcome')] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const first = compactedMessages(await $.session.compact(compactInput('auto', handled(ROWS))))
  expect(storedLedger(seen)).toContain('A outcome')
  s.rows = [...first]
  await $.turn.complete(turnInput('second-fold'))
  await waitForPending(seen)
  const second = compactedMessages(await $.session.compact(compactInput('auto', handled(s.rows))))
  expect(storedLedger(seen)).toContain('B outcome')
  expect(seen.store['ledger-snapshots:s1:main']).toHaveLength(2)

  s.rows = [...first]
  const calls = seen.splitPrompts.length + seen.prompts.length + seen.compressionPrompts.length
  const restored = compactedMessages(await $.session.compact(compactInput('plugin', handled(s.rows))))
  expect(restored.some(row => row.text.startsWith('[clm ledger #'))).toBe(true)
  expect(storedLedger(seen)).toContain('A outcome')
  expect(storedLedger(seen)).not.toContain('B outcome')
  expect(seen.splitPrompts.length + seen.prompts.length + seen.compressionPrompts.length).toBe(calls)
})

// Regression caught: a repeated short prompt fingerprint made an intact ledger look like an un-restorable rewind.
test('a duplicated short prompt rewind leaves the ledger intact', { options: { budget: 5000, tailTarget: 3000, queueTarget: 1, ledgerTarget: 750, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'continue'), M('assistant', 'A'.repeat(6000)), M('user', 'continue'), M('assistant', 'B work'), M('user', 'continue'), M('assistant', 'C work')]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2, 'T1', 'durable ledger')] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const compacted = compactedMessages(await $.session.compact(compactInput('auto', handled(rows))))
  const before = storedLedger(seen)
  const repeated = compacted.findIndex((row, index) => index > 1 && row.role === 'user' && row.text === 'continue')
  if (repeated < 0) throw new Error('fixture has no repeated short prompt in the kept tail')
  s.rows = compacted.filter((_row, index) => index !== repeated)
  await $.session.compact(compactInput('plugin', handled(s.rows)))
  expect(storedLedger(seen)).toBe(before)
  expect(seen.logs.some(line => line.includes('restored ledger snapshot'))).toBe(false)
})

// Regression caught: re-folding kept T1 at its old size or discarded an exact user instruction.
test('ledger recompression shrinks the old topic and preserves each user instruction verbatim', { options: { budget: 5000, tailTarget: 1200, queueTarget: 1, ledgerTarget: 150, reserve: 100 } }, async ($, on) => {
  const instruction = 'Keep the public API stable while changing the parser.'
  const oldSummary = 'T1 '.repeat(160)
  const oldLedger = `[clm ledger #1 · 2026-10-14 09:00 KST] Earlier turns of this session were folded into these notes by a Haiku summary (file: ${LEDGER_FILE}).\n\n## 목표\n- T1: ${oldSummary}\n\n## 사용자 지시\n- (none yet)\n\n## 한 일\n- (none yet)\n\n## 할 일\n- (none yet)\n\n## 미결 질문\n- (none yet)\n\n## 핵심 사실·경로\n- (none yet)`
  const rows = [M('user', 'protected request'), M('user', oldLedger), M('user', instruction), M('assistant', 'A complete'), M('user', 'continue with B'), M('assistant', 'B result')]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2, 'T2', 'new topic summary')], compressionReplies: [compressedTopics([
    { topic: 'T1', summary: 'T1 closed outcome', seq: 1 },
    { topic: 'T2', summary: 'new topic summary', seq: 2 },
  ])] }
  const seen = bottoms(on, s)
  seen.files[LEDGER_FILE] = oldLedger
  seen.store['ledger:s1'] = { seq: 1, fails: 0 }
  seen.store['topics:s1'] = [{ topic: 'T1', summary: oldSummary, seq: 1 }]
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const result = compactedMessages(await $.session.compact(compactInput('plugin', handled(rows))))
  const ledgerRow = result[1]?.text ?? ''
  expect(seen.compressionPrompts).toHaveLength(1)
  expect(storedLedger(seen)).toContain('T1:')
  expect(ledgerRow).toContain('T1: T1 closed outcome')
  expect(ledgerRow).not.toContain(oldSummary)
  const ledgerMessage = result[1]
  if (!ledgerMessage) throw new Error('fold omitted the ledger message')
  expect(est(ledgerMessage)).toBeLessThanOrEqual(150)
  expect(instructionValues(storedLedger(seen))).toContain(instruction)
})

// Regression caught (guards 2 and 6): a fold cut the tool result of the newest turn while that command was still in progress.
test('an oversized result in an older kept turn is cut while the newest turn stays whole', { options: { budget: 5000, tailTarget: 3000, reserve: 100 } }, async ($, on) => {
  const olderResult = 'HEAD' + 'z'.repeat(16000) + 'TAIL'
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', olderResult), M('assistant', 'dumped'), M('user', 'ok'), M('assistant', 'ok')]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  const result = out.find((m: any) => m.toolResults?.[0]?.tool_use_id === 'tu_e').toolResults[0].text
  expect(result.startsWith('HEAD')).toBe(true)
  expect(result.endsWith('TAIL')).toBe(true)
  expect(result).toMatch(new RegExp(`…\\[clm: \\d+ of ${olderResult.length} chars cut at fold time\\]…`))
  expect(result.length).toBeLessThan(4 * 1200)
  expect(storedLedger(seen)).toContain('- 출력 과다: Bash {"id":"tu_e"}')
  expect(logEvents(seen).map(e => e.event)).toContain('truncation')
  expect(out.find((m: any) => m.text === 'ok')).toBeDefined()
})

// Regression caught: oversize notes pile up in the ledger without bound across folds.
test('only the last five oversize notes stay in the ledger', OPTS, async ($, on) => {
  const old = ['a', 'b', 'c', 'd', 'e'].map(c => `- 출력 과다: Bash old-${c}`).join('\n')
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', 'z'.repeat(16000)), M('assistant', 'dumped'), M('user', 'ok'), M('assistant', 'ok')]
  const s: State = { rows, replies: [ledger('new fact')] }
  const seen = bottoms(on, s)
  // Oversize notes are harness lines: an earlier fold left five in the stored ledger.
  seen.files[LEDGER_FILE] = `## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- kept fact — quote: "log"\n${old}`
  await turnEnds($, s, seen)
  const notes = storedLedger(seen).split('\n').filter((l: string) => l.includes('출력 과다:'))
  expect(notes.length).toBe(5)
  expect(notes[0]).toContain('old-b')
  expect(notes[4]).toContain('tu_e')
  expect(storedLedger(seen)).toContain('kept fact')
})

// Regression caught (guard 3): a fold whose ledger outweighs the turns it drops makes the context bigger, and the next turn folds again.
test('a fold that would not shrink the context is skipped with both sizes logged', { options: { budget: 2000, tailTarget: 1990, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'start'), M('user', 'a'), M('assistant', 'A'), M('user', 'b'), M('assistant', 'B'), M('user', 'go'), M('assistant', 'w'.repeat(7600))]
  const s: State = { rows, replies: [ledger('p'.repeat(1700))] }
  const seen = bottoms(on, s)
  await $.session.compact(compactInput('manual', handled(rows)))
  expect(seen.store['pending:s1']).toBeUndefined()
  const line = seen.logs.find(l => l.includes('would not shrink'))!
  expect(line).toMatch(/\(\d+ -> \d+ est\. tokens\)/)
  const ev = logEvents(seen).find(e => e.event === 'skip-not-shrinking')
  expect(ev.tokensAfter).toBeGreaterThanOrEqual(ev.tokensBefore)
})

// Regression caught: an engine-requested compaction could not shrink the transcript after a malformed merge.
test('an engine manual compaction uses a mechanical ledger when the merge fails', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['bad'] }
  const seen = bottoms(on, s)
  const result = compactedMessages(await $.session.compact(compactInput('manual', handled(ROWS))))
  const row = result[1]?.text ?? ''
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(section(row, '핵심 사실·경로')).toBe('')
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('요약 없이 접힘:')
  expect(logEvents(seen).map(e => e.event)).toEqual(['merge-invalid', 'merge-invalid', 'fallback', 'clear'])
})

// Regression caught: system prompt tokens in usage must not block a queue-triggered background summary.
test('queueTarget schedules the background fold independently of the usage reading', { options: { budget: 5000, tailTarget: 3000, queueTarget: 1, ledgerTarget: 600, reserve: 100 } }, async ($, on) => {
  const rows = ROWS
  const usage = (tokens: number) => ({ startedAt: 0, rateLimits: [], context: { window: 200000, tokens } })
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2)], usage: usage(6000) }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  expect(metaIn(seen).ratio).toBeUndefined()
  expect(seen.store['pending:s1']).toBeDefined()
})

// Regression caught: system usage alone scheduled a summary while the queue stayed below queueTarget.
test('a queue below queueTarget does not schedule a summary for a large usage reading', OPTS, async ($, on) => {
  // The 6000-token reading is mostly system prompt; the message queue stays below the configured 100000-token target.
  const s: State = { rows: ROWS.slice(4), replies: [ledger('x')], usage: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 6000 } } }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect(seen.prompts.length).toBe(0)
  expect(seen.store['pending:s1']).toBeUndefined()
  // A later usage baseline does not change the queue-size trigger.
  seen.store['ledger:s1'] = { seq: 1, fails: 0, overhead: 4800, ratio: 1 }
  await $.turn.complete(TURN)
  expect(seen.prompts.length).toBe(0)
})

// Regression caught: the usage reading from before a fold was read as current after it, so every later turn folded again.
test('a turn after a fold with an unchanged usage reading does not fold again', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('x'), ledger('y')], usage: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 6000 } } }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(seen.prompts.length).toBe(1)
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'ok'), M('assistant', 'fine')]
  await $.turn.complete(TURN)
  expect(seen.prompts.length).toBe(1)
  expect(seen.store['pending:s1']).toBeUndefined()
})

// Regression caught (guard 7): empty and "(no content)" rows carried into the rewritten transcript waste context and can be refused by the API.
test('empty and "(no content)" rows are dropped from the fold result', OPTS, async ($, on) => {
  const rows = [...ROWS.slice(0, 12), M('assistant', '(no content)'), M('assistant', ''), ...ROWS.slice(12)]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out.some((m: any) => m.text === '(no content)' || (m.text === '' && ids(m).length === 0))).toBe(false)
})

// Regression caught (guard 8): a fold or skip leaves nothing to diagnose it from after the fact.
test('every fold writes a JSONL decision line with sizes, kept turns and ratio', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const clear = logEvents(seen).find(e => e.event === 'clear')
  expect(Object.keys(clear).sort()).toEqual(['durationMs', 'event', 'keptTurns', 'ratio', 'reason', 'summaryMs', 'tokensAfter', 'tokensBefore', 'ts'])
  expect(clear.keptTurns).toBe(2)
  expect(clear.tokensAfter).toBeLessThan(clear.tokensBefore)
})

// Regression caught (guard 9): a budget under 2000 or a reserve over the budget is silently replaced and the user never learns the setting was ignored.
test('a bad option is logged with the value actually used', { options: { budget: 100, tailTarget: 50000, queueTarget: 0, ledgerTarget: 2000, reserve: 9999 } }, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true } satisfies SessionStartInput)
  expect(seen.logs).toContain('clm: option budget=100 must be an integer of at least 2000; using 2000')
  expect(seen.logs).toContain('clm: option tailTarget=50000 must be a positive integer under the budget (2000); using 1000')
  expect(seen.logs).toContain('clm: option queueTarget=0 must be a positive integer; using 8000')
  expect(seen.logs).toContain('clm: option ledgerTarget=2000 must be a non-negative integer under tailTarget (1000); using 250')
  expect(seen.logs).toContain('clm: option reserve=9999 must be a positive integer under the budget (2000); using 500')
})

// Regression caught: with no plan pending, the engine's threshold or a /compact runs its own summarizer and replaces the ledger with an engine summary.
test('auto compaction with no pending plan produces a clm ledger instead of an engine summary', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('INLINE-FACT'), 'not a ledger'] }
  const seen = bottoms(on, s)
  const auto = compactedMessages(await $.session.compact(compactInput('auto', handled(ROWS))))
  expect(auto[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(section(auto[1].text, 'learned')).toContain('INLINE-FACT')
  expect(storedLedger(seen)).toContain('INLINE-FACT')
  // A failed merge still folds, mechanically, rather than handing over to the engine.
  const manual = compactedMessages(await $.session.compact(compactInput('manual', handled([...auto, M('user', 'more'), use('tu_f', 'Bash'), res('tu_f', BIG), M('assistant', 'ok')]))))
  expect(manual[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(manual.some(m => m.text.startsWith('[clm ledger #2'))).toBe(false)
  expect(manual.some(m => m.text === 'ENGINE SUMMARY')).toBe(false)
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: a non-shrinking compaction job delegated a competing engine summary.
test('a non-shrinking auto job leaves the transcript unchanged after its escape attempt', { options: { budget: 2000, tailTarget: 1990, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'start'), M('user', 'a'), M('assistant', 'A'), M('user', 'b'), M('assistant', 'B'), M('user', 'go'), M('assistant', 'w'.repeat(7600))]
  const s: State = { rows, replies: [ledger('p'.repeat(1700))] }
  const seen = bottoms(on, s)
  const r = await $.session.compact({ trigger: 'auto', messages: handled(rows) })
  if (!('messages' in r)) throw new Error('compaction returned no messages')
  expect(r.messages?.map(m => m.text)).toEqual(rows.map(m => m.text))
  expect(seen.engineCompactions).toBe(0)
  expect(logEvents(seen).find(e => e.event === 'escape')).toBeDefined()
})


const FOLD_ROWS = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(6000)), M('user', 'active B'), M('assistant', 'B result')]
const attach = ($: any, type: string, text: string) => $.prompt.attachment({ type, text, origin: { kind: 'engine' } })

// Regression caught: a fold summarised or dropped CLAUDE.md and the tool listings, so the engine re-injected them after every ledger.
test('captured CLAUDE.md and tool listings sit verbatim ahead of the ledger and are not re-injected', BG_OPTS, async ($, on) => {
  const s: State = { rows: FOLD_ROWS, replies: [], splitReplies: [splitAnswer(2)] }
  const seen = bottoms(on, s)
  on('prompt.attachment', (_$: any, e: any) => ({ text: e.text }))
  expect((await attach($, 'instructions', 'CLAUDE RULES')).text).toBe('CLAUDE RULES')
  expect((await attach($, 'deferred_tools_delta', 'TOOL LIST')).text).toBe('TOOL LIST')
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const out = compactedMessages(await $.session.compact(compactInput('auto', handled(FOLD_ROWS))))
  expect(out.slice(0, 4).map(m => m.text)).toEqual(['<system-reminder>\nCLAUDE RULES\n</system-reminder>', '<system-reminder>\nTOOL LIST\n</system-reminder>', 'protected request', expect.stringMatching(/^\[clm ledger #1 · /)])
  expect(out.filter(m => m.text.includes('CLAUDE RULES'))).toHaveLength(1)
  expect((await attach($, 'instructions', 'CLAUDE RULES')).text).toBeNull()
  expect((await attach($, 'instructions', 'CLAUDE RULES v2')).text).toBe('CLAUDE RULES v2')
})

// Regression caught: a session opened by an isMeta peer message kept its whole first turn in the head and re-emitted it after every fold.
test('rows ahead of the first request are folded, leaving the ledger right after the pinned prefix and request', BG_OPTS, async ($, on) => {
  const rows = [use('tu_p', 'Read'), res('tu_p', 'peer turn output'), ...FOLD_ROWS]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2)] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const out = compactedMessages(await $.session.compact(compactInput('auto', handled(rows))))
  expect(out[0]?.text).toBe('protected request')
  expect(out[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(out.some(m => m.toolResults?.some(r => r.text === 'peer turn output'))).toBe(false)
})

// Regression caught: some session.compact trigger fell through to the engine's native summarizer.
test('no main-agent compaction trigger reaches native compaction', BG_OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: FOLD_ROWS, replies: [] })
  for (const trigger of ['manual', 'auto', 'plugin', 'precompute'] as const) await $.session.compact(compactInput(trigger, handled(FOLD_ROWS)))
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: a moved or unreadable transcript file threw out of the fold and broke compaction.
test('a fold still applies when the transcript file cannot be read', BG_OPTS, async ($, on) => {
  const s: State = { rows: FOLD_ROWS, replies: [], splitReplies: [splitAnswer(2)] }
  const seen = bottoms(on, s)
  seen.store['transcript-path:s1'] = '/gone/s1.jsonl'
  Object.defineProperty(seen.files, '/gone/s1.jsonl', { enumerable: true, get() { throw new Error('ENOENT: moved') } })
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const out = compactedMessages(await $.session.compact(compactInput('auto', handled(FOLD_ROWS))))
  expect(out[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: the background fold started on queue size alone, far below the 60% point, or never started at it.
test('an unset budget starts the background fold once usage crosses 60% of the window', { options: { tailTarget: 1200, queueTarget: 1, ledgerTarget: 300 } }, async ($, on) => {
  const usage = (tokens: number) => ({ startedAt: 0, rateLimits: [], context: { window: 10000, tokens } })
  const s: State = { rows: FOLD_ROWS, replies: [], splitReplies: [splitAnswer(2)], usage: usage(5900) }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect(seen.splitPrompts).toHaveLength(0)
  s.usage = usage(6000)
  await $.turn.complete({ ...TURN, turnId: 'crossed' })
  await waitForPending(seen)
  expect(seen.splitPrompts).toHaveLength(1)
})
