import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, SessionCompactInput, SessionCompactResult, SessionMessage, SessionStartInput, ToolCallInput } from 'claude-code'

import { boardHtml } from './board'
import { chooseContinuation, clmStatus, isHeld, resetUserWorkflow, restoreFailedContinuation, sessionIssues, submitWithRecovery, trackIssue, recallRows, residentLedgerText, TASK_TOOL } from './register'
import type { Held, Meta } from './register'
import { backfillClausesChained, INTENT_SYSTEM, recordPromptIntent, type PromptIntentIo } from './intent'
import { applyClauses, emptyClauseStore, parseClause, readClauseStore, renderClauses } from './clauses'
import { observeTranscript, transcriptRowsKey, type RewindIo } from './rewind'
import type { ClmWorkflow } from '../types'

import { ageDecayPlan, carryLegacyInstructions, fallbackLedger, instructionValues, MERGE_SYSTEM, parseMerge, REVIEW_SYSTEM, SPLIT_MERGE_SYSTEM } from './ledger'
import { CONFIRM_ITEMS, CONFIRM_PREFIX } from './evidence'
import { focusOf, parseLog, parseOps, snapshot, toEvents, type Issue, type Payload } from './tracker'
import { fingerprint } from './fold'
import { M, intentReply, use, res, BIG, MID, ROWS, CITE, ledger, splitAnswer, compressedTopics, TURN, OPTS, LEDGER_FILE, LOG_FILE, storedLedger, ids, est, shape, handled, compactInput, promptInput, turnInput, commandInput, compactedMessages, workflow, heldIn, isMetaValue, metaIn, bottoms, turnEnds, waitForPending, BG_OPTS, logEvents, panelHandlers, sixDone, storedOverhead, NOTE_REPLY, ESCAPE_ROWS, WITHHELD_FILE, section, PR_ROWS, TRACKER, seedTracker, issueAt, runClm, waitForLog } from './clm-test-support'
import type { State, On, Seen, PanelReply } from './clm-test-support'
const seedWorkflow = (on: On, seed: ClmWorkflow) => {
  const isWorkflow = (e: { plugin: string; key: string }) => e.plugin === 'clm' && e.key === 'workflow'
  let written: ClmWorkflow = seed
  on('state.get', async (_$: unknown, e: any, next: (e: any) => Promise<any>) => {
    const read = await next(e)
    return isWorkflow(e) && read.value.value === undefined ? { value: { ...read.value, value: seed } } : read
  })
  on('state.set', async (_$: unknown, e: any, next: (e: any) => Promise<any>) => {
    if (isWorkflow(e)) written = e.value
    return next(e)
  })
  return () => written
}
const pendingResume = () => workflow({ resumeRequest: { text: 'continue the audit' }, activeTurnId: 't1' })

// Regression caught: an aborted main turn still submitted the queued resume.
test('an aborted main turn leaves a queued resume unsubmitted', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [] })
  seedWorkflow(on, pendingResume())
  await $.turn.complete(turnInput('t1', { isAborted: true }))
  expect(seen.submissions).toEqual([])
})

// Regression caught: a subagent's turn end submitted the main session's queued resume.
test('a subagent turn end leaves a queued resume unsubmitted', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [] })
  seedWorkflow(on, pendingResume())
  await $.turn.complete(turnInput('t-agent', { agentId: 'agent-1' }))
  expect(seen.submissions).toEqual([])
})

// Regression caught: a duplicate completion event for one turn submitted the queued resume twice.
test('a duplicate completion of one turn submits a queued resume once', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [] })
  seedWorkflow(on, pendingResume())
  await $.turn.complete(turnInput('t1'))
  await $.turn.complete(turnInput('t1'))
  expect(seen.submissions).toEqual([{ text: 'continue the audit' }])
})

// Regression caught: a hand-back fabricated a handoff in the main session.
test('intent classification skips harness hand-backs but records a composer prompt', OPTS, async ($, on) => {
  const s: State = {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({ intent: 'handoff', title: 'Fix the build' })],
  }
  const seen = bottoms(on, s)
  await $.prompt.submit(promptInput('Another Claude session sent a message: the review is complete'))
  expect(seen.intentPrompts).toEqual([])

  await $.prompt.submit(promptInput('Please fix the build'))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.intentPrompts.length).toBe(1)
  const trackerFile = '/home/t/.claude-work/tracker/events/s1.jsonl'
  let events = (seen.files[trackerFile] ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
  for (let i = 0; i < 20 && !events.some(event => event.op === 'focus'); i++) {
    await new Promise(resolve => setTimeout(resolve, 5))
    events = (seen.files[trackerFile] ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  expect(events.some(event => event.op === 'focus' && event.origin.session === 's1' && event.stack.length === 1)).toBe(true)
})

// Regression caught: a hallucinated target id created a phantom stack entry.
test('an unknown classifier target writes no tracker events', OPTS, async ($, on) => {
  const s: State = {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({ intent: 'handoff', target: 'ghost-1' })],
  }
  const seen = bottoms(on, s)
  await $.prompt.submit(promptInput('Switch to the missing issue'))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.intentPrompts.length).toBe(1)
  expect(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl']).toBeUndefined()
  expect(seen.logs.some(line => line.includes('unknown target id ghost-1'))).toBe(true)
})

// Regression caught: a co-worker land closed the issue the classifier targeted while it ran, and "unknown target id" discarded the whole prompt's focus and deferrals.
test('a classifier target that closed during classification keeps focus and still files deferrals', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({ intent: 'continue', target: 's1-1', deferred: [{ text: 'B 고쳐', quote: 'B는 나중에' }] })],
  })
  seedTracker(seen, [{ op: 'create', issue: 's1-1', title: 'landed work', status: 'done' }])
  await $.prompt.submit(promptInput('좋아, B는 나중에'))
  await until(() => snapshot(parseLog(seen.files[TRACKER] ?? '')).some(issue => issue.title === 'B 고쳐'))
  expect(seen.logs.some(line => line.includes('focus classification failed'))).toBe(false)
  expect(snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.id === 's1-1')?.status).toBe('done')
})

// Regression caught: work explicitly bounded for later vanished instead of becoming a shared todo.
test('a bounded deferral becomes one todo issue on the board', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({
      intent: 'handoff', title: 'A 고쳐',
      deferred: [{ text: 'B 고쳐', quote: 'B는 나중에' }],
    })],
  })
  await $.prompt.submit(promptInput('A 고쳐, B는 나중에'))
  await until(() => snapshot(parseLog(seen.files[TRACKER] ?? '')).some(issue => issue.title === 'B 고쳐'))
  const deferred = snapshot(parseLog(seen.files[TRACKER] ?? '')).filter(issue => issue.title === 'B 고쳐')
  expect(deferred).toHaveLength(1)
  expect(deferred[0]?.status).toBe('todo')
})

