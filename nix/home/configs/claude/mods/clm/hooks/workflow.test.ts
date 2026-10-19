import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, RenderPropsOf, SessionCompactInput, SessionCompactResult, SessionMessage, SessionStartInput, ToolCallInput, TurnCompleteInput } from 'claude-code'

import { boardHtml } from './board'
import { chooseContinuation, clmStatus, isHeld, resetUserWorkflow, removeQueueSnapshotTargets, restoreFailedContinuation, sessionIssues, submitWithRecovery, trackIssue, recallRows, residentLedgerText, TASK_TOOL } from './register'
import type { Held, Meta } from './register'
import { INTENT_SYSTEM } from './intent'
import type { ClmWorkflow } from '../types'

import { ageDecayPlan, fallbackLedger, instructionValues, LEDGER_COMPACT_SYSTEM, MERGE_SYSTEM, parseMerge, preserveInstructions, REVIEW_SYSTEM, SPLIT_MERGE_SYSTEM } from './ledger'
import { CONFIRM_ITEMS, CONFIRM_PREFIX } from './evidence'
import { focusOf, parseLog, parseOps, snapshot, toEvents, type Issue, type Payload } from './tracker'
import { fingerprint } from './fold'
import { M, intentReply, use, res, BIG, MID, ROWS, CITE, ledger, splitAnswer, compressedTopics, TURN, OPTS, LEDGER_FILE, LOG_FILE, storedLedger, ids, est, shape, handled, compactInput, promptInput, turnInput, commandInput, compactedMessages, workflow, heldIn, isMetaValue, metaIn, bottoms, turnEnds, waitForPending, BG_OPTS, logEvents, panelHandlers, sixDone, storedOverhead, NOTE_REPLY, ESCAPE_ROWS, WITHHELD_FILE, section, PR_ROWS, TRACKER, seedTracker, issueAt, runClm, LATER_BAND_PROPS, waitForLog } from './clm-test-support'
import type { State, On, Seen, PanelReply } from './clm-test-support'
// Regression caught: chat deferrals disappeared when session hooks rebound instead of remaining visible in the numbered band.
test('chat deferrals stay in session state and the band numbers them', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], intentReplies: [intentReply({ later: ['Check the release notes', 'Verify the changelog'] })],
  })
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  await $.prompt.submit(promptInput('Check the release notes and verify the changelog later'))
  await waitForLog(seen, 'clm: queued later item 2')
  expect(seen.logs).toContain('clm: queued later item 1')
  expect(seen.logs).toContain('clm: queued later item 2')
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'clm', surface: 'terminal', component: 'AbovePrompt', props: LATER_BAND_PROPS })
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toContain('1. Check the release notes')
  expect(drawn).toContain('2. Verify the changelog')
  expect(drawn.indexOf('Check the release notes')).toBeLessThan(drawn.indexOf('Verify the changelog'))
})

// Regression caught: queue continuations lost asUser or repeated after duplicate completion events.
test('the continuation arbiter submits the later queue once per turn', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], intentReplies: [intentReply({ later: ['Run the focused verification'] })],
  })
  await $.prompt.submit(promptInput('Run the focused verification later'))
  await waitForLog(seen, 'clm: queued later item 1')
  seen.submissions.length = 0
  const end = (turnId: string, extra: Partial<TurnCompleteInput> = {}) => $.turn.complete(turnInput(turnId, extra))
  await end('t1', { isAborted: true })
  await end('t-agent', { agentId: 'agent-1' })
  expect(seen.submissions).toEqual([])
  await end('t1')
  await end('t1')
  expect(seen.submissions).toEqual([{ text: 'Run the focused verification', asUser: true }])
  await end('t2')
  await end('t2')
  expect(seen.submissions).toEqual([{ text: 'Run the focused verification', asUser: true }])
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

// Regression caught: a pop during Haiku classification changed the queue positions and removed a different later item.
test('a pop between snapshot and apply still drops the intended later item', async () => {
  const snapshot = [{ text: 'first' }, { text: 'target' }, { text: 'last' }]
  const live = [{ text: 'first' }, { text: 'last' }, { text: 'new arrival' }]
  expect(removeQueueSnapshotTargets(live, snapshot, [2])).toEqual({
    remaining: [{ text: 'first' }, { text: 'last' }, { text: 'new arrival' }], dropped: [],
  })
  const withTargetStillPresent = [{ text: 'first' }, { text: 'target' }, { text: 'last' }, { text: 'new arrival' }]
  expect(removeQueueSnapshotTargets(withTargetStillPresent, snapshot, [2])).toEqual({
    remaining: [{ text: 'first' }, { text: 'last' }, { text: 'new arrival' }], dropped: [{ item: 'target', number: 2 }],
  })
})

