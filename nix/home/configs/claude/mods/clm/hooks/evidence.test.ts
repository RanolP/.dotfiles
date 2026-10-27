import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, RenderPropsOf, SessionCompactInput, SessionCompactResult, SessionMessage, SessionStartInput, ToolCallInput, TurnCompleteInput } from 'claude-code'

import { boardHtml } from './board'
import { chooseContinuation, clmStatus, isHeld, resetUserWorkflow, removeQueueSnapshotTargets, restoreFailedContinuation, sessionIssues, submitWithRecovery, trackIssue, recallRows, residentLedgerText, TASK_TOOL } from './register'
import type { Held, Meta } from './register'
import { INTENT_SYSTEM } from './intent'
import type { ClmWorkflow } from '../types'

import { ageDecayPlan, fallbackLedger, instructionValues, LEDGER_COMPACT_SYSTEM, MERGE_SYSTEM, parseMerge, preserveInstructions, REVIEW_SYSTEM, SPLIT_MERGE_SYSTEM } from './ledger'
import { focusOf, parseLog, snapshot, toEvents, type Issue, type Payload } from './tracker'
import { fingerprint } from './fold'
import { checkEvidence } from './evidence'
import { M, intentReply, use, res, BIG, MID, ROWS, CITE, ledger, splitAnswer, compressedTopics, TURN, OPTS, LEDGER_FILE, LOG_FILE, storedLedger, ids, est, shape, handled, compactInput, promptInput, turnInput, commandInput, compactedMessages, workflow, heldIn, isMetaValue, metaIn, bottoms, turnEnds, waitForPending, BG_OPTS, logEvents, panelHandlers, sixDone, storedOverhead, NOTE_REPLY, ESCAPE_ROWS, WITHHELD_FILE, section, PR_ROWS, TRACKER, seedTracker, issueAt, runClm, LATER_BAND_PROPS, waitForLog } from './clm-test-support'
import type { State, On, Seen, PanelReply } from './clm-test-support'
// --- evidence gate and review ------------------------------------------------

// Regression caught: refs copied as rendered (`<- [toolu_…]`, `[user m4 … KST]`) or with the `m` dropped or case changed missed their source row, so every done they backed was downgraded.
test('a ref spelled the way the range renders it resolves to its row, and an assistant ref still fails', () => {
  const user = { kind: 'user' as const, text: 'please investigate the build' }
  const tool = { kind: 'tool_result' as const, text: 'log: make fails at' }
  const sources = new Map([['m4', user], ['toolu_01AbC', tool], ['abcd1234', user], ['@beef5678', user]])
  const evidence = [
    { ref: ' [user m4 2026-10-15 14:03 KST] ', quote: user.text },
    { ref: '<- [toolu_01AbC]', quote: tool.text },
    { ref: 'TOOLU_01ABC', quote: tool.text },
    { ref: 'M4', quote: user.text },
    { ref: '4', quote: user.text },
    { ref: '[assistant 2026-10-15 14:04 KST]', quote: user.text },
    { ref: '@ABCD1234', quote: user.text },
    { ref: 'BEEF5678', quote: user.text },
  ]
  const checked = checkEvidence(evidence, sources)
  expect(checked.held.map(item => item.ref)).toEqual(['m4', 'toolu_01AbC', 'toolu_01AbC', 'm4', 'm4', 'abcd1234', '@beef5678'])
  expect(checked.problems).toEqual(['ref [assistant 2026-10-15 14:04 KST] is not a citable row of the folded range'])
})