// Regression caught: classifier-authored deferred work entered the board without a supporting user quote.
test('a deferred item the prompt does not support creates no issue', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({
      deferred: [{ text: 'Publish the release', quote: 'Publish the release later' }],
    })],
  })
  await $.prompt.submit(promptInput('Continue the current task'))
  await waitForLog(seen, 'clm: deferred item dropped (not supported by prompt): Publish the release')
  expect(snapshot(parseLog(seen.files[TRACKER] ?? '')).some(issue => issue.title === 'Publish the release')).toBe(false)
})

// Regression caught: a whole-message deferral created both the pending focus issue and a duplicate deferred issue.
test('a whole-message deferral creates exactly one issue', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({
      intent: 'pending', title: 'B 고쳐',
      deferred: [{ text: 'B 수정해', quote: 'B는 나중에 해줘' }],
    })],
  })
  await $.prompt.submit(promptInput('B는 나중에 해줘'))
  await waitForLog(seen, 'clm: deferred issue s1-1: B 수정해')
  const issues = snapshot(parseLog(seen.files[TRACKER] ?? ''))
  expect(issues).toHaveLength(1)
  expect(issues[0]?.title).toBe('B 고쳐')
  expect(issues[0]?.status).toBe('todo')
})

// Regression caught: a slow earlier classifier overwrote the focus chosen by a newer prompt.
test('a newer classifier waits for a slow earlier one and focus ends on B', OPTS, async ($, on) => {
  let releaseA!: () => void
  let startedA!: () => void
  const gate = new Promise<void>(resolve => { releaseA = resolve })
  const started = new Promise<void>(resolve => { startedA = resolve })
  const seen = bottoms(on, {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({ intent: 'handoff', title: 'A task' }), intentReply({ intent: 'handoff', title: 'B task' })],
    intentBlocks: [async () => { startedA(); await gate }],
  })
  await $.prompt.submit(promptInput('Start A'))
  await started
  await $.prompt.submit(promptInput('Switch to B'))
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(seen.intentPrompts).toHaveLength(1)
  releaseA()
  const path = '/home/t/.claude-work/tracker/events/s1.jsonl'
  const focusedTitle = () => {
    const events = parseLog(seen.files[path] ?? '')
    return snapshot(events).find(issue => issue.id === focusOf(events, 's1').stack.at(-1))?.title
  }
  await until(() => focusedTitle() === 'B task')
  expect(focusedTitle()).toBe('B task')
  expect(seen.intentPrompts).toHaveLength(2)
})

// Regression caught: a concrete rebuild request without a question mark was omitted from the request ledger.
test('a rebuild request without a question mark is stored', OPTS, async ($, on) => {
  const prompt = 'Please rebuild the configuration before release.'
  const seen = bottoms(on, {
    rows: ROWS, replies: [],
    intentReplies: [intentReply({ raised: [{ text: 'Rebuild the configuration before release.', quote: 'rebuild the configuration before release' }] })],
  })
  await $.prompt.submit(promptInput(prompt))
  for (let i = 0; i < 100 && !Array.isArray(seen.store['requests:s1:main']); i++)
    await new Promise(resolve => setTimeout(resolve, 2))
  expect(seen.store['requests:s1:main']).toEqual([
    expect.objectContaining({ text: 'Rebuild the configuration before release.', status: 'open' }),
  ])
})

// Regression caught: the user's plain answer to the confirm question landed nothing until a later fold happened to read it, and a reply that did not answer it could still change it.
for (const [name, assistant, reply, want] of [
  ['a bare yes after the agent relayed the question confirms all', 'Did you push the tag and tag the release?', '네', { a: 'done', b: 'done', q: 'done' }],
  ['naming one item confirms only it', 'Fixed the lint.', 's1-a 끝났어', { a: 'done', b: 'todo', q: 'question', left: '"tag the release"' }],
  ['naming one item with a no denies it and keeps it open', 'Fixed the lint.', '"push the tag" 아직', { a: 'todo', b: 'todo', q: 'question', left: '"tag the release"' }],
  ['an unrelated reply changes nothing', 'Did you push the tag?', 'run the tests again', { a: 'todo', b: 'todo', q: 'question' }],
  ['a bare yes the agent did not ask for changes nothing', 'Shall I run the tests?', '네', { a: 'todo', b: 'todo', q: 'question' }],
  ['an id asked about is not confirmed', 'Did you push the tag?', 's1-a?', { a: 'todo', b: 'todo', q: 'question' }],
  ['a yes for an item dropped meanwhile neither reopens nor recreates it', 'Did you push the tag and tag the release?', '네', { a: 'dropped', b: 'done', q: 'done', drop: true }],
] as const) {
  test(`confirm answer: ${name}`, OPTS, async ($, on) => {
    const seen = bottoms(on, { rows: [M('user', 'Ship it.'), M('assistant', assistant)], replies: [] })
    const title = `${CONFIRM_PREFIX}s1-a "push the tag" · "tag the release"`
    seedTracker(seen, [
      { op: 'create', issue: 's1-a', title: 'push the tag', status: 'todo' },
      { op: 'create', issue: 's1-b', title: 'tag the release', status: 'todo' },
      { op: 'create', issue: 's1-q', title, status: 'question', note: `${CONFIRM_ITEMS}[{"id":"s1-a","title":"push the tag"},{"title":"tag the release"}]` },
      ...('drop' in want ? [{ op: 'status' as const, issue: 's1-a', status: 'dropped' as const }] : []),
    ])
    await $.prompt.submit(promptInput(reply))
    for (let i = 0; i < 200 && !seen.intentPrompts.length; i++) await new Promise(resolve => setTimeout(resolve, 2))
    const issues = snapshot(parseLog(seen.files[TRACKER] ?? ''))
    const status = (id: string) => issues.find(issue => issue.id === id)?.status
    expect({ a: status('s1-a'), b: status('s1-b'), q: status('s1-q') }).toEqual({ a: want.a, b: want.b, q: want.q })
    expect(issues.map(issue => issue.id)).toEqual(['s1-a', 's1-b', 's1-q'])
    const q = issues.find(issue => issue.id === 's1-q')
    expect(q?.title).toBe('left' in want ? `${CONFIRM_PREFIX}${want.left}` : title)
    if (want.a === 'done') expect(issues.find(issue => issue.id === 's1-a')?.notes.at(-1)).toContain(reply)
  })
}

