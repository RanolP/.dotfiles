import { test, expect, mock, type MockClock } from 'claude-code/testing'
import type { ApiMessage, SessionMessage, TimerCall } from 'claude-code'
import { bridgeReady, codexName, inheritedContext, keepalive, pendingPrompt, relaySet, settlePending, toolResultFor, typeForModel, typeOf, TYPES, unreachable, workspaceRoot } from './register'

const row = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
  ({ ...extra, role, text, toolUses: extra.toolUses ?? [] })

// $.clock.after over the mock clock: the test's `$` has no clock noun to hand the module.
const timerOn = (clock: MockClock): TimerCall => (ms, fn) => {
  let live = true
  void clock.sleep(ms).then(() => { if (live) fn() })
  return { cancel: () => { live = false } }
}

// Regression: a SendMessage resume re-sends the original spawn prompt to codex
// instead of the follow-up, or a step after a tool-result row sends nothing.
test('pendingPrompt picks the newest real user message after the last answer', async () => {
  expect(pendingPrompt([row('user', 'print 2+2')])).toBe('print 2+2')
  expect(pendingPrompt([row('user', 'print 2+2'), row('assistant', '4'), row('user', 'now 3+3')])).toBe('now 3+3')
  expect(pendingPrompt([row('user', 'q'), row('assistant', '4')])).toBeUndefined()
  expect(pendingPrompt([row('user', 'ask'), row('user', '', { toolResults: [{ tool_use_id: 't', text: 'x', isError: false }] })])).toBe('ask')
  expect(pendingPrompt([row('assistant', 'old report'), row('user', 'new task', { toolResults: [{ tool_use_id: 'handback', text: 'old report', isError: true }] })])).toBe('new task')
})

// Regression: a Claude agent type gets hijacked into codex, or a codex type
// slips past and is sent to Claude with a dummy model.
test('typeOf claims only this plugin\'s registered types', async () => {
  expect(typeOf('codex-subagent:luna')).toBe('luna')
  expect(typeOf('codex-subagent:sol')).toBe('sol')
  expect(typeOf('codex-subagent:other')).toBeUndefined()
  expect(typeOf('general-purpose')).toBeUndefined()
})