// Regression caught (a): a done step resting on the assistant's own recommendation, or on a tool result that shows the opposite, reached 한 일.
test('a close the assistant only recommended, with the PR still OPEN, ends not done', OPTS, async ($, on) => {
  const ops = [
    // Cites a real quote that the reviewer must see does not prove the close.
    { op: 'create', title: 'PR #<pr> 닫기', status: 'done', evidence: [{ ref: 'tu_pr', quote: 'PR <pr> state: OPEN' }] },
    // Quotes the assistant's prose under tu_pr's ref: the mechanical check fails it because the text is not in tu_pr.
    { op: 'create', title: 'PR #<pr> 정리', status: 'done', evidence: [{ ref: 'tu_pr', quote: 'I recommend closing PR #<pr>; closed it' }] },
  ]
  const s: State = {
    rows: PR_ROWS, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`],
    reviewReplies: ['{"verdicts":[{"id":"op1","accept":false,"reason":"tu_pr shows the PR OPEN; closing was only recommended"},{"id":"op2","accept":true,"reason":"ok"}]}'],
  }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(section(storedLedger(seen), '한 일')).not.toContain('PR #<pr>')
  expect(section(storedLedger(seen), '미결 질문')).toContain('"PR #<pr> 닫기" · "PR #<pr> 정리"')
  expect(seen.reviewPrompts[0]).toContain('"quote":"PR <pr> state: OPEN"')
  expect(seen.reviewPrompts[0]).toContain('[assistant 2026-10-06 09:00 KST] I recommend closing PR #<pr>; closed it.')
  const events = logEvents(seen)
  expect(events.find(e => e.event === 'evidence-rejected')?.reason).toContain('PR #<pr> 정리" as done: done held for the user\'s confirmation (quote "I recommend closing PR #<pr>; closed it" is not in tu_pr)')
  expect(events.find(e => e.event === 'review-rejected')?.reason).toContain('done held for the user\'s confirmation')
})

// Regression caught (b): a fact whose quote appears nowhere in the folded rows was kept as if the user or a tool had said it.
test('a fabricated quote is rejected for a fact', OPTS, async ($, on) => {
  const ops = [
    { op: 'fact', text: 'the build passes', evidence: [{ ref: 'tu_a', quote: 'the build passed cleanly' }] },
    { op: 'fact', text: 'the build log is long', evidence: [{ ref: 'tu_a', quote: 'log: make fails at' }] },
  ]
  const s: State = { rows: ROWS, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('the build log is long')
  expect(row).toContain('the build log is long — quote:')
  expect(row).not.toContain('the build passes')
  expect(logEvents(seen).find(e => e.event === 'evidence-rejected')?.reason).toContain('"the build passed cleanly" is not in tu_a')
})

// Regression caught (6): the reviewer could add a "missing instruction" quoted from a tool result, so text the user never wrote landed under 사용자 지시.
test('a tool_result ref cited as an instruction is refused', OPTS, async ($, on) => {
  const s: State = {
    rows: ROWS, replies: [ledger('fact')],
    reviewReplies: ['{"verdicts":[{"id":"fact1","accept":true,"reason":"ok"}],"missing_instructions":[{"ref":"tu_a","quote":"log: make fails at"}]}'],
  }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(section(storedLedger(seen), '사용자 지시')).toBe('- "now fix it"')
  expect(seen.reviewPrompts[0]).not.toContain('missing_instructions')
})

// Regression caught (3): a reviewer that throws or answers malformed JSON let every mechanically passing done reach 한 일 unreviewed.
// Regression caught (round 3, finding 3): the facts of a failed review reached 핵심 사실·경로 unaudited.
test('a reviewer failure records no done, holds the facts out of the ledger, and still folds', OPTS, async ($, on) => {
  const done = '[{"op":"create","title":"빌드 로그 확인","status":"done"}]'
  const s: State = { rows: ROWS, replies: [ledger('HELD-FACT-ONE', done)], reviewReplies: [new Error('review down')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(section(storedLedger(seen), '한 일')).toBe('- (none yet)')
  expect(section(storedLedger(seen), '미결 질문')).toContain('"빌드 로그 확인"')
  expect(row).not.toContain('HELD-FACT-ONE')
  expect(heldIn(seen).map(h => [h.kind, h.text])).toEqual([['fact', 'HELD-FACT-ONE']])
  expect(logEvents(seen).find(e => e.event === 'review-failed')?.reason).toContain('review call failed')
  // A malformed reply takes the same path, and the first fact stays held with the new one.
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'more'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'ok'), M('user', 'push'), M('assistant', 'pushed')]
  s.replies.push(ledger('HELD-FACT-TWO', '[{"op":"create","title":"테스트 통과","status":"done"}]', [{ ref: 'tu_c', quote: 'all 12 tests passed' }]))
  s.reviewReplies = ['{"verdicts":"all fine"}']
  await turnEnds($, s, seen)
  const second = seen.results[1].messages[1].text
  expect(second).not.toContain('HELD-FACT')
  expect(section(storedLedger(seen), '한 일')).toBe('- (none yet)')
  expect(seen.reviewPrompts[1]).toContain('"id":"held1"')
  expect(heldIn(seen).map(h => h.text).sort()).toEqual(['HELD-FACT-ONE', 'HELD-FACT-TWO'])
  expect(logEvents(seen).filter(e => e.event === 'review-failed').length).toBe(2)
  // The next fold's reviewer accepts them, and only then do they reach the ledger.
  s.rows = [...s.rows, ...seen.results[1].messages, M('user', 'and again'), use('tu_e', 'Write'), res('tu_e', 'w ' + BIG), M('assistant', 'ok'), M('user', 'last'), M('assistant', 'fine')]
  s.replies.push(ledger('third', '[]', [{ ref: 'tu_e', quote: 'w ' + 'x'.repeat(40) }]))
  await turnEnds($, s, seen)
  const third = seen.results[2].messages[1].text
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('HELD-FACT-ONE')
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('HELD-FACT-TWO')
  expect(seen.store['held:s1']).toBeUndefined()
})

// Regression caught: nothing evicted a held fact, so with the reviewer down each fold added its facts for good, the resent set outgrew the 2048-token verdict reply, and the truncated JSON failed the review again.
test('a failing reviewer cannot grow the held facts past the cap or truncate the verdict reply', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('NEWEST-FACT')], reviewReplies: [new Error('review down')] }
  const seen = bottoms(on, s)
  const src = { kind: 'tool_result', text: 'log: make fails at a.ts:12', tool: 'Bash', isError: false }
  seen.store['held:s1'] = Array.from({ length: 30 }, (_, i) => ({
    key: `fact:old-${i}`, nonce: `n${i}`, kind: 'fact', text: `OLD-FACT-${i}`, evidence: [{ ref: 'tu_old', quote: 'log: make fails at' }], sources: { tu_old: src },
  }))
  await turnEnds($, s, seen)
  expect(seen.reviewPrompts[0]).toContain('"id":"held30"')
  expect(seen.reviewMaxTokens[0]).toBeGreaterThan(2048)
  const held = heldIn(seen).map(h => h.text)
  expect(held.length).toBe(20)
  expect(held.at(-1)).toBe('NEWEST-FACT')
  expect(held).not.toContain('OLD-FACT-10')
  expect(held).toContain('OLD-FACT-11')
  expect(logEvents(seen).find(e => e.event === 'review-dropped')?.reason).toContain('11 held fact(s) settled unreviewed')
})

// Regression caught: a failed review still applied the merge's retracts and notes, so an accepted fact vanished and a to-do line got "PR #<pr> closed" with no verdict on either.
test('a failed review drops the merge\'s retracts and note ops instead of applying them unreviewed', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('ACCEPTED-FACT', '[{"op":"create","title":"PR 정리","status":"todo"}]')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const tracker = () => snapshot(parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? ''))
  const issue = tracker().find(i => i.title === 'PR 정리')!
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('ACCEPTED-FACT')
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'more'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'ok'), M('user', 'push'), M('assistant', 'pushed')]
  const factLine = section(storedLedger(seen), '핵심 사실·경로').split('\n').find(l => l.includes('ACCEPTED-FACT'))!.replace(/^- /, '')
  const ops = [{ op: 'retract', fact: factLine }, { op: 'note', issue: issue.id, text: 'PR #<pr> closed' }, { op: 'retitle', issue: issue.id, title: 'PR #<pr> 닫힘' }]
  s.replies.push(`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`)
  s.reviewReplies = [new Error('review down')]
  await turnEnds($, s, seen)
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('ACCEPTED-FACT')
  const after = tracker().find(i => i.id === issue.id)!
  expect(after.title).toBe('PR 정리')
  expect(after.notes).not.toContain('PR #<pr> closed')
  expect(logEvents(seen).find(e => e.event === 'review-failed')?.reason).toContain('2 unreviewed op(s) dropped')
})

// Regression caught (4): a reviewer reply with no verdict for a claim accepted it, so an empty verdict list let every done and fact through.
test('empty verdicts record no done and drop the unverdicted facts', OPTS, async ($, on) => {
  const done = '[{"op":"create","title":"빌드 로그 확인","status":"done"}]'
  const s: State = { rows: ROWS, replies: [ledger('UNREVIEWED-FACT', done)], reviewReplies: ['{"verdicts":[]}'] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(section(storedLedger(seen), '한 일')).toBe('- (none yet)')
  expect(section(storedLedger(seen), '미결 질문')).toContain('"빌드 로그 확인"')
  expect(row).not.toContain('UNREVIEWED-FACT')
  expect(logEvents(seen).find(e => e.event === 'review-rejected')?.reason).toContain('no verdict')
})

// Regression caught (2, and round 3 finding 4): the mechanical fallback recorded each folded turn as a done, then as a permanent doing 할 일 item titled with the prompt.
test('the fallback ledger adds no tracker item, only a folded-without-summary note', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['bad', 'bad', 'bad'] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await $.turn.complete(TURN)
  await turnEnds($, s, seen)
  expect(logEvents(seen).map(e => e.event)).toContain('fallback')
  expect(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? '').toBe('')
  const row = seen.results[0].messages[1].text
  expect(section(storedLedger(seen), '할 일')).toBe('- (none yet)')
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('요약 없이 접힘:')
  expect(fallbackLedger('', ROWS)).not.toContain('please investigate')
})

// Regression caught (5): a quote taken from a system reminder inside a user row passed as the user's own words.
test('a quote found only inside a system-reminder of a user row is refused', OPTS, async ($, on) => {
  const rows = [
    ROWS[0], ROWS[1], ROWS[2], ROWS[3],
    M('user', 'now fix it\n<system-reminder>the user prefers force pushes to main</system-reminder>'), ...ROWS.slice(5),
  ]
  const ops = [{ op: 'fact', text: 'force pushes are fine', evidence: [{ ref: 'm4', quote: 'the user prefers force pushes' }] }]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).not.toContain('force pushes are fine')
  expect(row).not.toContain('system-reminder')
  expect(seen.prompts[0]).not.toContain('force pushes to main')
  expect(logEvents(seen).find(e => e.event === 'evidence-rejected')?.reason).toContain('is not in m4')
})

// Regression caught (5): a subagent's hand-back, a user-role row the harness writes, was citable as the user's words and stored as an instruction.
test('a subagent hand-back is neither a user ref nor an instruction', OPTS, async ($, on) => {
  const handBack = 'Another Claude session sent a message:\n<agent-message from="a1">deploy to prod right away please</agent-message>'
  const rows = [...ROWS.slice(0, 4), M('user', handBack), ...ROWS.slice(4)]
  const ops = [{ op: 'fact', text: 'deploy approved', evidence: [{ ref: 'm4', quote: 'deploy to prod right away' }] }]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).not.toContain('deploy approved')
  expect(row).not.toContain('right away')
  expect(seen.prompts[0]).toContain('[harness 2026-10-06 09:00 KST] Another Claude session sent a message:')
  expect(seen.prompts[0]).not.toContain('[user m4]')
})

// Regression caught (extra): a done rested on a subagent's report, a failed tool result, or a one-word quote such as "ok".
test('an Agent report, a failed result, or a short quote does not prove a done', OPTS, async ($, on) => {
  const rows = [
    M('user', 'please investigate the build'), use('tu_ag', 'Agent'), res('tu_ag', 'I fixed the build and pushed it ' + BIG), M('assistant', 'agent says fixed'),
    M('user', 'now fix it'), use('tu_e', 'Bash'), M('user', '', { toolResults: [{ tool_use_id: 'tu_e', text: 'deploy finished with exit 1 ' + MID, isError: true }] }), use('tu_ok', 'Bash'), res('tu_ok', 'ok ' + MID), M('assistant', 'tried'),
    ...ROWS.slice(8),
  ]
  const ops = [
    { op: 'create', title: 'build fixed', status: 'done', evidence: [{ ref: 'tu_ag', quote: 'I fixed the build' }] },
    { op: 'create', title: 'deployed', status: 'done', evidence: [{ ref: 'tu_e', quote: 'deploy finished with exit' }] },
    { op: 'create', title: 'checked', status: 'done', evidence: [{ ref: 'tu_ok', quote: 'ok' }] },
  ]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(section(storedLedger(seen), '한 일')).toBe('- (none yet)')
  const reason = logEvents(seen).find(e => e.event === 'evidence-rejected')?.reason
  expect(reason).toContain('tu_ag is a Agent report')
  expect(reason).toContain('tu_e is a failed tool result')
  expect(reason).toContain('too short to cite')
})

// Regression caught: a transcript too small to fold came back unchanged, so the engine's compaction never shrank the context.
test('a small transcript with no fold plan hands off to the engine summary', OPTS, async ($, on) => {
  const rows = [M('user', 'first request here'), M('user', 'AWS Transcribe도 검토 필요'), M('assistant', 'ok')]
  const s: State = { rows, replies: [] }
  const seen = bottoms(on, s)
  const result = compactedMessages(await $.session.compact(compactInput('auto', handled(rows))))
  expect(seen.engineCompactions).toBe(1)
  expect(result.map(m => m.text)).toEqual(['ENGINE SUMMARY', '[clm clauses]\n- (none)'])
})

// Regression caught (round 3, finding 1): a hand-back excluded from turn boundaries left a coordinator session (one typed prompt, then hand-backs) with a single turn, so it never folded and always escaped to the engine summarizer.
test('a session driven by subagent hand-backs still folds', OPTS, async ($, on) => {
  const back = (n: number) => M('user', `Another Claude session sent a message:\n<agent-message from="a${n}">report ${n} is ready</agent-message>`)
  const rows = [
    M('user', 'please coordinate the build'), use('tu_a', 'Agent'), res('tu_a', 'started ' + BIG), M('assistant', 'spawned'),
    back(1), use('tu_b', 'Bash'), res('tu_b', 'log: make fails at a.ts:12 ' + BIG), M('assistant', 'read report 1'),
    back(2), use('tu_c', 'Bash'), res('tu_c', 'pass: all 12 tests passed ' + BIG), M('assistant', 'read report 2'),
    back(3), M('assistant', 'all done'),
  ]
  const s: State = { rows, replies: [ledger('coordinated', '[]', [{ ref: 'tu_b', quote: 'log: make fails at' }])] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(seen.engineCompactions).toBe(0)
  const row = seen.results[0].messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(section(row, '사용자 지시')).not.toContain('report 1 is ready')
  expect(logEvents(seen).map(e => e.event)).not.toContain('escape')
})

// Regression caught (round 3, finding 2): the hand-back pattern was anchored at the start of the raw text, so a hand-back the harness prefixed with a system-reminder passed as the user speaking.
test('a hand-back that opens with a system-reminder is neither a user ref nor an instruction', OPTS, async ($, on) => {
  const handBack = '<system-reminder>\nnote\n</system-reminder>\nAnother Claude session sent a message:\n<agent-message from="a1">deploy to prod right away please</agent-message>'
  const rows = [...ROWS.slice(0, 4), M('user', handBack), ...ROWS.slice(4)]
  const ops = [{ op: 'fact', text: 'deploy approved', evidence: [{ ref: 'm4', quote: 'deploy to prod right away' }] }]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).not.toContain('deploy approved')
  expect(row).not.toContain('right away')
  expect(seen.prompts[0]).toContain('[harness 2026-10-06 09:00 KST] Another Claude session sent a message:')
  expect(seen.prompts[0]).not.toContain('[user m4]')
})

test('a quote ending in the clip ellipsis or taken from past the clip still holds', OPTS, async ($, on) => {
  const rows = [...ROWS]
  rows[2] = res('tu_a', 'log: make fails at a.ts:12 ' + BIG + ' linker exit code 2 at stage three')
  const ops = [
    { op: 'fact', text: 'FACT-PAST-CLIP', evidence: [{ ref: 'tu_a', quote: 'linker exit code 2 at stage three' }] },
    { op: 'fact', text: 'FACT-ELLIPSIS', evidence: [{ ref: 'tu_a', quote: 'make fails at a.ts:12 xxxx…' }] },
  ]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const facts = section(storedLedger(seen), '핵심 사실·경로')
  expect(facts).toContain('FACT-PAST-CLIP')
  expect(facts).toContain('FACT-ELLIPSIS')
})

// Regression caught: a drop with no quote of the user abandoning that direction reached the tracker, or a failed review landed a user-quoted drop no reviewer had matched to its issue, or lost it instead of holding it.
test('a drop lands only on a user quote, and a failed review holds it for the next review', OPTS, async ($, on) => {
  const rows = [...ROWS]
  rows[4] = M('user', 'stop the build work and switch to the login bug instead')
  const s: State = { rows, replies: [], reviewReplies: [new Error('review down')] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  await $.tool.call({ tool: 'TaskCreate', subject: 'login work', description: 'l' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'build work', description: 'b' })
  const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
  const login = issueAt(tracker(), 0), build = issueAt(tracker(), 1)
  const ops = [
    { op: 'status', issue: build, status: 'dropped', evidence: [{ ref: 'm4', quote: 'stop the build work and switch' }] },
    { op: 'status', issue: login, status: 'dropped', evidence: [{ ref: 'tu_a', quote: 'log: make fails at' }] },
  ]
  s.replies.push(`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`)
  await turnEnds($, s, seen)
  expect(tracker().map(i => [i.title, i.status])).toEqual([['login work', 'todo'], ['build work', 'todo']])
  expect(heldIn(seen).map(h => [h.kind, h.issue])).toEqual([['drop', build]])
  expect(logEvents(seen).find(e => e.event === 'evidence-rejected')?.reason).toContain('drop discarded')
  // The next fold's reviewer accepts the held drop, and only then does it land.
  s.rows = [...seen.results[0].messages, ...rows.slice(4)]
  s.replies.push(ledger('fact'))
  await turnEnds($, s, seen)
  expect(seen.reviewPrompts.at(-1)).toContain('"id":"drop1"')
  expect(tracker().map(i => [i.title, i.status])).toEqual([['login work', 'todo'], ['build work', 'dropped']])
  expect(seen.store['held:s1']).toBeUndefined()
})
