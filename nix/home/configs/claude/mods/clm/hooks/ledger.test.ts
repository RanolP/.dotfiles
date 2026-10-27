import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, RenderPropsOf, SessionCompactInput, SessionCompactResult, SessionMessage, SessionStartInput, ToolCallInput, TurnCompleteInput } from 'claude-code'

import { boardHtml } from './board'
import { chooseContinuation, clmStatus, isHeld, resetUserWorkflow, removeQueueSnapshotTargets, restoreFailedContinuation, sessionIssues, submitWithRecovery, trackIssue, recallRows, residentLedgerText, TASK_TOOL } from './register'
import type { Held, Meta } from './register'
import { INTENT_SYSTEM } from './intent'
import type { ClmWorkflow } from '../types'
import { migrateLegacyLedger, residentLedger } from './resident'
import { emptyClauseStore, parseClause } from './clauses'

import { ageDecayPlan, carryLegacyInstructions, fallbackLedger, instructionValues, issueList, MERGE_SYSTEM, parseMerge, renderTurns, REVIEW_SYSTEM, SPLIT_MERGE_SYSTEM } from './ledger'
import { recordPrompt, sentAtOf, stampMessages } from './address'
import { askedItems, CONFIRM_ITEMS, CONFIRM_PREFIX, confirmQuestion, renderRange } from './evidence'
import { describe, focusOf, parseLog, snapshot, toEvents, type Issue, type Payload } from './tracker'
import { estTokens, fingerprint, ledgerRowText, TOKEN_ESTIMATOR_VERSION } from './fold'
import { M, intentReply, use, res, BIG, MID, ROWS, CITE, ledger, splitAnswer, compressedTopics, TURN, OPTS, LEDGER_FILE, LOG_FILE, storedLedger, ids, est, shape, handled, compactInput, promptInput, turnInput, commandInput, compactedMessages, workflow, heldIn, isMetaValue, metaIn, bottoms, turnEnds, waitForPending, BG_OPTS, logEvents, panelHandlers, sixDone, storedOverhead, NOTE_REPLY, ESCAPE_ROWS, WITHHELD_FILE, section, PR_ROWS, TRACKER, seedTracker, issueAt, runClm, LATER_BAND_PROPS, waitForLog } from './clm-test-support'
import type { State, On, Seen, PanelReply } from './clm-test-support'

test('a merge prompt never asks for a clause kind the validator rejects', () => {
  const accepted = new Set(['fact', 'goal'])
  for (const prompt of [MERGE_SYSTEM, SPLIT_MERGE_SYSTEM]) {
    const named = [...prompt.matchAll(/\bkind ([a-z-]+)/g)].map(match => match[1])
    expect(named.every(kind => accepted.has(kind!))).toBe(true)
  }
})

// Regression caught: the clause-only merge contract accidentally required a prose instruction section.
test('a clause merge reply needs no prose instruction section', async () => {
  const ok = parseMerge('{"ops":[]}', new Set())
  expect(typeof ok).not.toBe('string')
  if (typeof ok !== 'string') expect(ok.clauseOps).toEqual([])
})



// Regression caught: a long instruction was truncated before the model could retrieve its source.
test('a long instruction remains whole behind its transcript address', async () => {
  const prompt = 'line one\n' + 'x'.repeat(2100)
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- f'
  const dropped = [M('user', prompt)]
  const first = carryLegacyInstructions(fallbackLedger(prev, dropped), [], dropped, '/ledger.md')
  expect(first.notes).toContain(JSON.stringify(prompt))
  expect(first.fullNotes.split(JSON.stringify(prompt)).length).toBe(2)
  // The next fold reads the file's values back as prior; the same prompt dropped again stays one line.
  const again = carryLegacyInstructions(first.fullNotes, [prompt], dropped, '/ledger.md')
  expect(again.fullNotes.split(JSON.stringify(prompt)).length).toBe(2)
  expect(again.notes.split(JSON.stringify(prompt)).length).toBe(2)
})

// Regression caught: the removed instruction cap hid older or newer directives from the address index source.
test('instruction preservation has no character cap', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- f'
  const old = Array.from({ length: 12 }, (_, i) => `old instruction ${i} ${'x'.repeat(24)}`)
  const out = carryLegacyInstructions(prev, old, [M('user', 'newest correction')], '/ledger.md')
  expect(out.notes).toContain('- "newest correction"')
  expect(out.notes).toContain(JSON.stringify(old[0]))
  expect(out.notes).toContain(JSON.stringify(old[11]))
})

// Regression caught: a dropped built-in summary was preserved as a user constraint after its head row was folded into the ledger.
test('a dropped built-in compact summary is not preserved as a user instruction', () => {
  const notes = '## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- f'
  const summary = M('user', 'This session is being continued from a previous conversation…') as SessionMessage & { isCompactSummary: boolean }
  summary.isCompactSummary = true
  const out = carryLegacyInstructions(notes, [], [summary], '/ledger.md')
  expect(instructionValues(out.notes)).toEqual([])
})