// Regression caught: one assistant response could answer several queued requests, but only the last one was closed.
test('one assistant answer resolves every matching open request', OPTS, async ($, on) => {
  const quote = 'The configuration was rebuilt and the docs were updated'
  const seen = bottoms(on, {
    rows: [M('user', 'earlier prompt'), M('assistant', quote)], replies: [],
    intentReplies: [
      intentReply({ raised: [
        { text: 'Rebuild the configuration.', quote: 'Please rebuild the configuration' },
        { text: 'Update the docs.', quote: 'also update the docs' },
      ] }),
      intentReply({ resolved: [
        { id: 'R1', how: 'answered', quote },
        { id: 'R2', how: 'answered', quote },
      ] }),
    ],
  })
  await $.prompt.submit(promptInput('Please rebuild the configuration, and also update the docs.'))
  for (let i = 0; i < 100 && !Array.isArray(seen.store['requests:s1:main']); i++) await new Promise(resolve => setTimeout(resolve, 2))
  await $.prompt.submit(promptInput('Those two requests are finished.'))
  for (let i = 0; i < 100 && (seen.store['requests:s1:main'] as { status?: string }[] | undefined)?.some(item => item.status === 'open'); i++)
    await new Promise(resolve => setTimeout(resolve, 2))
  expect(seen.intentPrompts[1]).toContain('<open_requests>\nR1 | Rebuild the configuration.\nR2 | Update the docs.')
  expect((seen.store['requests:s1:main'] as { status: string }[]).map(request => request.status)).toEqual(['answered', 'answered'])
})

// Regression caught: an assistant-authored phrase became a user request without a supporting user quote.
test('a request quoted only from assistant text is rejected', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: [M('assistant', 'I might rebuild the configuration next week.')], replies: [],
    intentReplies: [intentReply({ raised: [{ text: 'Rebuild the configuration.', quote: 'I might rebuild the configuration' }] })],
  })
  await $.prompt.submit(promptInput('Let us discuss priorities.'))
  for (let i = 0; i < 100 && !seen.logs.some(line => line.includes('dropped unsupported raised quote')); i++)
    await new Promise(resolve => setTimeout(resolve, 2))
  expect(seen.store['requests:s1:main']).toBeUndefined()
  expect(seen.logs.some(line => line.includes('dropped unsupported raised quote'))).toBe(true)
})

// Regression caught: a failed continuation submission consumed the resume request and blocked retrying the same turn.
test('a rejected continuation submission restores its resume request and clears its turn claim', async () => {
  let currentWorkflow: ClmWorkflow = workflow({ lastSubmittedTurn: 'retry-turn' })
  const logs: string[] = []
  const submitted = await submitWithRecovery(
    async () => { throw new Error('settings hook refused prompt') },
    async () => { currentWorkflow = restoreFailedContinuation(currentWorkflow, 'retry-turn', { text: 'next item' }) },
    message => logs.push(message),
  )
  expect(submitted).toBe(false)
  expect(currentWorkflow.resumeRequest).toEqual({ text: 'next item' })
  expect(currentWorkflow.lastSubmittedTurn).toBeNull()
  expect(logs).toContain('clm: continuation submit failed (Error: settings hook refused prompt)')
})

// Regression caught: the turn-end selector submitted the same queued resume more than once.
test('the continuation selector consumes a resume request once', async () => {
  const start = workflow({ resumeRequest: { text: 'time-budget resume' } })
  const resumed = chooseContinuation(start, 't1')
  expect(resumed.continuation).toEqual({ text: 'time-budget resume' })
  expect(chooseContinuation(resumed.workflow, 't2').continuation).toBeUndefined()
})

// Regression caught: task notifications cleared queued away-resume requests, or a human return left one stale.
test('only human-origin prompts clear queued resumes', async () => {
  const pending: ClmWorkflow = {
    resumeRequest: { text: 'stale away reminder' }, lastSubmittedTurn: 'claimed-turn', activeTurnId: null,
    promptSeq: 0, focusAppliedSeq: 0,
  }
  expect(resetUserWorkflow(pending, { kind: 'task-notification' })).toBe(pending)
  const returned = resetUserWorkflow(pending, { kind: 'composer' })
  expect(returned.resumeRequest).toBeNull()
  expect(returned.lastSubmittedTurn).toBeNull()
})

// Regression caught: tasks of an abandoned direction stayed open with no way for the user to clear them, or `/clm drop` left their panel tasks behind.
test('/clm drop drops one named issue, then every open issue of the session', OPTS, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  for (const t of ['a', 'b', 'c']) await $.tool.call({ tool: 'TaskCreate', subject: `task ${t}`, description: t })
  const issues = () => snapshot(parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? ''))
  const tracker = () => issues().map(i => i.status)
  await runClm($, `drop ${issueAt(issues(), 1)}`)
  expect(tracker()).toEqual(['todo', 'dropped', 'todo'])
  await runClm($, 'drop all')
  expect(tracker()).toEqual(['dropped', 'dropped', 'dropped'])
  expect(seen.taskCalls.filter(c => c.tool === 'TaskUpdate' && c.status === 'deleted').length).toBe(3)
})

// Regression caught: `!` shell echoes, slash-command wrappers and bare go-aheads ("ㄱㄱ", "지금?") filled 30-40% of 사용자 지시.
test('wrapper rows and short acknowledgements stay out of 사용자 지시', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- "ㄱ"\n\n## 핵심 사실·경로\n- f'
  const dropped = ['<bash-input>adb uninstall com.x</bash-input>', '<bash-stdout>Success</bash-stdout>', '<local-command-stdout>ok</local-command-stdout>', 'ㄱㄱ', '지금?', '빨리 하쇼', 'OK', 'keep the API stable'].map(t => M('user', t))
  const out = carryLegacyInstructions(prev, instructionValues(prev), dropped, '/ledger.md')
  expect(section(out.fullNotes, '사용자 지시')).toBe('- "keep the API stable"')
})

// Regression caught: the ledger header went back to a UTC ISO time the user cannot read at a glance, or a KST header stopped being recognized as a ledger row.
test('the ledger header carries a KST time and is still read as a ledger row', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact'), ledger('fact')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · \d{4}-\d\d-\d\d \d\d:\d\d KST\]\n\n## where we are/)
  s.rows = [...seen.results[0].messages, ...ROWS.slice(4)]
  await turnEnds($, s, seen)
  expect(seen.results[1].messages.filter((m: any) => m.text.startsWith('[clm ledger')).length).toBe(1)
})