test('a missing Codex recovery never falls through to Claude', async ($, on) => {
  mock.clock(on)
  const agentId = 'a-recover-miss'
  let nextCalls = 0
  const api: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'implement it' }] }]
  const rows: SessionMessage[] = [row('user', 'implement it')]

  mock.env(on, { HOME: '/home/test' })
  on('session.id', async () => ({ value: 'test-session' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('ui.log', async () => ({ value: undefined }))
  on('tool.list', async () => ({ value: [] }))
  on('session.messages', async (_$, e) => ({ value: e.as === 'api' ? api : rows }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"ready":true}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const route = new URL(e.url).pathname
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (route === '/recover') return json({ found: false })
    if (route === '/step') return json({ pending: true })
    if (route === '/wait') return json({ threadId: 'thread-rebuilt', resumed: false, bridgePid: 1, codexPid: 2, final: { text: 'done', status: 'completed', errors: [] } })
    return { value: { status: 404, ok: false, headers: {}, text: `no route ${route}` } }
  })
  on('turn.step', async function* (_$, e) {
    nextCalls++
    yield { kind: 'text' as const, index: 0, text: 'Claude fallback' }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'Claude fallback', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  const stream = $.turn.step({ turnId: 'turn-recover', index: 0, model: 'gpt-5.6-luna', messageCount: api.length, agentId })
  let r = await stream.next()
  while (!r.done) r = await stream.next()
  expect(nextCalls).toBe(0)
  expect(r.value.answer).toBe('')
})

test('a failed Codex recovery ends the turn and asks the coordinator to resend', async ($, on) => {
  mock.clock(on)
  const agentId = 'a-recover-throw'
  let nextCalls = 0
  const api: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'resume it' }] }]
  const rows: SessionMessage[] = [row('user', 'resume it')]

  mock.env(on, { HOME: '/home/test' })
  on('session.id', async () => ({ value: 'test-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('tool.list', async () => ({ value: [] }))
  on('session.messages', async (_$, e) => ({ value: e.as === 'api' ? api : rows }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"ready":true}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const route = new URL(e.url).pathname
    if (route === '/recover') return { deny: 'bridge unavailable' }
    return { value: { status: 404, ok: false, headers: {}, text: `no route ${route}` } }
  })
  on('turn.step', async function* (_$, e) {
    nextCalls++
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'Claude fallback', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  const stream = $.turn.step({ turnId: 'turn-recover-throw', index: 0, model: 'gpt-5.6-luna', messageCount: api.length, agentId })
  let r = await stream.next()
  while (!r.done) r = await stream.next()
  expect(nextCalls).toBe(0)
  expect(r.value.answer).toBe('[codex-subagent error] cannot reach the bridge to recover a-recover-throw: codex-subagent: $.http.fetch: bridge unavailable; send the message again')
})

test('a spawned codex agent is remembered by the bridge so a restart can recover it', async ($, on) => {
  const remembered: Record<string, unknown>[] = []
  mock.env(on, { HOME: '/home/test' })
  on('session.id', async () => ({ value: 'test-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('agent.spawn', async () => ({ agentId: 'spawned-codex', model: 'gpt-5.6-luna' }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"ready":true}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const route = new URL(e.url).pathname
    if (route === '/remember') {
      remembered.push(JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>)
      return { value: { status: 200, ok: true, headers: {}, text: '{}' } }
    }
    return { value: { status: 404, ok: false, headers: {}, text: `no route ${route}` } }
  })

  await $.agent.spawn({ subagentType: 'codex-subagent:luna', cwd: '/repo' } as any)
  expect(remembered).toEqual([{ key: 'spawned-codex', type: 'luna', cwd: '/repo' }])
})

// Regression: sol and luna resolve to each other's model id, or a step for a
// codex model is not recognized as one and goes to Claude.
test('typeForModel maps each Codex model back to its own type', async () => {
  expect(TYPES.luna.model).toBe('gpt-5.6-luna')
  expect(TYPES.sol.model).toBe('gpt-5.6-sol')
  expect(typeForModel('gpt-5.6-luna')).toBe('luna')
  expect(typeForModel('gpt-5.6-sol')).toBe('sol')
  expect(typeForModel('claude-opus-5-5')).toBeUndefined()
})

// Regression: a relayed Skill call hands codex only "Launching skill: x" and
// drops the skill body Claude Code appends after the tool_result, or a failed
// tool reads to codex as a success.
test('toolResultFor returns the matching tool_result plus trailing text, reminders stripped', async () => {
  const api: ApiMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'task' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_codex_c1', name: 'Skill', input: { skill: 's' } }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_codex_c1', content: 'Launching skill: s\n\n<system-reminder>noise</system-reminder>' },
      { type: 'text', text: 'SKILL BODY' },
    ] },
  ]
  expect(toolResultFor(api, 'toolu_codex_c1')).toEqual({ contentItems: [{ type: 'inputText', text: 'Launching skill: s' }, { type: 'inputText', text: 'SKILL BODY' }], success: true })
  expect(toolResultFor(api, 'toolu_other')).toBeUndefined()
  const failedApi: ApiMessage[] = [
    ...api.slice(0, 2),
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_codex_c1', content: 'Launching skill: s', is_error: true }, { type: 'text', text: 'SKILL BODY' }] },
  ]
  expect(toolResultFor(failedApi, 'toolu_codex_c1')?.success).toBe(false)
})

// Regression: the spawn prompt is sent twice (once inside the inherited
// context, once as the turn), or the instructions file never reaches codex.
test('inheritedContext keeps every first-message block except the trailing prompt', async () => {
  const api: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'instructions' }, { type: 'text', text: 'skills' }, { type: 'text', text: 'the task' }] }]
  expect(inheritedContext(api)).toBe('instructions\n\nskills')
})