// Regression caught: the compact row exposed every task instead of the scoped sections, including owned resources.
test('the eight-section ledger keeps actions under the focused task and resources separate', async () => {
  const issue = (id: string, title: string, status: Issue['status'], parent?: string, notes: string[] = []) => ({
    id, title, status, ...(parent ? { parent } : {}), notes, linked: [],
    origin: { session: 's1', repo: 'github.com/o/r', cwd: '/w' }, updated: '2026-10-15T00:00:00Z',
  } satisfies Issue)
  const top = issue('s1-1', 'focused build', 'doing', undefined, ['last build note'])
  const child = issue('s1-2', 'run focused tests', 'todo', top.id)
  const unrelated = issue('s1-3', 'unrelated docs', 'todo')
  const uncertain = issue('s1-4', 'verify package checksum', 'uncertain', undefined, ['check the release digest'])
  const row = residentLedgerText(top, '@e330c1ab', 2, 1, [], {
    where: ['Build verification: tests are next.'], children: [child, unrelated],
    requests: [{ id: 'R1', text: 'Rebuild the package.', quote: 'Please rebuild the package', status: 'open' }],
    constraints: ['- preserve generated outputs — quote: "build tool generated this file" @aabbccdd'],
    uncertain: [uncertain], learned: ['- the build tool failed once — quote: "exit code 1"'], resources: ['- metro :8081', '- mutex ipad held'],
  })
  expect([...row.matchAll(/^## (.+)$/gm)].map(match => match[1])).toEqual([
    'where we are', 'what to do', 'what to request', 'user instructions', 'facts', 'uncertain', 'owned resources',
  ])
  expect(row).toContain('focused build — last build note @e330c1ab')
  expect(row).toContain('Build verification: tests are next.')
  expect(row).toContain('run focused tests')
  expect(row).not.toContain('unrelated docs')
  expect(row).toContain('[R1] Rebuild the package.')
  expect(row).toContain('preserve generated outputs')
  expect(row).toContain('verify package checksum — settling check: check the release digest')
  expect(row).toContain('## owned resources\n\n- metro :8081\n- mutex ipad held')
  expect(row).toContain('the build tool failed once')
  expect(row).toContain('- stack 2 · pending 1')
})

test('a legacy prose ledger migrates without losing a line', () => {
  const notes = '## 목표\n- old work\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- [constraint] keep generated files\n- lint failed before the fix'
  const store = migrateLegacyLedger(emptyClauseStore(), notes, [{ topic: 'old work', summary: 'tests remain', seq: 1, focusIssue: 's1-1' }], 3, '2026-10-27T00:00:00Z')
  expect(store.clauses.filter(clause => clause.status === 'live').map(clause => clause.text).sort()).toEqual([
    'keep generated files', 'lint failed before the fix', 'old work: tests remain',
  ])
  expect(store.legacy ?? []).toEqual([])
})

// Regression caught: the merge model received B and moved it into the summary even though the swap keeps B verbatim.
test('the merge and review inputs exclude the verbatim tail after split selection', BG_OPTS, async ($, on) => {
  const rows = [
    M('user', 'protected request'),
    M('user', 'A completed topic'), M('assistant', `A summary source ${'A'.repeat(24_000)}`),
    M('user', 'B active topic'), M('assistant', 'B-TAIL-ONLY secret details'),
  ]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2, 'A topic', 'A summary', 'A summary')] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const result = compactedMessages(await $.session.compact(compactInput('plugin', handled(rows))) as SessionCompactResult)
  expect(seen.splitPrompts[0]).toContain('B-TAIL-ONLY secret details')
  expect(seen.reviewPrompts[0]).toContain('A completed topic')
  expect(seen.reviewPrompts[0]).not.toContain('B-TAIL-ONLY secret details')
  expect(result.slice(2)).toEqual(rows.slice(3))
})

