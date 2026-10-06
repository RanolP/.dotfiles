import { test, expect } from 'claude-code/testing'
import type { ApiMessage, SessionMessage } from 'claude-code'
import { abortable, codexName, inheritedContext, pendingPrompt, relaySet, settlePending, toolResultFor, typeOf, TYPES, unreachable } from './register'

const row = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
  ({ ...extra, role, text, toolUses: extra.toolUses ?? [] })

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

// Regression: a pinned model, effort, sandbox, or display blurb silently
// falls back to the user's default Codex config.
test('TYPES pins each Codex agent model, effort, sandbox, and display', async () => {
  expect(TYPES).toEqual({
    luna: { model: 'gpt-5.6-luna', effort: 'xhigh', sandbox: 'workspace-write', blurb: 'implementer for well-planned code changes' },
    sol: { model: 'gpt-5.6-sol', effort: 'medium', sandbox: 'workspace-write', blurb: 'fast implementer for mechanical or small changes' },
  })
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
    { name: 'mcp__x__y', description: '', mcp: true },
  ])
  expect(set.tools.map(t => t.name)).toEqual(['Skill', 'claude_mcp__x__y'])
  expect(set.tools[1]?.inputSchema).toEqual({ type: 'object', additionalProperties: true })
  expect(set.claudeName.get('claude_mcp__x__y')).toBe('mcp__x__y')
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
  const long = `mcp__claude_ai_Atlassian__${'x'.repeat(60)}`
  const set = relaySet([{ name: long, description: '', mcp: true }, { name: 'mcp__stub__secret', description: '', mcp: true }, { name: 'Skill', description: '', mcp: false }])
  expect(set.mcp).toEqual({ [codexName(long)]: long, claude_mcp__stub__secret: 'mcp__stub__secret' })
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
  )
  expect(waits.count).toBe(2)
  expect(retries).toHaveLength(1)
  expect('final' in reply ? reply.final.text : undefined).toBe('done')
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

// Regression: an interrupted handback must finish the turn immediately
// instead of waiting for the engine watchdog after the rejected tool result.
test('an already-aborted handback wait ends immediately', async () => {
  const pending = new Promise<string>(() => {})
  const message = await abortable(pending, AbortSignal.abort()).then(
    () => 'completed',
    error => error instanceof Error ? error.message : String(error),
  )
  expect(message).toBe('interrupted')
})