// Regression caught: short pieces scattered across a row ("push…to…origin…main") each matched somewhere, so a quote the row never says held as evidence.
test('a quote of short pieces scattered across a row is refused, a long piece ending in the clip ellipsis holds', OPTS, async ($, on) => {
  const rows = [...ROWS]
  rows[2] = res('tu_a', 'error: failed to push some refs to origin; branch main is behind its remote counterpart' + 'x'.repeat(4000))
  const ops = [
    { op: 'fact', text: 'FACT-SCATTERED', evidence: [{ ref: 'tu_a', quote: 'push…to…origin…main' }] },
    { op: 'fact', text: 'FACT-ONE-PIECE', evidence: [{ ref: 'tu_a', quote: 'failed to push some refs to origin…' }] },
  ]
  const s: State = { rows, replies: [JSON.stringify({ ops })] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const facts = section(seen.results[0].messages[1].text, 'facts')
  expect(facts).not.toContain('FACT-SCATTERED')
  expect(facts).toContain('FACT-ONE-PIECE')
})

// Regression caught: a length cutoff filed short directives (하지마, push, 멈춰) as noise, and since stored lines pass the same filter the next fold deleted them for good.
test('short directives stay in 사용자 지시 and survive the next fold reading them back', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- "ㄱ"\n\n## 핵심 사실·경로\n- f'
  const rows = ['하지마', 'push', '멈춰', 'ㅇㅋ', '넵', 'y'].map(t => M('user', t))
  const want = '- "하지마"\n- "push"\n- "멈춰"'
  const first = carryLegacyInstructions(prev, instructionValues(prev), rows, '/ledger.md')
  expect(section(first.fullNotes, '사용자 지시')).toBe(want)
  const again = carryLegacyInstructions(first.fullNotes, instructionValues(first.fullNotes), [], '/ledger.md')
  expect(section(again.fullNotes, '사용자 지시')).toBe(want)
})

// Regression caught: a dropped issue is hidden from <issues>, so the next fold re-created its title as a fresh open issue and the abandoned work came back.
test('a fold cannot re-create the title of an issue dropped in this session', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"build work","status":"todo"}]')] }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  await $.tool.call({ tool: 'TaskCreate', subject: 'build work', description: 'b' })
  const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
  await runClm($, `drop ${issueAt(tracker(), 0)}`)
  await turnEnds($, s, seen)
  expect(tracker().map(i => [i.title, i.status])).toEqual([['build work', 'dropped']])
})

// Regression caught: a fold re-opened a dropped issue on a tool-row quote, or a failed review landed a user-quoted re-open no reviewer had matched to that issue.
for (const [name, status, cite, review] of [
  ['citing only a tool result', 'done', [{ ref: 'tu_a', quote: 'log: make fails at' }], undefined],
  ['on a failed review, even citing the user', 'doing', [{ ref: 'm4', quote: 'resume the build work please' }], new Error('review down')],
] as const) {
  test(`a fold move out of dropped ${name} leaves the issue dropped`, OPTS, async ($, on) => {
    const rows = [...ROWS]
    rows[4] = M('user', 'resume the build work please')
    const s: State = { rows, replies: [], ...(review ? { reviewReplies: [review] } : {}) }
    const seen = bottoms(on, s)
    panelHandlers(on, seen)
    await $.tool.call({ tool: 'TaskCreate', subject: 'build work', description: 'b' })
    const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
    const build = issueAt(tracker(), 0)
    await runClm($, `drop ${build}`)
    s.replies.push(JSON.stringify({ ops: [{ op: 'status', issue: build, status, evidence: cite }] }))
    await turnEnds($, s, seen)
    expect(tracker().map(i => [i.id, i.status])).toEqual([[build, 'dropped']])
  })
}

// Regression caught: a worker changed the main agent's issue outside its assigned task subtree.
test('a subagent cannot update a main-owned task', OPTS, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  seedTracker(seen, [
    { op: 'create', issue: 's1-root', title: 'main root owned', status: 'doing' },
    { op: 'create', issue: 's1-worker', title: 'worker assignment branch', status: 'todo' },
    { op: 'parent', issue: 's1-worker', parent: 's1-root' },
    { op: 'focus', stack: ['s1-root', 's1-worker'], pending: [], intent: 'handoff' },
  ])
  seen.store['agent-task-roots:s1'] = { worker: 's1-worker' }
  const result = await $.tool.call({ tool: TASK_TOOL, id: 's1-root', status: 'dropped', agentId: 'worker' } satisfies ToolCallInput)
  expect(result.result).toContain('belongs to the main agent')
  expect(snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.id === 's1-root')?.status).toBe('doing')
})

// Regression caught: with no classifier-written focus, clm_task, TaskUpdate and the spawn gate left main no way to own a task or spawn.
test('a main agent with no focus can focus a task through clm_task and then spawn', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [M('user', 'Implement it.')], replies: [] })
  panelHandlers(on, seen)
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'worker' }))
  const tracker = () => snapshot(parseLog(seen.files[TRACKER] ?? ''))
  await $.tool.call({ tool: 'TaskCreate', subject: 'planned step', description: 'p' })
  const planned = issueAt(tracker(), 0)
  await $.tool.call({ tool: 'TaskUpdate', taskId: planned, subject: 'planned step renamed' })
  expect(tracker().find(issue => issue.id === planned)?.title).toBe('planned step renamed')
  const focused = await $.tool.call({ tool: TASK_TOOL, id: planned, status: 'doing' } satisfies ToolCallInput)
  expect(focused.result).toContain(`${planned} doing`)
  const spawned = await $.agent.spawn({ prompt: 'Implement.', description: 'impl' })
  expect('deny' in spawned).toBe(false)
  expect(tracker().find(issue => issue.title === 'impl')?.parent).toBe(planned)
})

// Regression caught: a spawn before the async intent classifier wrote main's focus was denied with no plan to report, or the planned step and the agent's root became two tasks.
test('a spawn without focus asks for a clm_task plan, and after it the same spawn nests under the planned step', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [M('user', 'Implement it.')], replies: [] })
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'worker' }))
  const denied = await $.agent.spawn({ prompt: 'Implement.', description: 'impl' })
  expect('deny' in denied && denied.deny).toContain('select:mcp__clm__clm_task')
  await $.tool.call({ tool: TASK_TOOL, title: 'ship the feature', status: 'doing' } satisfies ToolCallInput)
  await $.tool.call({ tool: TASK_TOOL, title: 'impl', status: 'doing' } satisfies ToolCallInput)
  const spawned = await $.agent.spawn({ prompt: 'Implement.', description: 'impl' })
  expect('deny' in spawned).toBe(false)
  const issues = snapshot(parseLog(seen.files[TRACKER] ?? ''))
  const focus = issues.find(issue => issue.title === 'ship the feature')
  const step = issues.filter(issue => issue.title === 'impl')
  expect(step.map(issue => issue.parent)).toEqual([focus?.id])
  expect(seen.store['agent-task-roots:s1']).toEqual({ worker: step[0]?.id })
})

