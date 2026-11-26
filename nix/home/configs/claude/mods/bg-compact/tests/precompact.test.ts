import { expect, test } from 'claude-code/testing'
import type { SessionCompactInput, SessionCompactResult, SessionMessage } from 'claude-code'
import { boundaryOf, PreCompactor, SUMMARY_HEAD, summaryMessage, summaryPrompt, type PreCompaction, type PreIo } from '../hooks/precompact'

const S = { ratio: 0.6, extendRatio: 0.3 }
const LIMIT = 100000
const user = (text: string, results: string[] = []): SessionMessage =>
  ({ role: 'user', text, toolUses: [], ...(results.length ? { toolResults: results.map(id => ({ tool_use_id: id, text: `out ${id}`, isError: false })) } : {}) })
const assistant = (text: string, uses: string[] = []): SessionMessage =>
  ({ role: 'assistant', text, toolUses: uses.map(id => ({ tool_use_id: id, tool: 'Bash', input: { command: `echo ${id}` } })) })
// As session.compact hands them over: each row stamped with the engine's handle.
const handled = (rows: readonly SessionMessage[]) => rows.map((m, i) => ({ ...m, handle: `h${i}` }))

// The transcript at the turn end that forked: the last request ended on the tool_result of t2, and the reply came back after it.
const AT_FORK = [user('fix the build'), assistant('looking', ['t1']), user('', ['t1']), assistant('editing', ['t2']), user('', ['t2']), assistant('done with step one')]
const AFTER = [user('now the tests'), assistant('running', ['t3']), user('', ['t3']), assistant('all green')]

function fake(over: Partial<PreIo> & { tokens?: number; rows?: readonly SessionMessage[]; stored?: PreCompaction } = {}) {
  const files: Record<string, PreCompaction | undefined> = over.stored ? { s1: over.stored } : {}
  const forks: string[] = []
  const logs: string[] = []
  const io: PreIo = {
    sessionId: async () => 's1',
    usage: async () => ({ tokens: over.tokens, limit: LIMIT }),
    rows: async () => over.rows ?? AT_FORK,
    fork: async prompt => { forks.push(prompt); return { text: 'SUMMARY' } },
    read: async s => files[s],
    readAll: async () => Object.values(files).filter((p): p is PreCompaction => !!p),
    write: async (s, p) => { files[s] = p },
    now: async () => 1000,
    log: async t => { logs.push(t) },
    ...over,
  }
  return { io, files, forks, logs }
}

const stored = (): PreCompaction => ({ summary: 'SUMMARY', ...boundaryOf(AT_FORK)!, createdAt: 1, tokens: 60000 })
const nextRecorder = () => {
  const seen: SessionCompactInput[] = []
  const ENGINE: SessionCompactResult = { messages: [user('ENGINE SUMMARY')] }
  return { seen, ENGINE, next: async (e: SessionCompactInput) => { seen.push(e); return ENGINE } }
}

// Regression: the compaction rebuilds, reorders or drops a post-boundary row (or calls the engine's summarizer anyway),
// so the conversation after compaction is not the summary followed by exactly what came after the fork.
test('compaction answers summary + every post-boundary message unchanged, with no engine call', async () => {
  const { io, files } = fake({ stored: stored() })
  const { seen, next } = nextRecorder()
  const rows = handled([...AT_FORK, ...AFTER])
  const r = await new PreCompactor(S).compact(io, { trigger: 'auto', messages: rows }, next)
  expect(seen.length).toBe(0)
  if (!('messages' in r) || !r.messages) throw new Error('no messages')
  expect(r.messages[0]).toEqual(summaryMessage('SUMMARY'))
  const tail = rows.slice(AT_FORK.length - 1)
  expect(r.messages.length).toBe(1 + tail.length)
  tail.forEach((m, i) => { expect(r.messages[i + 1]).toBe(m); expect(JSON.stringify(r.messages[i + 1])).toBe(JSON.stringify(m)) })
  expect(files.s1).toBe(undefined)
})

// Regression: a stored summary whose boundary rows are gone (an engine compaction, a rewind) is applied anyway,
// and the conversation loses everything between the old boundary and now.
test('a boundary missing from the transcript falls through to the engine', async () => {
  const { io } = fake({ stored: stored() })
  const { seen, ENGINE, next } = nextRecorder()
  const input: SessionCompactInput = { trigger: 'manual', messages: handled([user('a different conversation'), ...AFTER]) }
  const r = await new PreCompactor(S).compact(io, input, next)
  expect(seen).toEqual([input])
  expect(r).toBe(ENGINE)
})