// Regression: codex gets a Read/Bash relay that duplicates its own tools, or
// an MCP tool is offered with no schema codex accepts.
test('relaySet offers MCP tools and the built-ins codex lacks, nothing else', async () => {
  const set = relaySet([
    { name: 'Read', description: 'r', mcp: false },
    { name: 'Agent', description: 'a', mcp: false },
    { name: 'Skill', description: 's', mcp: false },
    { name: 'mcp__x__get_thing', description: '', mcp: true },
  ])
  expect(set.tools.map(t => t.name)).toEqual(['Skill', 'claude_mcp__x__get_thing'])
  expect(set.tools[1]?.inputSchema).toEqual({ type: 'object', additionalProperties: true })
  expect(set.claudeName.get('claude_mcp__x__get_thing')).toBe('mcp__x__get_thing')
})

test('relaySet excludes mutating MCP tools but keeps read-only tools', async () => {
  const keep = ['get_settings', 'list_updates', 'weave_get_model_run_output', 'slack_read_channel', 'search_issues', 'calendar_get_availability', 'calendar_preview_event', 'calendar_list_events', 'whoami']
  const drop = ['slack_send_message', 'slack_send_message_draft', 'slack_schedule_message', 'start_break', 'unban_account', 'use_figma', 'withdraw_account', 'calendar_save_people_group', 'calendar_google_retry', 'batch', 'check_in']
  const set = relaySet([
    ...keep.map(name => ({ name: `mcp__x__${name}`, description: '', mcp: true })),
    ...drop.map(name => ({ name: `mcp__x__${name}`, description: '', mcp: true })),
  ])
  expect(set.tools.map(t => t.name)).toEqual(keep.map(name => codexName(`mcp__x__${name}`)))
  expect(Object.values(set.mcp)).toEqual(keep.map(name => `mcp__x__${name}`))
})

// Regression: codex rejects thread/start ("dynamic tool name is reserved:
// mcp__…", or a name past the Responses API's 64 characters), so every codex
// agent in a session with MCP servers fails before its first turn.
test('codexName avoids the reserved mcp__ prefix and stays within 64 valid characters', async () => {
  expect(codexName('Skill')).toBe('Skill')
  expect(codexName('mcp__stub__secret')).toBe('claude_mcp__stub__secret')
  const long = codexName(`mcp__claude_ai_Atlassian__${'x'.repeat(60)}`)
  expect(long.length).toBeLessThanOrEqual(64)
  expect(/^[A-Za-z0-9_-]+$/.test(long)).toBe(true)
  expect(long).not.toBe(codexName(`mcp__claude_ai_Atlassian__${'x'.repeat(61)}`))
})

// Regression: an MCP tool whose codex name is hashed (past 64 characters)
// does not map back to its Claude name, so the bridge never finds its
// harvested schema and codex gets an open object for it.
test('relaySet maps every MCP codex name, hashed ones included, back to the Claude name', async () => {
  const long = `mcp__claude_ai_Atlassian__get_${'x'.repeat(60)}`
  const set = relaySet([{ name: long, description: '', mcp: true }, { name: 'mcp__stub__get_secret', description: '', mcp: true }, { name: 'Skill', description: '', mcp: false }])
  expect(set.mcp).toEqual({ [codexName(long)]: long, claude_mcp__stub__get_secret: 'mcp__stub__get_secret' })
})

// Regression: a long codex turn trips $.http.fetch's 30 s deadline and the
// mod reads it as a dead bridge, starting a second bridge that runs the same
// prompt again while the first one's codex is still working.
test('unreachable restarts the bridge only when nothing listens on the socket', async () => {
  const sock = 'http://codex-bridge/step over /x.sock'
  expect(unreachable(new Error(`$.http.fetch(${sock}) failed: FailedToOpenSocket: Was there a typo in the url or port?`))).toBe(true)
  expect(unreachable(new Error(`$.http.fetch(${sock}) failed: ECONNREFUSED: connect ECONNREFUSED /x.sock`))).toBe(true)
  expect(unreachable(new Error(`$.http.fetch(${sock}) aborted: no complete answer within 30000ms`))).toBe(false)
})