// Regression caught: a slow earlier classifier overwrote the focus chosen by a newer prompt.
test('B landing before A leaves focus on B and drops A', OPTS, async ($, on) => {
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
  const path = '/home/t/.claude-work/tracker/events/s1.jsonl'
  for (let i = 0; i < 100; i++) {
    const events = parseLog(seen.files[path] ?? '')
    const focused = snapshot(events).find(issue => issue.id === focusOf(events, 's1').stack.at(-1))
    if (focused?.title === 'B task') break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  releaseA()
  await waitForLog(seen, 'dropped older focus result 1')
  const events = parseLog(seen.files[path] ?? '')
  const focused = snapshot(events).find(issue => issue.id === focusOf(events, 's1').stack.at(-1))
  expect(focused?.title).toBe('B task')
  expect(seen.logs).toContain('clm intent: dropped older focus result 1 (applied 2)')
})

// Regression caught: a valid deferred request vanished when the independent focus label was malformed.
test('valid later survives invalid focus output', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [], intentReplies: [intentReply({ intent: 'not-an-intent', later: ['Please verify the release notes'] })],
  })
  await $.prompt.submit(promptInput('Please verify the release notes later'))
  await waitForLog(seen, 'clm: queued later item 1')
  const band = await $.ui.mount({ plugin: 'clm', surface: 'terminal', component: 'AbovePrompt', props: LATER_BAND_PROPS })
  expect(JSON.stringify(await band.drawn())).toContain('1. Please verify the release notes')
  expect(seen.logs.some(line => line.includes('unknown intent not-an-intent'))).toBe(true)
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

// Regression caught: one assistant response could answer several queued requests, but only the last one was closed.
// Regression caught: the user's plain answer to the confirm question landed nothing until a later fold happened to read it, and a reply that did not answer it could still change it.
for (const [name, assistant, reply, want] of [
  ['a bare yes after the agent relayed the question confirms all', 'Did you push the tag and tag the release?', '네', { a: 'done', b: 'done', q: 'done' }],
  ['naming one item confirms only it', 'Fixed the lint.', 's1-a 끝났어', { a: 'done', b: 'todo', q: 'question', left: '"tag the release"' }],
  ['naming one item with a no denies it and keeps it open', 'Fixed the lint.', '"push the tag" 아직', { a: 'todo', b: 'todo', q: 'question', left: '"tag the release"' }],
  ['an unrelated reply changes nothing', 'Did you push the tag?', 'run the tests again', { a: 'todo', b: 'todo', q: 'question' }],
  ['a bare yes the agent did not ask for changes nothing', 'Shall I run the tests?', '네', { a: 'todo', b: 'todo', q: 'question' }],
] as const) {
  test(`confirm answer: ${name}`, OPTS, async ($, on) => {
    const seen = bottoms(on, { rows: [M('user', 'Ship it.'), M('assistant', assistant)], replies: [] })
    const title = `${CONFIRM_PREFIX}s1-a "push the tag" · "tag the release"`
    seedTracker(seen, [
      { op: 'create', issue: 's1-a', title: 'push the tag', status: 'todo' },
      { op: 'create', issue: 's1-b', title: 'tag the release', status: 'todo' },
      { op: 'create', issue: 's1-q', title, status: 'question', note: `${CONFIRM_ITEMS}[{"id":"s1-a","title":"push the tag"},{"title":"tag the release"}]` },
    ])
    await $.prompt.submit(promptInput(reply))
    for (let i = 0; i < 200 && !seen.intentPrompts.length; i++) await new Promise(resolve => setTimeout(resolve, 2))
    const issues = snapshot(parseLog(seen.files[TRACKER] ?? ''))
    const status = (id: string) => issues.find(issue => issue.id === id)?.status
    expect({ a: status('s1-a'), b: status('s1-b'), q: status('s1-q') }).toEqual({ a: want.a, b: want.b, q: want.q })
    const q = issues.find(issue => issue.id === 's1-q')
    expect(q?.title).toBe('left' in want ? `${CONFIRM_PREFIX}${want.left}` : title)
    if (want.a === 'done') expect(issues.find(issue => issue.id === 's1-a')?.notes.at(-1)).toContain(reply)
  })
}

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