// Regression caught: an unverified constraint disappeared after the next fold because it was stored with decaying lessons.
test('a quoted tool constraint survives two folds without entering topic decay', OPTS, async ($, on) => {
  const first = JSON.stringify({ ops: [{ op: 'fact', kind: 'constraint', text: 'The build tool requires generated artifacts to stay checked in.', evidence: [{ ref: 'tu_a', quote: 'log: make fails at' }] }] })
  const second = '{"ops":[]}'
  const s: State = { rows: ROWS, replies: [first, second] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(section(seen.results[0].messages[1].text, 'facts')).toContain('generated artifacts to stay checked in')
  const firstMessages = seen.results[0].messages
  s.rows = [...ROWS, ...firstMessages, ...ROWS.slice(4)]
  await turnEnds($, s, seen)
  expect(section(seen.results[1].messages[1].text, 'facts')).toContain('generated artifacts to stay checked in')
})

const confirmIssue = (id: string, title: string, status: Issue['status']): Issue =>
  ({ id, title, status, origin: { session: 's1', repo: 'r', cwd: '/' }, notes: [], linked: [], updated: '' })

// Regression caught: a fold that answered the open confirm question retitled that now-closed question instead of asking anew.
test('a fold that closes the confirm question and adds a claim asks in a new question', () => {
  const issues = [confirmIssue('s1-q', `${CONFIRM_PREFIX}"tag the release"`, 'question'), confirmIssue('s1-a', 'push the tag', 'todo')]
  const out = confirmQuestion([{ op: 'status', issue: 's1-a', status: 'done' }], [{ op: 'status', issue: 's1-q', status: 'done' }], issues, new Set())
  expect(out).toEqual([{ op: 'create', title: `${CONFIRM_PREFIX}s1-a "push the tag"`, status: 'question', note: `${CONFIRM_ITEMS}[{"id":"s1-a","title":"push the tag"}]` }])
})

// Regression caught: a done claim on the confirmation question itself became a nested confirmation item on each fold.
test('confirmation questions never become their own confirmation items', () => {
  const title = `${CONFIRM_PREFIX}s1-a "draft PR 만들기"`
  const q = confirmIssue('s1-q', title, 'question')
  expect(confirmQuestion([{ op: 'status', issue: q.id, status: 'done' }], [], [q], new Set())).toEqual([])
  expect(confirmQuestion([{ op: 'create', title, status: 'done' }], [], [], new Set())).toEqual([])
})

// Regression caught: the main agent's resident ledger had no questions section, so it never saw the confirm question it should relay.
test('the resident ledger lists open questions without the stored item list', () => {
  const [made] = confirmQuestion([{ op: 'create', title: 'tag the release', status: 'done' }], [], [], new Set())
  if (made?.op !== 'create') throw new Error('expected a create')
  const q = { ...confirmIssue('s1-q', made.title, 'question'), notes: [made.note ?? ''] }
  const row = residentLedgerText(undefined, undefined, 0, 0, [], { questions: [q, confirmIssue('s1-z', 'answered before', 'done')] })
  expect(row).toContain(`## open questions\n\n- ${made.title} [s1-q]`)
  expect(row).not.toContain('answered before')
  expect(row).not.toContain(CONFIRM_ITEMS)
})

// Regression caught: resident metadata was four bare lines, long instructions were silently cut, and empty or fact sections rendered blank/unbulleted lines.
test('the resident ledger renders compact metadata, marked clipping, bullets and placeholders', () => {
  const long = 'x'.repeat(81)
  const row = residentLedgerText(undefined, undefined, 2, 1, [`- ${long} (C1 @abcd1234)`], {
    where: [''], constraints: ['keep it'], learned: [''], resources: ['port 8080'],
  })
  expect(section(row, 'where we are')).toContain('- stack 2 · pending 1')
  expect(row).not.toContain('Stack size')
  expect(section(row, 'user instructions')).toContain(`- ${long} (C1 @abcd1234)`)
  expect(section(row, 'facts').trim()).toBe('- keep it')
  expect(section(row, 'owned resources').trim()).toBe('- port 8080')
})

// Regression caught: after the clause store replaced the instruction index, live sessions showed no user instructions and repeated them as open requests.
test('the resident ledger shows the live clause text and hides the retracted one', async () => {
  const store: Record<string, unknown> = {
    'clauses:s1:main': {
      version: 1, nextId: 3, predicates: { benchmark: { key: 1, example: 'benchmark(stylelint, cache_patch_only).' } }, clauses: [
        { id: 'C1', head: { name: 'benchmark', args: [{ atom: 'stylelint' }, { atom: 'upgrade' }] }, neg: false, body: [], source: 'benchmark(stylelint, upgrade).', text: 'stylelint 업그레이드 상태로 벤치마크한다.', quote: '업그레이드했을 때 벤치마크', address: '@00000001', promptSeq: 1, issue: null, at: '2026-10-27T00:00:00Z', status: 'retracted', retraction: { at: '2026-10-27T00:00:01Z', by: 'C2', bySource: 'benchmark(stylelint, cache_patch_only).', reason: 'conflict' } },
        { id: 'C2', head: { name: 'benchmark', args: [{ atom: 'stylelint' }, { atom: 'cache_patch_only' }] }, neg: false, body: [], source: 'benchmark(stylelint, cache_patch_only).', text: 'stylelint 벤치마크는 캐시만 패치한 상태로 잰다.', quote: '캐시만 패치해서 벤치마크 해봐', address: '@00000002', promptSeq: 2, issue: null, at: '2026-10-27T00:00:01Z', status: 'live' },
      ],
    },
  }
  const row = await residentLedger({
    get: async key => store[key],
    readLedger: async () => undefined, readMeta: async () => ({ seq: 0 }), readLegacyTopics: async () => [],
    readRequests: async () => [
      { id: 'R1', text: 'Run the cache-only benchmark.', quote: '캐시만 패치해서 벤치마크 해봐', status: 'open' },
      { id: 'R2', text: 'Publish the report.', quote: '리포트를 올려줘', status: 'open' },
    ],
  }, 's1:main', [], { stack: [], pending: [] }, [])
  expect(section(row, 'user instructions')).toContain('- stylelint 벤치마크는 캐시만 패치한 상태로 잰다. (C2 @00000002)')
  expect(row).not.toContain('업그레이드 상태로')
  expect(section(row, 'what to request')).not.toContain('[R1]')
  expect(section(row, 'what to request')).toContain('[R2]')
})

test('an open request stays visible when a goal clause covers the same topic', async () => {
  const clauseStore = emptyClauseStore()
  clauseStore.clauses = [{
    id: 'C1', ...parseClause("goal('I-1', publish_report)."), source: "goal('I-1', publish_report).", text: 'Publish the report.', quote: '리포트를 올려줘', address: '@goal', promptSeq: 1, sources: [], issue: null, at: '2026-10-27T00:00:00Z', status: 'live', origin: 'fold', kind: 'goal',
  }]
  clauseStore.nextId = 2
  const row = await residentLedger({
    get: async () => clauseStore, readLedger: async () => undefined, readMeta: async () => ({ seq: 0 }), readLegacyTopics: async () => [],
    readRequests: async () => [{ id: 'R1', text: 'Publish the report.', quote: '리포트를 올려줘', status: 'open' }],
  }, 's1:main', [], { stack: [], pending: [] }, [])
  expect(section(row, 'what to request')).toContain('[R1]')
})

// Regression caught: a malformed note carrying the item prefix sent the re-read to the clipped title, losing the items behind "외 N건" and keeping that tail as an item.
test('a malformed confirm note falls back to the last stored list, and the title tail is not an item', () => {
  const claims: Payload[] = ['one', 'two', 'three', 'four', 'five', 'six'].map(t => ({ op: 'create', title: `${t} ${'z'.repeat(25)}`, status: 'done' }))
  const [made] = confirmQuestion(claims, [], [], new Set())
  if (made?.op !== 'create') throw new Error('expected a create')
  expect(made.title).toMatch(/외 \d+건$/)
  const q = { ...confirmIssue('s1-q', made.title, 'question'), notes: [made.note ?? '', `${CONFIRM_ITEMS}2건 남음`] }
  expect(askedItems(q).map(i => i.title)).toEqual(claims.map(c => c.op === 'create' ? c.title : ''))
  expect(askedItems({ ...q, notes: [] }).some(i => /외 \d+건/.test(i.title))).toBe(false)
})

// Regression caught: the confirm question's stored JSON item list leaked into the ledger issue list, the tracker log and the resident ledger.
test('the confirm item note never shows where an issue note is shown', () => {
  const [made] = confirmQuestion([{ op: 'create', title: 'tag the release', status: 'done' }], [], [], new Set())
  if (made?.op !== 'create') throw new Error('expected a create')
  const q = { ...confirmIssue('s1-q', made.title, 'question'), notes: [made.note ?? ''] }
  const event = toEvents([{ op: 'note', issue: 's1-q', text: made.note ?? '' }], { session: 's1', repo: 'r', cwd: '/' }, 0, '')
  const shown = [issueList([q]), describe(event, [q]).join('\n'), residentLedgerText(q, undefined, 1, 0, [], { children: [{ ...q, parent: 's1-q' }] })]
  for (const text of shown) expect(text).not.toContain(CONFIRM_ITEMS)
})

// Regression caught: a question whose title was clipped, or whose item held the ` · ` separator, lost items on the next fold's re-read and closed unanswered.
test('a confirm question survives a later fold with no claims, whatever its titles', () => {
  const asQuestion = (ops: Payload[]) => {
    const [made] = ops
    if (made?.op !== 'create') throw new Error(`expected a create, got ${JSON.stringify(ops)}`)
    expect(made.title.length).toBeLessThanOrEqual(200)
    return { ...confirmIssue('s1-q', made.title, 'question'), notes: made.note ? [made.note] : [] }
  }
  const claim = (title: string): Payload => ({ op: 'create', title, status: 'done' })
  for (const titles of [['a'.repeat(100), 'b'.repeat(100)], ['x'.repeat(250)], ['split · here']]) {
    const q = asQuestion(confirmQuestion(titles.map(claim), [], [], new Set()))
    expect(confirmQuestion([], [], [q], new Set())).toEqual([])
    const [note, retitle] = confirmQuestion([claim('push the tag')], [], [q], new Set())
    expect(note?.op === 'note' && JSON.parse(note.text.slice(CONFIRM_ITEMS.length)).map((i: { title: string }) => i.title)).toEqual([...titles, 'push the tag'])
    expect(retitle?.op === 'retitle' && retitle.title.length <= 200).toBe(true)
  }
})

// Regression caught: the extended confirm question kept items already finished, or repeated one asked as `<id> "T"` and as `"T"`.
test('extending the confirm question drops finished items, dedupes by title, and closes when empty', () => {
  const q = confirmIssue('s1-q', `${CONFIRM_PREFIX}s1-a "push the tag" · "tag the release"`, 'question')
  const issues = [q, confirmIssue('s1-a', 'push the tag', 'done')]
  expect(confirmQuestion([{ op: 'create', title: 'push the tag', status: 'done' }], [], issues, new Set(['tag the release'])))
    .toEqual([{ op: 'status', issue: 's1-q', status: 'done' }])
  const open = [{ ...q, title: `${CONFIRM_PREFIX}s1-a "push the tag"` }, confirmIssue('s1-a', 'push the tag', 'todo')]
  expect(confirmQuestion([{ op: 'create', title: 'push the tag', status: 'done' }], [], open, new Set())).toEqual([])
})

// Regression caught: the fold's uncited done claims were silently parked as uncertain instead of going to the user, and each fold would ask again in a new question.
test('fold uncited dones become one confirm question, not uncertain', OPTS, async ($, on) => {
  const ops = JSON.stringify([{ op: 'create', title: 'verify the package checksum', status: 'done' }, { op: 'create', title: 'tag the release', status: 'done' }])
  const s: State = { rows: ROWS, replies: [JSON.stringify({ ops: JSON.parse(ops) })] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const tracker = () => snapshot(parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? ''))
  expect(tracker().filter(issue => issue.status !== 'question').map(issue => [issue.title, issue.status])).toEqual([['verify the package checksum', 'todo'], ['tag the release', 'todo']])
  expect(tracker().filter(issue => issue.status === 'question').map(issue => issue.title)).toEqual(['이 항목들이 끝났는지 확인: "verify the package checksum" · "tag the release"'])
  expect(section(storedLedger(seen), '미결 질문')).toContain('이 항목들이 끝났는지 확인')
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'more'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'ok'), M('user', 'push'), M('assistant', 'pushed')]
  s.replies.push(JSON.stringify({ ops: [{ op: 'create', title: 'push the tag', status: 'done' }] }))
  await turnEnds($, s, seen)
  expect(tracker().filter(issue => issue.status === 'question').map(issue => issue.title)).toEqual(['이 항목들이 끝났는지 확인: "verify the package checksum" · "tag the release" · "push the tag"'])
})