// Regression: $.http.fetch aborts a long /wait after 30 s, so a queued bridge
// event must be recovered by another /wait instead of ending the agent turn.
test('settle retries a transient /wait failure without re-running /step', async () => {
  const waits = { count: 0 }
  const retries: unknown[] = []
  const pendingReply = { pending: true } satisfies Parameters<typeof settlePending>[0]
  const reply = await settlePending(
    pendingReply,
    async () => {
      waits.count++
      if (waits.count === 1) throw new Error('aborted: no complete answer within 30000ms')
      return { threadId: 'thread', resumed: false, bridgePid: 0, codexPid: 0, final: { text: 'done', errors: [] } }
    },
    error => retries.push(error),
    async () => {},
  )
  expect(waits.count).toBe(2)
  expect(retries).toHaveLength(1)
  expect('final' in reply ? reply.final.text : undefined).toBe('done')
})

// Regression: a bridge that exits before its ready line used to leave every Codex step awaiting forever.
test('bridgeReady rejects an early bridge exit with stderr', async (_$, on) => {
  async function* exited() {
    yield { stream: 'stderr', text: 'codex: command not found\n' }
  }
  await expect(bridgeReady(exited(), timerOn(mock.clock(on)))).rejects.toThrow('codex bridge exited before ready; exit code=unknown; stderr tail: codex: command not found')
})

// Regression: a bridge that stays alive but never prints its ready line leaves
// every Codex step awaiting forever instead of failing with the startup timeout.
test('bridgeReady rejects a silent bridge once the startup timeout passes', async (_$, on) => {
  const clock = mock.clock(on)
  async function* silent() {
    yield { stream: 'stderr', text: 'still booting\n' }
    await new Promise<never>(() => {})
  }
  let outcome = 'pending'
  void bridgeReady(silent(), timerOn(clock)).then(() => { outcome = 'ready' }, (err: unknown) => { outcome = String(err) })
  await clock.advance(14_999)
  expect(outcome).toBe('pending')
  await clock.advance(1)
  expect(outcome).toBe('Error: codex bridge startup timed out after 15000ms; exit code=unknown; stderr tail: still booting\n')
})

// Regression: repeated 30-second /wait aborts used to recurse without a bound and never return an error.
test('settle gives up after bounded aborted /wait retries', async () => {
  let waits = 0
  let healthChecks = 0
  await expect(settlePending(
    { pending: true },
    async () => { waits++; throw new Error('aborted: no complete answer within 30000ms') },
    () => {},
    async () => { healthChecks++ },
  )).rejects.toThrow('bridge /wait gave up after 3 retries')
  expect(waits).toBe(4)
  expect(healthChecks).toBe(3)
})

// Regression: a bridge error must end the turn instead of making /wait spin
// forever after the bridge has already dequeued the failure.
test('settle rejects a bridge error after one /wait call', async () => {
  const error = new Error('bridge: thread t already has a running turn')
  let waits = 0
  let caught: unknown
  try {
    await settlePending({ pending: true }, async () => {
      waits++
      throw error
    }, () => {})
  } catch (err) {
    caught = err
  }
  expect(waits).toBe(1)
  expect(caught).toBe(error)
})

// Regression: a user-rejected dynamic tool call used to reach Codex with an
// empty result, leaving the held server request blocked until the watchdog.
test('user-rejected tool results name the rejection and fail the held call', async () => {
  const api: ApiMessage[] = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_codex_c1', is_error: true, toolDenialKind: 'user-rejected' }] }]
  expect(toolResultFor(api, 'toolu_codex_c1')).toEqual({
    contentItems: [{ type: 'inputText', text: 'user rejected this tool call' }],
    success: false,
  })
})