// Regression caught: two parallel spawns with the same description both claimed the one planned step as their root.
test('parallel spawns of one planned step give it to one agent and a new root to the other', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [M('user', 'Delegate.')], replies: [] })
  seedTracker(seen, [
    { op: 'create', issue: 's1-root', title: 'main work', status: 'doing' },
    { op: 'create', issue: 's1-step', title: 'check', status: 'doing' },
    { op: 'parent', issue: 's1-step', parent: 's1-root' },
    { op: 'focus', stack: ['s1-root'], pending: [], intent: 'handoff' },
  ])
  let n = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: `worker-${++n}` }))
  await Promise.all([$.agent.spawn({ prompt: 'Check.', description: 'check' }), $.agent.spawn({ prompt: 'Check.', description: 'check' })])
  const roots = Object.values(seen.store['agent-task-roots:s1'] as Record<string, string>)
  expect(roots.length).toBe(2)
  expect(new Set(roots).size).toBe(2)
  expect(roots).toContain('s1-step')
})

// Regression caught: a finished subagent left its root task open, or one that ended on an error or refusal closed it as done.
for (const [reason, status] of [['answer', 'done'], ['aborted', 'dropped'], ['error', 'dropped']] as const) {
  test(`a subagent ending with reason ${reason} closes its root as ${status}`, OPTS, async ($, on) => {
    const seen = bottoms(on, { rows: [M('user', 'Delegate.')], replies: [] })
    seedTracker(seen, [
      { op: 'create', issue: 's1-root', title: 'main work', status: 'doing' },
      { op: 'focus', stack: ['s1-root'], pending: [], intent: 'handoff' },
    ])
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'worker' }))
    await $.agent.spawn({ prompt: 'Check.', description: 'worker check' })
    await $.turn.complete(turnInput('worker-end', { agentId: 'worker', reason, isAborted: reason === 'aborted' }))
    expect(snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.title === 'worker check')?.status).toBe(status)
  })
}

test('a main agent with no focus can create and focus a task by title', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [M('user', 'Implement it.')], replies: [] })
  const created = await $.tool.call({ tool: TASK_TOOL, title: 'fresh root', status: 'doing' } satisfies ToolCallInput)
  const root = snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.title === 'fresh root')
  expect(root?.status).toBe('doing')
  expect(created.result).toContain(`${root?.id} doing`)
  const child = await $.tool.call({ tool: TASK_TOOL, title: 'child step', status: 'doing' } satisfies ToolCallInput)
  expect('deny' in child).toBe(false)
  expect(snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.title === 'child step')?.parent).toBe(root?.id)
})

// Regression caught: concurrent agent spawns overwrote task ownership or left an ended agent's root assigned.
test('parallel spawns keep separate child tasks and clear each root when its agent ends', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [M('user', 'Delegate two checks.')], replies: [] })
  panelHandlers(on, seen)
  seedTracker(seen, [
    { op: 'create', issue: 's1-root', title: 'main work', status: 'doing' },
    { op: 'focus', stack: ['s1-root'], pending: [], intent: 'handoff' },
  ])
  on('agent.spawn', (_$, e) => ({ model: 'haiku', agentId: e.description === 'first check' ? 'worker-a' : 'worker-b' }))
  const [first, second] = await Promise.all([
    $.agent.spawn({ prompt: 'Check one.', description: 'first check' }),
    $.agent.spawn({ prompt: 'Check two.', description: 'second check' }),
  ])
  expect('deny' in first || 'deny' in second).toBe(false)
  expect(seen.store['agent-task-roots:s1']).toEqual(expect.objectContaining({ 'worker-a': expect.any(String), 'worker-b': expect.any(String) }))
  const children = snapshot(parseLog(seen.files[TRACKER] ?? '')).filter(issue => issue.parent === 's1-root')
  expect(children.map(issue => issue.title).sort()).toEqual(['first check', 'second check'])
  await $.turn.complete(turnInput('worker-a-done', { agentId: 'worker-a' }))
  expect(seen.store['agent-task-roots:s1']).toEqual(expect.objectContaining({ 'worker-b': expect.any(String) }))
  expect(seen.store['agent-task-roots:s1']).not.toHaveProperty('worker-a')
})

// Regression caught: a worker's own Bash result was unavailable to clm_task, so verified work stayed uncertain.
test('a spawned worker can finish a task with a quote from its Bash result', OPTS, async ($, on) => {
  const s: State = {
    rows: [M('user', 'Delegate the checks.')],
    agentRows: { worker: [M('user', 'Run the focused checks.'), use('tu_bash', 'Bash'), res('tu_bash', 'the focused checks passed successfully')] },
    replies: [],
  }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  seedTracker(seen, [
    { op: 'create', issue: 's1-root', title: 'verification', status: 'doing' },
    { op: 'focus', stack: ['s1-root'], pending: [], intent: 'handoff' },
  ])
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'worker' }))
  const spawned = await $.agent.spawn({ prompt: 'Run the focused checks.', description: 'focused checks' })
  if ('deny' in spawned || !spawned.agentId) throw new Error('worker did not spawn')
  const child = snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.title === 'focused checks')
  if (!child) throw new Error('spawned worker has no assigned child task')
  const workerRequestIsNotAUserQuote = await $.tool.call({
    tool: TASK_TOOL, id: child.id, status: 'dropped',
    evidence: { ref: 'm1', quote: 'Run the focused checks' }, agentId: spawned.agentId,
  } satisfies ToolCallInput)
  expect('deny' in workerRequestIsNotAUserQuote).toBe(true)
  const result = await $.tool.call({
    tool: TASK_TOOL, id: child.id, status: 'done',
    evidence: { ref: 'tu_bash', quote: 'the focused checks passed successfully' }, agentId: spawned.agentId,
  } satisfies ToolCallInput)
  if ('deny' in result) throw new Error(result.deny)
  expect(result.result).toContain(`${child.id} done`)
  expect(snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.id === child.id)?.status).toBe('done')
})

// Regression caught: a task was dropped or reopened without a user quote authorizing that direction change.
test('clm_task refuses drop and re-open without a quote from the user', OPTS, async ($, on) => {
  const rows = [M('user', 'Please drop this child task if I ask, and reopen it when I say so.')]
  const seen = bottoms(on, { rows, replies: [] })
  seedTracker(seen, [
    { op: 'create', issue: 's1-root', title: 'main work', status: 'doing' },
    { op: 'create', issue: 's1-child', title: 'child work', status: 'todo' },
    { op: 'parent', issue: 's1-child', parent: 's1-root' },
    { op: 'focus', stack: ['s1-root'], pending: [], intent: 'handoff' },
  ])
  const droppedWithoutQuote = await $.tool.call({ tool: TASK_TOOL, id: 's1-child', status: 'dropped' } satisfies ToolCallInput)
  expect('deny' in droppedWithoutQuote).toBe(true)
  expect(snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.id === 's1-child')?.status).toBe('todo')
  const authorization = { ref: 'm1', quote: 'drop this child task if I ask, and reopen it when I say so' }
  const dropped = await $.tool.call({ tool: TASK_TOOL, id: 's1-child', status: 'dropped', evidence: authorization } satisfies ToolCallInput)
  if ('deny' in dropped) throw new Error(dropped.deny)
  const reopenedWithoutQuote = await $.tool.call({ tool: TASK_TOOL, id: 's1-child', status: 'doing' } satisfies ToolCallInput)
  expect('deny' in reopenedWithoutQuote).toBe(true)
  const reopened = await $.tool.call({ tool: TASK_TOOL, id: 's1-child', status: 'doing', evidence: authorization } satisfies ToolCallInput)
  if ('deny' in reopened) throw new Error(reopened.deny)
  expect(snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.id === 's1-child')?.status).toBe('doing')
})