// Regression: the seam lands between a tool_use and its tool_result, so the compacted conversation opens on an
// unpaired tool_result and the API rejects every later request.
test('a tool_result after the boundary whose tool_use was summarized falls through', async () => {
  const { io } = fake({ stored: { ...stored(), boundary: boundaryOf(AT_FORK.slice(0, 3))!.boundary } })
  const { seen, next } = nextRecorder()
  const rows = handled([...AT_FORK.slice(0, 3), assistant('x', ['t9']), ...AT_FORK.slice(3)])
  // Boundary after user(t1); with assistant(t2) gone, user(t2)'s tool_result in the tail has no tool_use there.
  const broken = rows.filter(m => !(m.role === 'assistant' && m.toolUses.some(u => u.tool_use_id === 't2')))
  await new PreCompactor(S).compact(io, { trigger: 'auto', messages: broken }, next)
  expect(seen.length).toBe(1)
})

// Regression: a fork that errored or answered nothing still writes a record, and the next compaction installs an
// empty or stale summary in place of the conversation.
test('a fork error leaves no stored pre-compaction', async () => {
  for (const fork of [async () => ({ why: 'api-error' }), async () => { throw new Error('boom') }]) {
    const { io, files } = fake({ tokens: 70000, fork })
    const pre = new PreCompactor(S)
    const { started } = await pre.turnEnd(io)
    expect(started === undefined).toBe(false)
    await started
    expect(files.s1).toBe(undefined)
    expect(pre.isRunning('s1')).toBe(false)
  }
})

// Regression: every turn end forks a summary, paying a model call per turn long before compaction is near.
test('no pre-compaction below the ratio, one at it, and an extend only past the extend ratio', async () => {
  const below = fake({ tokens: 59999 })
  expect((await new PreCompactor(S).turnEnd(below.io)).started).toBe(undefined)
  expect(below.forks.length).toBe(0)

  const at = fake({ tokens: 60000 })
  await (await new PreCompactor(S).turnEnd(at.io)).started
  expect(at.forks.length).toBe(1)
  expect(at.files.s1).toEqual({ summary: 'SUMMARY', ...boundaryOf(AT_FORK)!, createdAt: 1000, tokens: 60000 })

  const notYet = fake({ tokens: 90000, stored: stored() })
  expect((await new PreCompactor(S).turnEnd(notYet.io)).started).toBe(undefined)
  const extend = fake({ tokens: 90001, stored: stored() })
  await (await new PreCompactor(S).turnEnd(extend.io)).started
  expect(extend.forks[0]).toContain('<earlier-summary>\nSUMMARY\n</earlier-summary>')
})

// Regression: a summary that drops the next action and how each remaining item is verified, so the resumed agent
// re-derives its plan, and one that trusts its own stale paraphrase over the wayseeker section re-attached after it.
test('the summary prompt asks for a task brief and the head ranks newer context above the summary', () => {
  const prompt = summaryPrompt()
  const headings = ['1. Task:', '2. Current work:', '3. Plan:', '4. Done when:', '5. Artifacts:', '6. Decisions', '7. Open questions:'].map(h => prompt.indexOf(h))
  expect(headings.every(i => i >= 0)).toBe(true)
  expect([...headings].sort((a, b) => a - b)).toEqual(headings)
  expect(prompt).toContain('quoted in their own words')
  expect(prompt).toContain('@id')
  expect(SUMMARY_HEAD).toContain('wayseeker section')
})

// Through the registered hooks, the test's own session.compact hook standing for the engine beneath the plugin.
function engine(on: any, files: Record<string, string>, fsThrows = false, onWrite = () => {}) {
  on('session.id', () => ({ value: 's1' }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data/bg-compact' } }))
  on('fs.exists', (_$: any, e: any) => { if (fsThrows) throw new Error('disk gone'); return { value: e.path in files } })
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] }))
  on('fs.write', (_$: any, e: any) => { files[e.path] = e.text; onWrite(); return { value: undefined } })
  on('fs.list', () => ({ value: Object.keys(files).map(p => ({ name: p.split('/').pop(), kind: 'file', size: 1, mtimeMs: 0, isLink: false })) }))
  on('ui.log', () => ({ value: undefined }))
  const calls: SessionCompactInput[] = []
  on('session.compact', (_$: any, e: SessionCompactInput) => { calls.push(e); return { messages: [user('ENGINE SUMMARY')] } })
  return calls
}