// Regression: codex thinks past the harness's 600 s stall watchdog without a
// tool call, the turn yields nothing meanwhile, and the agent is killed as
// "Agent stalled: no progress"; or the keepalive outlives an interrupt.
test('keepalive yields empty thinking chunks while a slow step is pending, then its reply', async (_$, on) => {
  const clock = mock.clock(on)
  const after = timerOn(clock)
  const slow = clock.sleep(95_000).then(() => 'reply')
  let beats = 0
  const chunks: unknown[] = []
  const drain = async (gen: AsyncGenerator<unknown, string>) => {
    let r = await gen.next()
    while (!r.done) { chunks.push(r.value); r = await gen.next() }
    return r.value
  }
  const done = drain(keepalive(slow, new AbortController().signal, () => { beats++ }, after))
  await clock.advance(95_000)
  expect(await done).toBe('reply')
  expect(chunks).toEqual([0, 1, 2].map(() => ({ kind: 'thinking', index: 0, text: '' })))
  expect(beats).toBe(3)

  const stopped = new AbortController()
  const hung = drain(keepalive(new Promise<string>(() => {}), stopped.signal, () => {}, after))
  await clock.advance(31_000)
  stopped.abort()
  expect(await hung.then(() => 'completed', err => String(err))).toBe('Error: interrupted')
})

// Regression: the main session's Bash `cd` into a subdirectory moved
// $.session.cwd(), and every later codex worker could write only there.
test('a worker spawned after the session cd\'d into a subdirectory still gets the repo root as its writable root', async () => {
  const asked: (string | undefined)[] = []
  const git: Parameters<typeof workspaceRoot>[0] = async (argv, init) => {
    asked.push(init?.cwd)
    const inRepo = argv.join(' ') === 'git rev-parse --show-toplevel' && init?.cwd?.startsWith('/repo')
    return { exitCode: inRepo ? 0 : 128, stdout: inRepo ? '/repo\n' : '', stderr: inRepo ? '' : 'fatal: not a git repository', isStdoutTruncated: false, isStderrTruncated: false }
  }
  expect(await workspaceRoot(git, '/repo/nix/home/configs/claude/mods/clm/hooks')).toBe('/repo')
  expect(asked).toEqual(['/repo/nix/home/configs/claude/mods/clm/hooks'])
  expect(await workspaceRoot(git, '/scratch/outside')).toBe('/scratch/outside')
  expect(await workspaceRoot(async () => { throw new Error('git: not found') }, '/scratch/outside')).toBe('/scratch/outside')
})

test('an unmapped Codex tool call is answered with a failed toolResult', async ($, on) => {
  mock.clock(on)
  const agentId = 'a-unmapped-tool'
  const api: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'implement it' }] }]
  const rows: SessionMessage[] = [row('user', 'implement it')]
  const steps: Record<string, unknown>[] = []
  const replies: unknown[] = [
    { threadId: 'thread-unmapped', resumed: false, bridgePid: 1, codexPid: 2, toolCall: { callId: 'unknown-call', tool: 'claude_mcp__x__secret', arguments: {} } },
    { threadId: 'thread-unmapped', resumed: false, bridgePid: 1, codexPid: 2, final: { text: 'done', status: 'completed', errors: [] } },
  ]

  mock.env(on, { HOME: '/home/test' })
  on('session.id', async () => ({ value: 'test-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('tool.list', async () => ({ value: [] }))
  on('session.messages', async (_$, e) => ({ value: e.as === 'api' ? api : rows }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"ready":true}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const route = new URL(e.url).pathname
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (route === '/recover') return json({ found: true, type: 'luna', cwd: '/repo' })
    if (route === '/step') { steps.push(JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>); return json({ pending: true }) }
    if (route === '/wait') return json(replies[steps.length - 1])
    return { value: { status: 404, ok: false, headers: {}, text: `no route ${route}` } }
  })

  const stream = $.turn.step({ turnId: 'turn-unmapped', index: 0, model: 'gpt-5.6-luna', messageCount: api.length, agentId })
  let r = await stream.next()
  while (!r.done) r = await stream.next()
  expect(steps).toHaveLength(2)
  expect(steps[1]?.toolResult).toEqual({ callId: 'unknown-call', contentItems: [{ type: 'inputText', text: 'tool not relayed: claude_mcp__x__secret' }], success: false })
  expect(r.value.toolUses.map(t => t.name)).toEqual(['SubagentHandback'])
})