// Regression caught: clm_task or a fold op could still write the retired uncertain status.
test('neither clm_task nor a fold op can write uncertain', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [M('user', 'Investigate.')], replies: [] })
  seedTracker(seen, [
    { op: 'create', issue: 's1-task', title: 'verify command', status: 'doing' },
    { op: 'focus', stack: ['s1-task'], pending: [], intent: 'handoff' },
  ])
  const result = await $.tool.call({ tool: TASK_TOOL, id: 's1-task', status: 'uncertain' } as unknown as ToolCallInput)
  expect('deny' in result).toBe(true)
  expect(snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.id === 's1-task')?.status).toBe('doing')
  const parsed = parseOps(JSON.stringify([{ op: 'create', title: 'x', status: 'uncertain' }, { op: 'status', issue: 's1-task', status: 'uncertain' }]), new Set(['s1-task']))
  expect(typeof parsed !== 'string' && parsed.ops.length === 0 && parsed.rejected).toBe(2)
})

// Regression caught: an agent's own done report without a citation was recorded as uncertain, so finished work stayed open.
test('an uncited clm_task done stays done', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [M('user', 'Investigate the task.')], replies: [] })
  seedTracker(seen, [
    { op: 'create', issue: 's1-task', title: 'verify command', status: 'doing' },
    { op: 'focus', stack: ['s1-task'], pending: [], intent: 'handoff' },
  ])
  const result = await $.tool.call({ tool: TASK_TOOL, id: 's1-task', status: 'done' } satisfies ToolCallInput)
  expect(snapshot(parseLog(seen.files[TRACKER] ?? '')).find(issue => issue.id === 's1-task')?.status).toBe('done')
  expect(result.result).toBe('clm_task: s1-task done.')
})

// Regression caught: a task update made before compaction caused the fold's own tracker ops to be discarded.
test('a fold after an earlier clm_task update still applies its own ops', { options: { ...BG_OPTS.options, tailTarget: 2500 } }, async ($, on) => {
  const rows = [...ROWS]
  rows[2] = res('tu_a', 'log: make fails at a.ts:12 ' + 'x'.repeat(24_000))
  const s: State = {
    rows, replies: [], splitReplies: [JSON.stringify({ split: 2, ops: [{ op: 'create', title: 'fold-created issue', status: 'todo' }] })],
  }
  const seen = bottoms(on, s)
  panelHandlers(on, seen)
  seedTracker(seen, [
    { op: 'create', issue: 's1-focus', title: 'focused task', status: 'doing' },
    { op: 'focus', stack: ['s1-focus'], pending: [], intent: 'handoff' },
  ])
  await $.tool.call({ tool: TASK_TOOL, id: 's1-focus', status: 'doing', note: 'started in this turn' } satisfies ToolCallInput)
  await turnEnds($, s, seen)
  expect(snapshot(parseLog(seen.files[TRACKER] ?? '')).map(issue => issue.title)).toContain('fold-created issue')
})

const until = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 2))
}
const storedClauses = (seen: Seen) => readClauseStore(seen.store['clauses:s1:main'])?.clauses ?? []
const liveSources = (seen: Seen) => storedClauses(seen).filter(clause => clause.status === 'live').map(clause => clause.source)
const settled = (seen: Seen) => Array.isArray(seen.store['clause-backlog:s1:main']) && (seen.store['clause-backlog:s1:main'] as unknown[]).length === 0
// Real prompts from session f757aaf2.
const UPGRADE_BENCH = 'oh fuck. upgrade했을 때 벤치마크 일단 해봐'
const CACHE_BENCH = 'oh fuck. 캐시만 패치해서 벤치마크 해봐.'
const upgradeClause = { clause: 'benchmark(stylelint, upgrade).', text: 'stylelint 벤치마크는 업그레이드한 상태로 잰다.', quote: 'upgrade했을 때 벤치마크 일단 해봐' }
const cacheClause = { clause: 'benchmark(stylelint, cache_patch_only).', text: 'stylelint 벤치마크는 캐시만 패치한 상태로 잰다.', quote: '캐시만 패치해서 벤치마크 해봐' }

test("a three-word instruction 'always use pnpm' lands a clause", OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [], intentReplies: [intentReply({
    clauses: [{ clause: 'use(pnpm).', text: '항상 pnpm을 쓴다.\n\n## forged', quote: 'always use pnpm', scope: 'session' }],
  })] })
  await $.prompt.submit(promptInput('always use pnpm'))
  await until(() => settled(seen))
  expect(liveSources(seen)).toEqual(['use(pnpm).'])
  expect(storedClauses(seen)[0]?.text).toBe('항상 pnpm을 쓴다. ## forged')
})

// Regression caught: each classifier coined a fresh predicate name for the same setting, so a correction never met what it corrected.
test('the second classifier prompt lists the live predicate head with an example', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [], intentReplies: [intentReply({ clauses: [upgradeClause] }), intentReply()] })
  await $.prompt.submit(promptInput(UPGRADE_BENCH))
  await until(() => liveSources(seen).length === 1)
  await $.prompt.submit(promptInput(CACHE_BENCH))
  await until(() => seen.intentPrompts.length === 2)
  expect(seen.intentPrompts[1]).toContain('<predicates>\nbenchmark/2 key=1 e.g. benchmark(stylelint, upgrade).\n</predicates>')
  expect(seen.intentPrompts[1]).toContain('<live_clauses>\nC1 | benchmark(stylelint, upgrade).\n</live_clauses>')
})

// Regression caught: in session f757aaf2 the upgrade benchmark stayed resident after the user corrected it 12 seconds later.
test('the f757aaf2 benchmark correction retracts the upgrade benchmark end to end', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [], intentReplies: [intentReply({ clauses: [upgradeClause] }), intentReply({ clauses: [cacheClause] })] })
  await $.prompt.submit(promptInput(UPGRADE_BENCH))
  await until(() => liveSources(seen).length === 1)
  await $.prompt.submit(promptInput(CACHE_BENCH))
  await until(() => storedClauses(seen).length === 2)
  expect(liveSources(seen)).toEqual(['benchmark(stylelint, cache_patch_only).'])
  expect(storedClauses(seen)[0]).toMatchObject({ id: 'C1', status: 'retracted', retraction: { by: 'C2', reason: 'conflict' } })
})