// Regression caught: a fold landed confirm ops computed before the user answered the question mid-fold, retitling the closed question with the answered items instead of asking the new claim.
test('a confirm answer given while a fold runs is not undone when the fold lands', OPTS, async ($, on) => {
  const ops = JSON.stringify([{ op: 'create', title: 'verify the package checksum', status: 'done' }, { op: 'create', title: 'tag the release', status: 'done' }])
  const s: State = { rows: ROWS, replies: [JSON.stringify({ ops: JSON.parse(ops) })] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'more'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'ok'), M('user', 'push'), M('assistant', 'pushed')]
  s.replies.push(JSON.stringify({ ops: [{ op: 'create', title: 'push the tag', status: 'done' }] }))
  s.mergeBlock = async () => {
    s.mergeBlock = undefined
    const log = seen.files[TRACKER] ?? ''
    const answer: Payload[] = tracker().filter(issue => issue.status !== 'done').map(issue => ({ op: 'status', issue: issue.id, status: 'done' }))
    const lastSeq = parseLog(log).reduce((n, event) => Math.max(n, event.seq), 0)
    seen.files[TRACKER] = log + toEvents(answer, { session: 's1', repo: 'github.com/o/repo', cwd: '/work/repo' }, lastSeq, new Date().toISOString()).map(event => `${JSON.stringify(event)}\n`).join('')
  }
  await turnEnds($, s, seen)
  const questions = tracker().filter(issue => issue.title.startsWith(CONFIRM_PREFIX)).map(issue => [issue.title, issue.status])
  expect(questions).toEqual([
    [`${CONFIRM_PREFIX}"verify the package checksum" · "tag the release"`, 'done'],
    [`${CONFIRM_PREFIX}"push the tag"`, 'question'],
  ])
})