// Incident: a codex worker ended its run with SubagentHandback, the harness
// ran no further step, and the mod kept that handback pending in memory. The
// next SendMessage (a 13-item review, ~4 KB) was answered "(report delivered
// through SubagentHandback)" in 0.6 s without ever reaching codex.
test('a resumed worker receives a long multi-line message and runs a new turn instead of returning the previous completion', async ($, on) => {
  mock.clock(on)
  const agentId = 'a8a97bfadb6fe4d4b'
  const review = Array.from({ length: 13 }, (_, i) =>
    `${i + 1}. \`hooks/fold.ts:${10 * i + 3}\` drops the "pending" row when \`ledger.flush()\` races;\n   fix: guard with \`if (!row) return\` and add a test.\n  ${'context '.repeat(20).trim()}`).join('\n')
  expect(review.length).toBeGreaterThan(3000)

  let api: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'implement it' }] }]
  let rows: SessionMessage[] = [row('user', 'implement it')]
  const steps: Record<string, unknown>[] = []
  const finals = ['first report', 'review applied']

  mock.env(on, { HOME: '/home/test' })
  on('session.id', async () => ({ value: 'test-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('tool.list', async () => ({ value: [] }))
  on('session.messages', async (_$, e) => ({ value: e.as === 'api' ? api : rows }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"ready":true}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const route = new URL(e.url).pathname
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (route === '/recover') return json({ found: true, type: 'luna', cwd: '/repo' })
    if (route === '/step') { steps.push(body); return json({ pending: true }) }
    if (route === '/wait') return json({ threadId: 'thread-1', resumed: false, bridgePid: 1, codexPid: 2, final: { text: finals[steps.length - 1], status: 'completed', errors: [] } })
    return { value: { status: 404, ok: false, headers: {}, text: `no route ${route}` } }
  })

  const runStep = async (turnId: string) => {
    const stream = $.turn.step({ turnId, index: 0, model: 'gpt-5.6-luna', messageCount: api.length, agentId })
    let r = await stream.next()
    while (!r.done) r = await stream.next()
    return r.value
  }

  const first = await runStep('turn-1')
  expect(first.toolUses.map(t => t.name)).toEqual(['SubagentHandback'])
  const handbackId = `toolu_codex_handback_thread-1_turn-1_0`
  // The harness runs the handback tool, ends the run with no further step, then the SendMessage arrives.
  api = [
    ...api,
    { role: 'assistant', content: [{ type: 'tool_use', id: handbackId, name: 'SubagentHandback', input: { message: 'first report' } }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: handbackId, content: '{"success":true,"message":"Report delivered to your caller."}' },
      { type: 'text', text: `The coordinator sent a message while you were working:\n${review}` },
    ] },
  ]
  rows = [
    ...rows,
    row('assistant', '', { toolUses: [{ tool_use_id: handbackId, tool: 'SubagentHandback', input: { message: 'first report' } }] }),
    row('user', '', { toolResults: [{ tool_use_id: handbackId, text: 'Report delivered to your caller.', isError: false }] }),
    row('user', `The coordinator sent a message while you were working:\n${review}`),
  ]

  const resumed = await runStep('turn-2')
  expect(resumed.answer).toBe('')
  expect(steps).toHaveLength(2)
  expect(steps[1]?.prompt).toBe(`The coordinator sent a message while you were working:\n${review}`)
  expect(steps[1]?.toolResult).toBeUndefined()
  expect(resumed.toolUses.map(t => t.name)).toEqual(['SubagentHandback'])
  expect(String((resumed.toolUses[0]?.input as { message?: unknown }).message)).toStartWith('review applied')
})