// Regression caught: a chat deferral was silently dropped instead of being queued alongside the active focus label.
test('a mixed chat queues exactly its deferred part and still applies its focus label', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [], intentReplies: [intentReply({ intent: 'handoff', title: 'A 고쳐', later: ['B 고쳐'] })],
  })
  await $.prompt.submit(promptInput('A 고쳐, B는 나중에'))
  await waitForLog(seen, 'clm: queued later item 1')
  const events = parseLog(seen.files['/home/t/.claude-work/tracker/events/s1.jsonl'] ?? '')
  const focus = focusOf(events, 's1')
  const focusedIssue = snapshot(events).find(issue => issue.id === focus.stack.at(-1))
  expect(focusedIssue?.title).toBe('A 고쳐')
  expect(focusedIssue?.status).toBe('doing')
})

// Regression caught: a later item re-queued itself forever when the arbiter replayed it as a plugin continuation.
test('a replayed later continuation is not classified', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [], intentReplies: [intentReply({ intent: 'pending', title: 'Run the focused verification', later: ['Run the focused verification'] })],
  })
  await $.prompt.submit(promptInput('Run the focused verification later'))
  await waitForLog(seen, 'clm: queued later item 1')
  await $.turn.complete({ ...TURN, turnId: 'later-replay-turn' })
  expect(seen.submissions).toContainEqual({ text: 'Run the focused verification', asUser: true })
  expect(seen.intentPrompts).toHaveLength(1)
})

// Regression caught: replaying a linked later item did not return its tracker issue to the doing focus, or reconciliation repeated writes.
test('a linked later replay reconciles once to its issue and then stays unchanged', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], intentReplies: [intentReply({ intent: 'pending', title: 'Do deferred task', later: ['Do deferred task'] })],
  })
  await $.prompt.submit(promptInput('Do deferred task later'))
  await waitForLog(seen, 'clm: queued later item 1')
  await $.turn.complete(turnInput('defer-turn'))
  expect(seen.submissions).toContainEqual({ text: 'Do deferred task', asUser: true })
  await $.turn.complete(turnInput('replay-finished'))
  const path = '/home/t/.claude-work/tracker/events/s1.jsonl'
  const afterReconcile = seen.files[path] ?? ''
  const events = parseLog(afterReconcile)
  const focus = focusOf(events, 's1')
  const top = snapshot(events).find(issue => issue.id === focus.stack.at(-1))
  expect(top?.title).toBe('Do deferred task')
  expect(top?.status).toBe('doing')
  await $.turn.complete(turnInput('next-turn'))
  expect(seen.files[path]).toBe(afterReconcile)
})

// Regression caught: assistant-only wording entered the queue, or a queue-wide drop ran without a queue reference in the user's prompt.
test('assistant wording is rejected and an unsupported all drop is ignored', OPTS, async ($, on) => {
  const s: State = {
    rows: [], replies: [], intentReplies: [
      intentReply({ later: ['Keep this queued item'] }),
      intentReply({ later: ['secret phrase from the assistant'], laterDrop: 'all' }),
    ],
  }
  const seen = bottoms(on, s)
  await $.prompt.submit(promptInput('Keep this queued item later'))
  await waitForLog(seen, 'clm: queued later item 1')
  s.rows = [M('assistant', 'The secret phrase from the assistant was: secret phrase from the assistant')]
  await $.prompt.submit(promptInput('Continue the current task'))
  await waitForLog(seen, 'ignored laterDrop=all without a queue reference')
  expect(seen.logs).toContain('clm: later item dropped (not supported by prompt): secret phrase from the assistant')
  const band = await $.ui.mount({ plugin: 'clm', surface: 'terminal', component: 'AbovePrompt', props: LATER_BAND_PROPS })
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toContain('1. Keep this queued item')
  expect(drawn).not.toContain('secret phrase')
})

// Regression caught: chat removal deleted the wrong queued item or changed the order of the remaining requests.
test('a chat drop removes exactly the named item and keeps the rest in order', OPTS, async ($, on) => {
  const seen = bottoms(on, {
    rows: ROWS, replies: [], intentReplies: [
      intentReply({ later: ['first request', 'second request', 'third request'] }),
      intentReply({ laterDrop: [2] }),
    ],
  })
  await $.prompt.submit(promptInput('Do these later: first request, second request, third request'))
  await waitForLog(seen, 'clm: queued later item 3')
  await $.prompt.submit(promptInput('later 2번 빼'))
  await waitForLog(seen, 'clm: dropped later item 2: second request')
  const band = await $.ui.mount({ plugin: 'clm', surface: 'terminal', component: 'AbovePrompt', props: LATER_BAND_PROPS })
  const drawn = JSON.stringify(await band.drawn())
  expect(drawn).toContain('1. first request')
  expect(drawn).toContain('2. third request')
  expect(drawn.indexOf('first request')).toBeLessThan(drawn.indexOf('third request'))
  expect(drawn).not.toContain('second request')
  expect(seen.logs).toContain('clm: dropped later item 2: second request')
})