// Regression caught: an item the user denied came back in the next fold's question once the question holding the denial had closed.
test('a denied confirm item is not asked again after its question closes', () => {
  const closed = { ...confirmIssue('s1-q', `${CONFIRM_PREFIX}"tag the release"`, 'done'), notes: [`${CONFIRM_ITEMS}[{"title":"tag the release","denied":true}]`] }
  expect(confirmQuestion([{ op: 'create', title: 'tag the release', status: 'done' }], [], [closed], new Set())).toEqual([])
})

// Regression caught: a denial held forever by title, so a done claimed again after work resumed on the issue was never asked and the issue could close only through clm_task.
test('a done claimed again after the denied issue moved is asked again', () => {
  const closed = { ...confirmIssue('s1-q', `${CONFIRM_PREFIX}s1-a "push the tag"`, 'done'), notes: [`${CONFIRM_ITEMS}[{"id":"s1-a","title":"push the tag","denied":true,"at":"2026-10-06T00:00:01.000Z"}]`] }
  const claim: Payload = { op: 'status', issue: 's1-a', status: 'done' }
  const issue = (updated: string) => ({ ...confirmIssue('s1-a', 'push the tag', 'doing'), updated })
  expect(confirmQuestion([claim], [], [closed, issue('2026-10-06T00:00:00.000Z')], new Set())).toEqual([])
  const [made] = confirmQuestion([claim], [], [closed, issue('2026-10-06T00:00:02.000Z')], new Set())
  expect(made?.op === 'create' && made.title).toBe(`${CONFIRM_PREFIX}s1-a "push the tag"`)
})

// Regression caught: a create-as-done denied by title was asked again once withhold landed it as a todo and the next fold claimed it by id.
test('a title denial still holds when the same claim returns by id', () => {
  const q = { ...confirmIssue('s1-q', `${CONFIRM_PREFIX}"ship X"`, 'done'), notes: [`${CONFIRM_ITEMS}[{"title":"ship X","denied":true,"at":"2026-10-06T00:00:01.000Z"}]`] }
  const b = { ...confirmIssue('s1-b', 'ship X', 'todo'), updated: '2026-10-06T00:00:00.000Z' }
  expect(confirmQuestion([{ op: 'status', issue: 's1-b', status: 'done' }], [], [q, b], new Set())).toEqual([])
})

// Regression caught: a new merge kept sending already-small old topics back to the model.
test('age decay leaves a floor-sized old topic untouched on the next merge', async () => {
  const topics = [
    { sourceTokens: 1000, currentTokens: 1000, floorTokens: 50, seq: 1 },
    { sourceTokens: 800, currentTokens: 800, floorTokens: 50, seq: 2 },
  ]
  const beforeC = ageDecayPlan(topics, 1300)
  expect(beforeC.targets[0]).toBe(500)
  expect(beforeC.targets[1]).toBe(800)
  expect(beforeC.rewrite).toEqual([0])

  const afterC = ageDecayPlan([...topics, { sourceTokens: 600, currentTokens: 600, floorTokens: 50, seq: 3 }], 1040)
  expect(afterC.targets[0]).toBeGreaterThanOrEqual(160)
  expect(afterC.targets[0]).toBeLessThanOrEqual(180)
  expect(afterC.targets[1]).toBeGreaterThanOrEqual(260)
  expect(afterC.targets[1]).toBeLessThanOrEqual(280)
  expect(afterC.targets[2]).toBe(600)

  const atFloor = ageDecayPlan([
    { sourceTokens: 1000, currentTokens: 100, floorTokens: 100, seq: 1 },
    { sourceTokens: 800, currentTokens: afterC.targets[1] ?? 800, floorTokens: 50, seq: 2 },
    { sourceTokens: 600, currentTokens: 600, floorTokens: 50, seq: 3 },
  ], 900)
  expect(atFloor.targets[0]).toBe(100)
  expect(atFloor.rewrite).not.toContain(0)
})