// Regression: the session.compact hook is not wired to the stored record (wrong data path, wrong session key), so every
// compaction still pays the engine's summarizer.
test('the registered session.compact hook answers from the record in the data dir', async ($, on) => {
  const files = { '/data/bg-compact/precompact-s1.json': JSON.stringify(stored()) }
  const calls = engine(on, files)
  const r = await $.session.compact({ trigger: 'auto', messages: handled([...AT_FORK, ...AFTER]) } as any)
  expect(calls.length).toBe(0)
  if (!('messages' in r) || !r.messages) throw new Error('no messages')
  expect(r.messages[0]!.text).toBe(summaryMessage('SUMMARY').text)
  expect(r.messages.length).toBe(1 + AFTER.length + 1)
  expect(files['/data/bg-compact/precompact-s1.json']).toBe('null')
})

// Regression: an exception inside the bg-compact hook (here the data dir unreadable) fails the compaction instead of
// leaving it to the engine.
test('an exception in the session.compact hook falls through to the engine', async ($, on) => {
  const calls = engine(on, {}, true)
  const r = await $.session.compact({ trigger: 'auto', messages: handled(AT_FORK) } as any)
  expect(calls.length).toBe(1)
  if (!('messages' in r) || !r.messages) throw new Error('no messages')
  expect(r.messages[0]!.text).toBe('ENGINE SUMMARY')
})

// Regression: the turn.complete hook never reaches the fork (main thread not detected, usage misread), or forks for a
// subagent's turn, so no pre-compaction is ever stored, or one is stored from the wrong transcript.
test('a main-thread turn end past the ratio forks once and stores the record; a subagent turn end does not', async ($, on) => {
  const files: Record<string, string> = {}
  const forks: string[] = []
  let wrote!: () => void
  const written = new Promise<void>(r => { wrote = r })
  engine(on, files, false, () => wrote())
  on('session.usage', (_$: any, e: any) => ({ value: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 61000, ...(e?.breakdown ? { breakdown: { autoCompactThreshold: LIMIT } } : {}) } } }))
  on('session.messages', () => ({ value: AT_FORK }))
  on('model.fork', (_$: any, e: any) => { forks.push(e.prompt); return { value: { isAnswered: true, text: 'SUMMARY', usage: {} } } })
  on('clock.now', () => ({ value: 5 }))
  on('turn.complete', () => ({ text: '' }))
  const TURN = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
  await $.turn.complete({ ...TURN, agentId: 'a1' } as any)
  await $.turn.complete(TURN as any)
  await Promise.race([written, new Promise((_, no) => setTimeout(() => no(new Error('no record written')), 2000))])
  expect(forks.length).toBe(1)
  expect(JSON.parse(files['/data/bg-compact/precompact-s1.json']!)).toEqual({ summary: 'SUMMARY', ...boundaryOf(AT_FORK)!, createdAt: 5, tokens: 61000 })
})

// Regression: /compact with instructions returned early and left the record, so the next turn end saw a stored record
// and waited for 'extend' instead of forking a fresh 'first' at 60%.
test('after /compact with instructions the record is cleared and the next turn end forks a first summary', async () => {
  const { io, files, forks } = fake({ stored: stored(), tokens: 65000 })
  const { seen, next } = nextRecorder()
  const c = new PreCompactor(S)
  await c.compact(io, { trigger: 'manual', instructions: 'focus on tests', messages: handled([...AT_FORK, ...AFTER]) }, next)
  expect(seen.length).toBe(1)
  expect(files.s1).toBe(undefined)
  const { started } = await c.turnEnd(io)
  await started
  expect(forks.length).toBe(1)
  expect(forks[0].includes('earlier-summary')).toBe(false)
})

// Regression: a record whose tokens exceed the current tokens (the transcript shrank) blocked pre-compaction until 90%.
test('a record above the current token count is ignored', async () => {
  const { io, forks } = fake({ stored: { ...stored(), tokens: 90000 }, tokens: 65000 })
  const { started } = await new PreCompactor(S).turnEnd(io)
  await started
  expect(forks.length).toBe(1)
  expect(forks[0].includes('earlier-summary')).toBe(false)
})

// Regression: the engine summary drops opening harness reminders, including the worker handback rule.
test('a subagent compaction keeps the opening system-reminder rows that the engine summary dropped', async ($, on) => {
  const files: Record<string, string> = {}
  const calls = engine(on, files)
  const reminders = [user('<system-reminder>Use SubagentHandback to deliver the result.</system-reminder>'), user('<system-reminder>Keep the assignment.</system-reminder>')]
  const rows = handled([...reminders, user('fix the build'), assistant('working'), user('<system-reminder>Later reminder</system-reminder>')])
  const result = await $.session.compact({ trigger: 'auto', agentId: 'worker', messages: rows })
  expect(calls.length).toBe(1)
  expect(calls[0]?.agentId).toBe('worker')
  if (!('messages' in result) || !result.messages) throw new Error('no messages')
  expect(result.messages).toEqual([user('ENGINE SUMMARY'), ...reminders])
  expect(files).toEqual({})
})