// Incident class: a SendMessage that reached a worker while one of its relayed
// tools ran rides in the same user message as that tool's result; the step
// handed codex the text as part of the tool output, never as the coordinator's.
test('a coordinator message that arrives with a relayed tool result still reaches codex as the next prompt', async ($, on) => {
  mock.clock(on)
  const agentId = 'a-coordinated'
  const note = 'Stop editing `fold.ts`;\nreview item 4 is withdrawn.\nKeep "ledger.ts" as is.'
  const delivered = `The coordinator sent a message while you were working:\n${note}`
  let api: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'implement it' }] }]
  const rows: SessionMessage[] = [row('user', 'implement it')]
  const steps: Record<string, unknown>[] = []
  const replies: unknown[] = [
    { threadId: 'thread-2', resumed: false, bridgePid: 1, codexPid: 2, toolCall: { callId: 'c1', tool: 'WebFetch', arguments: { url: 'https://example.com', prompt: 'p' } } },
    { threadId: 'thread-2', resumed: false, bridgePid: 1, codexPid: 2, final: { text: 'done', status: 'completed', errors: [] } },
  ]

  mock.env(on, { HOME: '/home/test' })
  on('session.id', async () => ({ value: 'test-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('tool.list', async () => ({ value: [{ name: 'WebFetch', description: 'fetch', mcp: false }] }))
  on('session.messages', async (_$, e) => ({ value: e.as === 'api' ? api : rows }))
  on('session.receive', async (_$, e) => ({ text: e.text }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"ready":true}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const route = new URL(e.url).pathname
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (route === '/recover') return json({ found: true, type: 'luna', cwd: '/repo' })
    if (route === '/step') { steps.push(JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>); return json({ pending: true }) }
    if (route === '/wait') return json(replies[steps.length - 1])
    return { value: { status: 404, ok: false, headers: {}, text: `no route ${route}` } }
  })
  const runStep = async (turnId: string, index: number) => {
    const stream = $.turn.step({ turnId, index, model: 'gpt-5.6-luna', messageCount: api.length, agentId })
    let r = await stream.next()
    while (!r.done) r = await stream.next()
    return r.value
  }

  const first = await runStep('turn-1', 0)
  expect(first.toolUses.map(t => t.name)).toEqual(['WebFetch'])
  await $.session.receive({ origin: { kind: 'coordinator' }, text: note, agentId })
  api = [
    ...api,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_codex_c1', name: 'WebFetch', input: { url: 'https://example.com', prompt: 'p' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_codex_c1', content: 'page text' }, { type: 'text', text: delivered }] },
  ]
  await runStep('turn-1', 1)

  expect(steps).toHaveLength(2)
  expect(steps[1]?.toolResult).toEqual({ callId: 'c1', contentItems: [{ type: 'inputText', text: 'page text' }], success: true })
  expect(steps[1]?.prompt).toBe(delivered)
})

// Incident class: a bridge outlives a module reload, so the reloaded mod kept
// stepping through a bridge whose run() predates `prompt` beside `toolResult`,
// and the coordinator text that step carried was discarded without an error.
test('a bridge started from older bridge code is replaced before the next step instead of silently dropping the new prompt field', async ($, on) => {
  mock.clock(on)
  const agentId = 'a-stale-bridge'
  const api: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'implement it' }] }]
  const rows: SessionMessage[] = [row('user', 'implement it')]
  const spawns: string[][] = []
  const log: string[] = []

  mock.env(on, { HOME: '/home/test' })
  on('session.id', async () => ({ value: 'test-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('tool.list', async () => ({ value: [] }))
  on('agent.list', async () => ({ value: [] }))
  on('fs.read', async () => ({ value: 'export const bridge = "current"\n' }))
  on('session.messages', async (_$, e) => ({ value: e.as === 'api' ? api : rows }))
  on('process.spawn', async function* (_$, e) {
    spawns.push([...e.argv])
    log.push('spawn')
    yield { stream: 'stdout' as const, text: '{"ready":true}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const route = new URL(e.url).pathname
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    log.push(route)
    // The first bridge runs code from before /health reported a fingerprint.
    if (route === '/health') return json(spawns.length === 1 ? { bridgePid: 1, threads: [] } : { bridgePid: 3, threads: [], busy: [], fingerprint: spawns.at(-1)?.[3] })
    if (route === '/recover') return json({ found: true, type: 'luna', cwd: '/repo' })
    if (route === '/step') return json({ pending: true })
    if (route === '/wait') return json({ threadId: 'thread-3', resumed: false, bridgePid: 3, codexPid: 4, final: { text: 'done', status: 'completed', errors: [] } })
    return { value: { status: 404, ok: false, headers: {}, text: `no route ${route}` } }
  })

  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'gpt-5.6-luna', messageCount: api.length, agentId })
  let r = await stream.next()
  while (!r.done) r = await stream.next()

  expect(spawns).toHaveLength(2)
  expect(spawns[1]?.[3]).toMatch(/^[0-9a-f]{8,}$/)
  expect(log.indexOf('/step')).toBeGreaterThan(log.lastIndexOf('spawn'))
})