// Regression caught: a withdrawn instruction disappeared from the full ledger file along with the visible notes.
test('a withdrawn instruction stays in fullNotes as withdrawn but leaves visible notes', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- f'
  const out = carryLegacyInstructions(prev, ['keep this', 'take this back'], [], '/ledger.md', ['take this back'])
  expect(out.notes).toContain('- "keep this"')
  expect(out.notes).not.toContain('take this back')
  expect(out.fullNotes).toContain('- (withdrawn) "take this back"')
})

// Regression caught: re-issuing a previously withdrawn instruction stayed hidden because withdrawal state was sticky.
test('a re-issued withdrawn instruction becomes visible in its newest slot', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- (withdrawn) "use tabs"\n\n## 핵심 사실·경로\n- f'
  const out = carryLegacyInstructions(prev, instructionValues(prev), [M('user', 'use tabs')], '/ledger.md')
  expect(out.notes).toContain('- "use tabs"')
})

// Regression caught: a model TaskUpdate's subject and description were dropped silently, or an unknown task id got a deny that never said where the change belongs.
test('a model TaskUpdate records retitle and note, and an unknown id is sent to the reply text', OPTS, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => ({ result: { task: { id: 'panel-1', subject: e.subject } } }))
  on('tool.call', { tool: 'TaskUpdate' }, (_$: any, e: any) => ({ result: { success: true, taskId: e.taskId, updatedFields: [] } }))
  await $.tool.call({ tool: 'TaskCreate', subject: 'event task', description: 'created' })
  const r = await $.tool.call({ tool: 'TaskUpdate', taskId: 'panel-1', subject: 'renamed task', description: 'more detail' })
  if (!('deny' in r)) throw new Error('model TaskUpdate was not denied')
  expect(r.deny).toContain('clm이 트래커에 기록했다')
  expect(r.deny).toContain('renamed task')
  expect(seen.logs).toContain("작업 'event task' 재조정 -> 'renamed task'")
  expect(seen.logs).toContain("작업 'renamed task' 메모: more detail")
  const unknown = await $.tool.call({ tool: 'TaskUpdate', taskId: 'nope', status: 'completed' })
  if (!('deny' in unknown)) throw new Error('unknown TaskUpdate was not denied')
  expect(unknown.deny).toContain('답변 본문에 적어라')
})

// Regression caught: two task calls in flight at once each read the log before the other wrote, and one issue was lost or both got the same id.
test('two concurrent model TaskCreate calls keep both issues with distinct ids', OPTS, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => ({ result: { task: { id: `panel-${++n}`, subject: e.subject } } }))
  await Promise.all([
    $.tool.call({ tool: 'TaskCreate', subject: 'first', description: '' }),
    $.tool.call({ tool: 'TaskCreate', subject: 'second', description: '' }),
  ])
  const issues = snapshot(parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? ''))
  expect(issues.map(i => i.title).sort()).toEqual(['first', 'second'])
  expect(new Set(issues.map(i => i.id)).size).toBe(2)
})

// Regression caught: instruction lines from a ledger written before JSON-quoted instructions failed to parse and were deleted for good on the first fold after the upgrade.
test('legacy free-form instruction lines survive clause migration verbatim', async () => {
  const legacy = ['"headless only, no visible windows, no input events" (UI 검증)', 'PR 병합에 대해: "ㅇ 일단 다 머지하고 생각해보자"']
  const notes = `## 목표\n- g\n\n## 사용자 지시\n${legacy.map(l => `- ${l}`).join('\n')}\n- "quoted one"\n- [additional user instructions in /ledger.md]\n\n## 핵심 사실·경로\n- f`
  const out = carryLegacyInstructions(notes, instructionValues(notes), [], '/ledger.md')
  expect(instructionValues(out.fullNotes)).toEqual([...legacy, 'quoted one'])
})

// Regression caught: on the escape path the retry fold dropped the row holding the withheld pointer, the merge saw only the pointer, and the prune deleted the file, losing the tool output with no record.
test('a tool result folded away on the escape path keeps its withheld file and a ledger pointer to it', OPTS, async ($, on) => {
  const s: State = { rows: ESCAPE_ROWS, replies: [new Error('merge down'), ledger('x')], usage: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 6000 } } }
  const seen = bottoms(on, s)
  const r = await $.session.compact({ trigger: 'auto', messages: handled(ESCAPE_ROWS) })
  if (!('messages' in r)) throw new Error('compaction returned no messages')
  expect(seen.engineCompactions).toBe(0)
  expect(seen.files[WITHHELD_FILE]).toBe('r'.repeat(4000))
  expect(storedLedger(seen)).toContain(`- 보존된 출력: ${WITHHELD_FILE}`)
  expect(seen.files[LEDGER_FILE]).toContain(`- 보존된 출력: ${WITHHELD_FILE}`)
  expect(r.messages?.some(m => m.toolResults?.some(x => x.tool_use_id === 'tu_a'))).toBe(false)
})