// Regression caught: a narrowing correction ("not all of it, only these") left the broader upgrade scope live beside it.
test('ㄴㄴ 전체 말고 narrows upgrade_target to three packages', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [], intentReplies: [
    intentReply({ clauses: [{ clause: 'upgrade_target(whole_stack).', text: '업그레이드 대상은 전체 스택이다.', quote: '아예 전체 스택 업그레이드도 검토해볼법함' }] }),
    intentReply({
      clauses: [{ clause: "upgrade_target(X) :- member(X, [stylelint, typescript, 'typescript-eslint']).", text: '업그레이드 대상은 stylelint, typescript, typescript-eslint 셋뿐이다.', quote: 'ㄴㄴ 전체 말고 stylelint, typescript, typescript-eslint만 대상.' }],
      retract: [{ id: 'C1', quote: 'ㄴㄴ 전체 말고' }],
    }),
  ] })
  await $.prompt.submit(promptInput('typescript 7 stable 안나옴? 아예 전체 스택 업그레이드도 검토해볼법함'))
  await until(() => liveSources(seen).length === 1)
  await $.prompt.submit(promptInput('ㄴㄴ 전체 말고 stylelint, typescript, typescript-eslint만 대상.'))
  await until(() => storedClauses(seen).length === 2)
  expect(liveSources(seen)).toEqual(["upgrade_target(X) :- member(X, [stylelint, typescript, 'typescript-eslint'])."])
})

// Regression caught: a side request that also set a policy lost one of the two, since focus and instructions shared one field.
test('ㅈㅁ format warn yields one error-policy clause alongside an interleave intent', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [], intentReplies: [intentReply({
    intent: 'interleave', title: 'format 규칙 warn으로 낮추기',
    clauses: [{ clause: 'lint_severity(format, warn).', text: 'format 규칙 위반은 warn으로 둔다.', quote: 'format 에러는 warn으로 내려줘' }],
  })] })
  await $.prompt.submit(promptInput('ㅈㅁ format 에러는 warn으로 내려줘'))
  await until(() => settled(seen) && (seen.files[TRACKER] ?? '').includes('"focus"'))
  expect(liveSources(seen)).toEqual(['lint_severity(format, warn).'])
  const events = parseLog(seen.files[TRACKER] ?? '')
  expect(events.filter(event => event.op === 'focus').map(event => event.op === 'focus' && event.intent)).toEqual(['interleave'])
})

// Regression caught: a question about a tool choice was stored as an order to use that tool.
test('a question stores no clause even when the model proposes one ("tsgo는 왜 적용함? 해도 돼?")', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [], intentReplies: [intentReply({
    intent: 'question', clauses: [{ clause: 'use(tsgo).', text: 'tsgo를 쓴다.', quote: 'tsgo는 왜 적용함? 해도 돼?' }],
  })] })
  await $.prompt.submit(promptInput('tsgo는 왜 적용함? 해도 돼?'))
  await until(() => settled(seen))
  expect(settled(seen)).toBe(true)
  expect(storedClauses(seen)).toEqual([])
})

// Regression caught: a clause the model invented, quoting words the user never typed, became a standing instruction.
test('a clause whose quote is absent from the prompt is dropped', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [], intentReplies: [intentReply({
    clauses: [{ clause: 'forbid(push).', text: 'push는 하지 않는다.', quote: '절대로 push는 하지 말 것' }],
  })] })
  await $.prompt.submit(promptInput(UPGRADE_BENCH))
  await until(() => settled(seen))
  expect(storedClauses(seen)).toEqual([])
  expect(seen.logs.some(line => line.startsWith('clm clause: dropped forbid(push).'))).toBe(true)
})

// Regression caught: a classifier timeout lost the prompt's instruction for good.
test('a classifier timeout leaves the prompt in the backlog and the next job backfills it', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [], intentReplies: [new Error('timeout'), intentReply()],
    backfillReplies: [JSON.stringify({ clauses: [{ prompt: 1, ...upgradeClause }] })],
  })
  await $.prompt.submit(promptInput(UPGRADE_BENCH))
  await until(() => seen.logs.some(line => line.includes('model did not answer (timeout)')))
  expect((seen.store['clause-backlog:s1:main'] as { text: string }[]).map(entry => entry.text)).toEqual([UPGRADE_BENCH])
  await $.prompt.submit(promptInput('stylelint부터 해줘'))
  await until(() => settled(seen))
  expect(seen.backfillPrompts).toHaveLength(1)
  expect(seen.backfillPrompts[0]).toContain(`1. ${UPGRADE_BENCH}`)
  expect(liveSources(seen)).toEqual(['benchmark(stylelint, upgrade).'])
})

test('an unparseable backfill reply keeps the legacy instructions in the backlog', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [], intentReplies: [intentReply()], backfillReplies: ['not json'],
  })
  seen.store['instruction-index:s1:main'] = [{ address: '@11111111', issue: null, text: '앞으로 push는 하지 말 것' }]
  await $.prompt.submit(promptInput('stylelint부터 해줘'))
  await until(() => settled(seen) || (seen.store['clause-backlog:s1:main'] as { attempts?: number }[] | undefined)?.some(entry => entry.attempts === 1) === true)
  expect(seen.store['clause-backlog:s1:main']).toContainEqual(expect.objectContaining({ address: '@11111111', text: '앞으로 push는 하지 말 것', attempts: 1 }))
})

test('a task-scoped instruction given with a handoff shows under the new task', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [], intentReplies: [intentReply({
    intent: 'handoff', title: 'B 작업',
    clauses: [{ clause: 'forbid(commit).', text: '이 작업에서는 커밋하지 않는다.', quote: '이 작업에선 커밋하지 마', scope: 'task' }],
  })] })
  await $.prompt.submit(promptInput('이제 B 하자. 이 작업에선 커밋하지 마'))
  await until(() => settled(seen) && (seen.files[TRACKER] ?? '').includes('"focus"'))
  const events = parseLog(seen.files[TRACKER] ?? '')
  const focus = focusOf(events, 's1').stack.at(-1)
  const store = readClauseStore(seen.store['clauses:s1:main'])
  expect(focus).toBeDefined()
  expect(store?.clauses[0]?.issue).toBe(focus)
  expect(renderClauses(store ?? emptyClauseStore(), issue => issue === null || issue === focus).some(line => line.startsWith('- 이 작업에서는 커밋하지 않는다. (C1 @'))).toBe(true)
})