// Incident class: the /wait retry probed /health with a POST the bridge does
// not route, so every dropped long-poll ended the step although the bridge was fine.
test('a transient /wait failure recovers when the bridge is healthy instead of failing the step', async ($, on) => {
  mock.clock(on)
  const agentId = 'a-wait-retry'
  const api: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'implement it' }] }]
  const rows: SessionMessage[] = [row('user', 'implement it')]
  let waits = 0

  mock.env(on, { HOME: '/home/test' })
  on('session.id', async () => ({ value: 'test-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('tool.list', async () => ({ value: [] }))
  on('session.messages', async (_$, e) => ({ value: e.as === 'api' ? api : rows }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"ready":true}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const route = new URL(e.url).pathname
    const method = e.init?.method ?? 'GET'
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    // The bridge routes /health for GET only, as codex-bridge.mjs does.
    if (route === '/health' && method === 'GET') return json({ bridgePid: 1, threads: [], busy: [], fingerprint: 'unused' })
    if (route === '/recover') return json({ found: true, type: 'luna', cwd: '/repo' })
    if (route === '/step') return json({ pending: true })
    if (route === '/wait') {
      if (++waits === 1) return { deny: 'fetch failed: aborted: no complete answer' }
      return json({ threadId: 'thread-4', resumed: false, bridgePid: 1, codexPid: 2, final: { text: 'recovered answer', status: 'completed', errors: [] } })
    }
    return { value: { status: 404, ok: false, headers: {}, text: `no route ${method} ${route}` } }
  })

  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'gpt-5.6-luna', messageCount: api.length, agentId })
  let r = await stream.next()
  while (!r.done) r = await stream.next()

  expect(waits).toBe(2)
  expect(r.value.answer).toBe('')
  expect((r.value.toolUses[0]?.input as { message?: string } | undefined)?.message).toStartWith('recovered answer')
})

// Incident: a background codex worker's first step raced agent.spawn's async
// tail, /recover answered found:false, and the step fell through to a Claude
// request for gpt-5.6-luna, which died with 404 model_not_found.
test('a step for a codex model is never sent to Claude, even for an agent spawn has not registered', async ($, on) => {
  mock.clock(on)
  const agentId = 'a-unregistered'
  const api: ApiMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'implement it' }] }]
  const rows: SessionMessage[] = [row('user', 'implement it')]
  const steps: Record<string, unknown>[] = []
  let claudeSteps = 0

  mock.env(on, { HOME: '/home/test' })
  on('session.id', async () => ({ value: 'test-session' }))
  on('session.cwd', async () => ({ value: '/repo/sub' }))
  on('ui.log', async () => ({ value: undefined }))
  on('tool.list', async () => ({ value: [] }))
  on('session.messages', async (_$, e) => ({ value: e.as === 'api' ? api : rows }))
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '/repo\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"ready":true}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_$, e) => {
    const route = new URL(e.url).pathname
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    const json = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (route === '/recover') return json({ found: false })
    if (route === '/step') { steps.push(body); return json({ threadId: 'thread-5', resumed: false, bridgePid: 1, codexPid: 2, final: { text: 'done', status: 'completed', errors: [] } }) }
    return { value: { status: 404, ok: false, headers: {}, text: `no route ${route}` } }
  })
  // Beneath the plugin stands the engine: reaching this is the Claude request that 404s.
  on('turn.step', async function* (_$, e) {
    claudeSteps++
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'claude', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })

  const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'gpt-5.6-sol', messageCount: api.length, agentId })
  let r = await stream.next()
  while (!r.done) r = await stream.next()

  expect(claudeSteps).toBe(0)
  expect(steps).toHaveLength(1)
  expect(steps[0]).toMatchObject({ key: agentId, agentType: 'sol', model: 'gpt-5.6-sol', cwd: '/repo' })
})