// Regression caught: the escape retry calibrated against the usage reading from before the results were withheld, inflating overhead so the next fold shrank the tail to one turn.
test('an escape retry leaves meta.overhead as it was', OPTS, async ($, on) => {
  const s: State = { rows: ESCAPE_ROWS, replies: [new Error('merge down'), ledger('x')], usage: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 6000 } } }
  const seen = bottoms(on, s)
  seen.store['ledger:s1'] = { seq: 0, fails: 0, overhead: 100, ratio: 1, estimatorVersion: TOKEN_ESTIMATOR_VERSION }
  const r = await $.session.compact({ trigger: 'auto', messages: handled(ESCAPE_ROWS) })
  if (!('messages' in r)) throw new Error('compaction returned no messages')
  expect(seen.engineCompactions).toBe(0)
  expect(storedOverhead(seen.store['ledger:s1'])).toBe(100)
})

// Regression caught: when the merge failed twice, the failed escape retry handed the rows back unchanged and the context never shrank.
test('a failed escape retry hands off to exactly one engine summary', OPTS, async ($, on) => {
  const s: State = { rows: ESCAPE_ROWS, replies: [new Error('merge down'), new Error('still down')] }
  const seen = bottoms(on, s)
  const messages = compactedMessages(await $.session.compact(compactInput('auto', handled(ESCAPE_ROWS))))
  expect(seen.engineCompactions).toBe(1)
  expect(messages.map(m => m.text)).toEqual(['ENGINE SUMMARY', '[clm clauses]\n- (none)'])
  expect(seen.files[WITHHELD_FILE]).toBe('r'.repeat(4000))
})

// Regression caught: a subagent compaction overwrote the main session's ledger or metadata.
test('precompute skips and subagent compaction leaves the main ledger and metadata unchanged', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [] }
  const seen = bottoms(on, s)
  seen.files[LEDGER_FILE] = 'main ledger snapshot'
  seen.store['ledger:s1'] = { seq: 7, fails: 2 }
  const r = await $.session.compact(compactInput('precompute', handled(ROWS)))
  if (!('skip' in r)) throw new Error('precompute did not skip clm compaction')
  expect(r.skip).toBe('clm replaces compaction')
  expect(seen.engineCompactions).toBe(0)
  expect(seen.prompts.length).toBe(0)
  const beforeLedger = seen.files[LEDGER_FILE]
  const beforeMeta = seen.store['ledger:s1']
  const child = compactedMessages(await $.session.compact(compactInput('auto', handled(ROWS), { agentId: 'a1' })))
  expect(child.map(message => message.text)).toEqual(['ENGINE SUMMARY'])
  expect(seen.files[LEDGER_FILE]).toBe(beforeLedger)
  expect(seen.store['ledger:s1']).toEqual(beforeMeta)
  expect(seen.engineCompactions).toBe(1)
})

test("a precompute compaction without messages still skips as 'clm replaces compaction'", OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [] })
  const input = { trigger: 'precompute' } as SessionCompactInput
  const result = await $.session.compact(input)
  if (!('skip' in result)) throw new Error('precompute compaction without messages did not skip')
  expect(result.skip).toBe('clm replaces compaction')
  expect(seen.prompts.length).toBe(0)
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: every ledger row showed the latest fold's duration, deferred time leaked into it, expanded rows were hidden, and ledger-like user text was intercepted.
test('each folded ledger renders its own compact duration and ledger-like user text passes through', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('FIRST-FACT'), ledger('FIRST-FACT; SECOND-FACT')], mergeDelays: [1200, 3400] }
  const seen = bottoms(on, s)
  let passed = 0
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    passed++
    const { Text } = $.ui.resolve(e)
    return Text({ children: [e.props.text] })
  })

  const firstCompact = $.session.compact({ trigger: 'manual', messages: handled(ROWS) })
  await seen.clock.settle()
  await seen.clock.advance(1200)
  const first = await firstCompact
  if (!('messages' in first)) throw new Error('first compaction returned no messages')
  const firstRow = first.messages.find((m: any) => m.text.startsWith('[clm ledger'))
  s.rows = [...ROWS, ...first.messages, M('user', 'add docs'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'docs added'), M('user', 'push'), M('assistant', 'pushed')]
  const secondCompact = $.session.compact({ trigger: 'manual', messages: handled(s.rows) })
  await seen.clock.settle()
  await seen.clock.advance(3400)
  const second = await secondCompact
  if (!('messages' in second)) throw new Error('second compaction returned no messages')
  const secondRow = second.messages.find((m: any) => m.text.startsWith('[clm ledger'))

  const firstLedger = await $.ui.mount({
    plugin: 'clm', surface: 'terminal', component: 'UserMessage',
    props: { text: firstRow.text, origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await firstLedger.drawn()).children).toEqual(['* clm compacted in 1.2 s'])
  const secondLedger = await $.ui.mount({
    plugin: 'clm', surface: 'terminal', component: 'UserMessage',
    props: { text: secondRow.text, origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await secondLedger.drawn()).children).toEqual(['* clm compacted in 3.4 s'])
  expect(passed).toBe(0)

  const expanded = await $.ui.mount({
    plugin: 'clm', surface: 'terminal', component: 'UserMessage',
    props: { text: firstRow.text, origin: { kind: 'composer' }, isExpanded: true },
  })
  expect((await expanded.drawn()).children).toEqual([firstRow.text])
  expect(passed).toBe(1)

  const ordinary = await $.ui.mount({
    plugin: 'clm', surface: 'terminal', component: 'UserMessage',
    props: { text: "[clm ledger is what I'd call it", origin: { kind: 'composer' }, isExpanded: false },
  })
  expect((await ordinary.drawn()).children).toEqual(["[clm ledger is what I'd call it"])
  expect(passed).toBe(2)
})