test('an engine handoff backfill waits for the session classifier chain', async () => {
  const values = new Map<string, unknown>()
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const classifierStarted = new Promise<void>(resolve => { started = resolve })
  let calls = 0
  const io: PromptIntentIo = {
    captureOrigin: async () => ({ session: 's1', repo: 'o/repo', cwd: '/work/repo' }),
    readAll: async () => [], readWorkflow: async () => workflow(),
    changeWorkflow: async change => change(workflow()).result, sessionMessages: async () => [],
    complete: async () => {
      calls++
      if (calls === 1) { started(); await gate; return { isAnswered: true, text: intentReply(), reason: '' } }
      return { isAnswered: true, text: '{"clauses":[]}', reason: '' }
    },
    get: async key => values.get(key), set: async (key, value) => { values.set(key, value) },
    writeEvents: async () => [], serialize: async (_session, run) => run(), syncPanel: async () => undefined, log: () => undefined,
  }
  const classify = recordPromptIntent(io, 'do the work', 1, '@00000001')
  await classifierStarted
  let finished = false
  const handoffBackfill = backfillClausesChained(io, 's1', 's1:main').then(() => { finished = true })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(finished).toBe(false)
  expect(calls).toBe(1)
  release()
  await Promise.all([classify, handoffBackfill])
  expect(calls).toBe(1)
})

// Regression caught: the focus guard that drops an older prompt's focus also dropped the instruction it carried.
test('an older focus result still lands its clauses', async () => {
  const values = new Map<string, unknown>()
  const logs: string[] = []
  const io: PromptIntentIo = {
    captureOrigin: async () => ({ session: 's1', repo: 'o/repo', cwd: '/work/repo' }),
    readAll: async () => [],
    readWorkflow: async () => workflow({ promptSeq: 3, focusAppliedSeq: 3 }),
    changeWorkflow: async change => change(workflow({ promptSeq: 3, focusAppliedSeq: 3 })).result,
    sessionMessages: async () => [],
    complete: async () => ({ isAnswered: true, text: intentReply({ clauses: [cacheClause] }), reason: '' }),
    get: async key => values.get(key), set: async (key, value) => { values.set(key, value) },
    writeEvents: async () => [], serialize: async (_session, run) => run(), syncPanel: async () => undefined,
    log: text => { logs.push(text) },
  }
  await recordPromptIntent(io, CACHE_BENCH, 2, '@f304e1f3')
  expect(logs).toContain('clm intent: dropped older focus result 2 (applied 3)')
  expect(readClauseStore(values.get('clauses:s1:main'))?.clauses.map(clause => [clause.source, clause.address, clause.status]))
    .toEqual([['benchmark(stylelint, cache_patch_only).', '@f304e1f3', 'live']])
})

// Regression caught: a request that only restated a corrected instruction stayed open after the correction.
test('a retracted clause closes the open request it duplicated', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [], intentReplies: [
    intentReply({ clauses: [upgradeClause], raised: [{ text: 'stylelint 업그레이드 상태로 벤치마크해.', quote: 'upgrade했을 때 벤치마크 일단 해봐' }] }),
    intentReply({ clauses: [cacheClause] }),
  ] })
  await $.prompt.submit(promptInput(UPGRADE_BENCH))
  await until(() => Array.isArray(seen.store['requests:s1:main']))
  await $.prompt.submit(promptInput(CACHE_BENCH))
  await until(() => (seen.store['requests:s1:main'] as { status: string }[]).every(request => request.status !== 'open'))
  expect(seen.store['requests:s1:main']).toEqual([expect.objectContaining({ id: 'R1', status: 'skipped' })])
})

// Regression caught: a rewound correction left its replacement live and the clause it had replaced retracted.
test('rewinding the correcting prompt revives the retracted benchmark clause', async () => {
  const values = new Map<string, unknown>()
  const at = '2026-10-27T00:00:00.000Z'
  const incoming = (source: string, quote: string, address: string) => ({ ...parseClause(source), text: source, quote, address, issue: null })
  const first = applyClauses(emptyClauseStore(), [incoming('benchmark(stylelint, upgrade).', upgradeClause.quote, '@979cd619')], 1, at).next
  values.set('clauses:s1:main', applyClauses(first, [incoming('benchmark(stylelint, cache_patch_only).', cacheClause.quote, '@f304e1f3')], 2, at).next)
  values.set('address-index:s1:main', { rows: [{ address: '@979cd619', text: UPGRADE_BENCH, at }, { address: '@f304e1f3', text: CACHE_BENCH, at }], stamps: {} })
  const kept = [M('user', UPGRADE_BENCH), M('assistant', 'ok')]
  values.set(transcriptRowsKey('s1:main'), [...kept, M('user', CACHE_BENCH), M('assistant', 'ok')].map(fingerprint))
  const io = {
    storeGet: async (key: string) => values.get(key), storeSet: async (key: string, value: unknown) => { values.set(key, value) },
    storeDelete: async (key: string) => { values.delete(key) }, readMeta: async () => ({ seq: 0, fails: 0 }),
    readyFoldDropFps: () => undefined, log: () => undefined,
  } as unknown as RewindIo
  await observeTranscript(io, 's1:main', kept)
  const store = readClauseStore(values.get('clauses:s1:main'))
  expect(store?.clauses.map(clause => [clause.source, clause.status])).toEqual([['benchmark(stylelint, upgrade).', 'live']])
})

// Regression caught: a session started before clauses existed lost its standing instructions on upgrade.
test('a session with only a legacy instruction index backfills it once into clauses, keeping addresses', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [], intentReplies: [intentReply(), intentReply()],
    backfillReplies: [JSON.stringify({ clauses: [{ prompt: 1, clause: 'forbid(push).', text: 'push는 하지 않는다.', quote: 'push는 하지 말 것' }] })],
  })
  seen.store['instruction-index:s1:main'] = [
    { address: '@11111111', issue: null, text: '앞으로 push는 하지 말 것' },
    { address: '@22222222', issue: null, text: '(withdrawn) 커밋 메시지는 영어로 쓸 것' },
  ]
  await $.prompt.submit(promptInput('stylelint부터 해줘'))
  await until(() => settled(seen) && liveSources(seen).length === 1)
  await $.prompt.submit(promptInput('typescript도 해줘'))
  await until(() => seen.intentPrompts.length === 2 && settled(seen))
  expect(seen.backfillPrompts).toHaveLength(1)
  expect(seen.backfillPrompts[0]).not.toContain('커밋 메시지')
  expect(storedClauses(seen).map(clause => [clause.source, clause.address])).toEqual([['forbid(push).', '@11111111']])
  expect(readClauseStore(seen.store['clauses:s1:main'])?.migratedLegacy).toBe(true)
})