// Regression caught: a failed continuation submission consumed the queue head and blocked retrying the same turn.
test('a rejected continuation submission restores its queue head and clears its turn claim', async () => {
  let currentWorkflow: ClmWorkflow = workflow({ lastSubmittedTurn: 'retry-turn' })
  const logs: string[] = []
  const submitted = await submitWithRecovery(
    async () => { throw new Error('settings hook refused prompt') },
    async () => { currentWorkflow = restoreFailedContinuation(currentWorkflow, 'retry-turn', { text: 'next item', asUser: true, source: 'later' }) },
    message => logs.push(message),
  )
  expect(submitted).toBe(false)
  expect(currentWorkflow.later).toEqual([{ text: 'next item' }])
  expect(currentWorkflow.lastSubmittedTurn).toBeNull()
  expect(logs).toContain('clm: continuation submit failed (Error: settings hook refused prompt)')
})

// Regression caught: clm skipped a queued resume after consuming the higher-priority later queue.
test('the continuation selector consumes a resume request after the later queue', async () => {
  const start = workflow({ later: [{ text: 'verify the release' }], resumeRequest: { text: 'time-budget resume' } })
  const queue = chooseContinuation(start, 't1')
  expect(queue.continuation).toEqual({ text: 'verify the release', asUser: true, source: 'later' })
  const resumed = chooseContinuation(queue.workflow, 't2')
  expect(resumed.continuation?.text).toBe('time-budget resume')
  expect(chooseContinuation(resumed.workflow, 't3').continuation).toBeUndefined()
})

// Regression caught: task notifications cleared queued away-resume requests, or a human return left one stale.
test('only human-origin prompts clear queued resumes', async () => {
  const pending: ClmWorkflow = {
    later: [], resumeRequest: { text: 'stale away reminder' },
    lastSubmittedTurn: 'claimed-turn', activeTurnId: null,
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
  const out = preserveInstructions(prev, instructionValues(prev), dropped, '/ledger.md')
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
  rows[2] = res('tu_a', 'error: failed to push some refs to origin; branch main is behind its remote counterpart')
  const ops = [
    { op: 'fact', text: 'FACT-SCATTERED', evidence: [{ ref: 'tu_a', quote: 'push…to…origin…main' }] },
    { op: 'fact', text: 'FACT-ONE-PIECE', evidence: [{ ref: 'tu_a', quote: 'failed to push some refs to origin…' }] },
  ]
  const s: State = { rows, replies: [`## 목표\n- -\n\n<ops>${JSON.stringify(ops)}</ops>`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const facts = section(storedLedger(seen), '핵심 사실·경로')
  expect(facts).not.toContain('FACT-SCATTERED')
  expect(facts).toContain('FACT-ONE-PIECE')
})

// Regression caught: a length cutoff filed short directives (하지마, push, 멈춰) as noise, and since stored lines pass the same filter the next fold deleted them for good.
test('short directives stay in 사용자 지시 and survive the next fold reading them back', async () => {
  const prev = '## 목표\n- g\n\n## 사용자 지시\n- "ㄱ"\n\n## 핵심 사실·경로\n- f'
  const rows = ['하지마', 'push', '멈춰', 'ㅇㅋ', '넵', 'y'].map(t => M('user', t))
  const want = '- "하지마"\n- "push"\n- "멈춰"'
  const first = preserveInstructions(prev, instructionValues(prev), rows, '/ledger.md')
  expect(section(first.fullNotes, '사용자 지시')).toBe(want)
  const again = preserveInstructions(first.fullNotes, instructionValues(first.fullNotes), [], '/ledger.md')
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
    s.replies.push(`## 목표\n- -\n\n<ops>${JSON.stringify([{ op: 'status', issue: build, status, evidence: cite }])}</ops>`)
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
test('a fold after an earlier clm_task update still applies its own ops', BG_OPTS, async ($, on) => {
  const s: State = {
    rows: ROWS, replies: [], splitReplies: [JSON.stringify({ split: 2, notes: '## 목표\n- build', ops: [{ op: 'create', title: 'fold-created issue', status: 'todo' }], topics: [{ topic: 'build', summary: 'build summary' }] })],
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