test('board page escapes a model-written title, so a <script> title cannot run in the browser', () => {
  const html = boardHtml([{ id: 'a1', title: '<script>alert(1)</script>', status: 'todo', repo: 'github.com/x/y', updated: '2026-01-01T00:00:00Z' }], 'github.com/x/y', 'now')
  expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
  expect(html).not.toContain('<script>alert(1)')
})

// Regression caught: a session opened by /clear kept that command row as its first request, so every fold drew "/clear" above the ledger.
test('fold row renders /clear or ledger text instead of the compacted line', OPTS, async ($, on) => {
  const CLEAR = '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>'
  const rows = [M('user', CLEAR), M('user', '<local-command-stdout></local-command-stdout>'), ...ROWS]
  const s: State = { rows, replies: [ledger('fact')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out.some((m: any) => m.text.includes('<command-name>/clear') || m.text.includes('<local-command-'))).toBe(false)
  expect(out[0].text).toBe('please investigate the build')
  const row = out.find((m: any) => m.text.startsWith('[clm ledger'))
  expect(row.text).not.toContain('## 핵심 사실·경로')
  expect(section(row.text, 'facts')).toContain('fact')
  const drawn = await $.ui.mount({ plugin: 'clm', surface: 'terminal', component: 'UserMessage', props: { text: row.text, origin: { kind: 'composer' }, isExpanded: false } })
  expect((await drawn.drawn()).children[0]).toMatch(/^\* clm compacted/)
})

// Regression caught: a session folded before /clear became a system row kept [/clear, ledger] as its head, so the next fold pinned the stale ledger above the new one.
test('a fold over an older fold drops the /clear row and the stale ledger', OPTS, async ($, on) => {
  const CLEAR = '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>'
  const OLD = '[clm ledger #3 · 2026-10-06T00:00:00.000Z] Earlier turns of this session were folded into these notes by the harness (file: x). They are your memory of that work.\n\n## 목표\n- old'
  const s: State = { rows: [M('user', CLEAR), M('user', OLD), ...ROWS], replies: [ledger('fact')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out.some((m: any) => m.text.includes('<command-name>/clear'))).toBe(false)
  expect(out.filter((m: any) => m.text.startsWith('[clm ledger')).map((m: any) => m.text.slice(0, 14))).toEqual(['[clm ledger #1'])
  expect(out[0].text.startsWith('[clm ledger #1')).toBe(true)
})

// Regression caught: rendered turns lost each message's own send time, so a fold could not resolve "내일" against the day it was said.
test('renderTurns and renderRange stamp each message with its own KST send time and leave an unknown one unstamped', async () => {
  const store: Record<string, unknown> = {}
  const io = { get: async (key: string) => store[key], set: async (key: string, value: unknown) => { store[key] = value } }
  const rows: SessionMessage[] = [
    { role: 'user', text: '내일 배포하자', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', tool_use_id: 't1', input: {} } as SessionMessage['toolUses'][number]] },
    { role: 'user', text: 'never seen by a hook', toolUses: [] },
  ]
  await recordPrompt(io, 's1:main', '내일 배포하자', '2026-10-15T05:03:00.000Z')
  await stampMessages(io, 's1:main', rows.slice(0, 2), '2026-10-15T05:04:00.000Z')
  const sentAt = await sentAtOf(io, 's1:main')
  expect(renderTurns(rows, 120_000, sentAt).split('\n').filter(line => line.startsWith('['))).toEqual([
    '[user 2026-10-15 14:03 KST] 내일 배포하자', '[assistant 2026-10-15 14:04 KST]', '[user] never seen by a hook',
  ])
  expect(renderRange(rows, 120_000, 0, sentAt).text).toContain('[user m1 2026-10-15 14:03 KST] 내일 배포하자')
})

// Regression caught: fixed ledger sections accumulated past ledgerTarget while older learned facts crowded out constraints.
test('a row built from oversized sections no longer exceeds ledgerTarget', async () => {
  const items = (label: string, count: number) => Array.from({ length: count }, (_, i) => `- ${label} ${i} ${'x'.repeat(300)}`)
  const section = (name: string, lines: string[]) => `## ${name}\n${lines.join('\n')}`
  const ledger = [
    section('where we are', ['- focused task @aabbccdd', ...items('old topic', 12), '- stack 2 · pending 0']),
    section('what to do', items('child task', 6)),
    section('what to request', items('open request', 5)),
    section('constraints & preferences', ['- keep the migration constraint']),
    section('uncertain', items('uncertain issue', 5)),
    section('learned', items('old learned', 25)),
    section('owned resources', items('owned resource', 8)),
  ].join('\n\n')
  const row = ledgerRowText(9, '2026-10-16 09:00 KST', '/ledger.md', ledger, 400)
  expect(estTokens({ role: 'user', text: row, toolUses: [] })).toBeLessThanOrEqual(400)
  expect(row).toContain('keep the migration constraint')
  expect(row).not.toContain('old learned 0')
  expect(row).not.toContain('old learned 1')
})
