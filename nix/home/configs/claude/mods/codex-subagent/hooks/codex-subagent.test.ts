import { test, expect } from 'claude-code/testing'
import { codexName, inheritedContext, pendingPrompt, relaySet, toolResultFor, typeOf, TYPES } from './register'

const row = (role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) =>
  ({ role, text, toolUses: [], ...extra }) as any

// Regression: a SendMessage resume re-sends the original spawn prompt to codex
// instead of the follow-up, or a step after a tool-result row sends nothing.
test('pendingPrompt picks the newest real user message after the last answer', async () => {
  expect(pendingPrompt([row('user', 'print 2+2')])).toBe('print 2+2')
  expect(pendingPrompt([row('user', 'print 2+2'), row('assistant', '4'), row('user', 'now 3+3')])).toBe('now 3+3')
  expect(pendingPrompt([row('user', 'q'), row('assistant', '4')])).toBeUndefined()
  expect(pendingPrompt([row('user', 'ask'), row('user', '', { toolResults: [{ tool_use_id: 't', text: 'x', isError: false }] })])).toBe('ask')
})

// Regression: a Claude agent type gets hijacked into codex, or a codex type
// slips past and is sent to Claude with a dummy model.
test('typeOf claims only this plugin\'s registered types', async () => {
  expect(typeOf('codex-subagent:luna')).toBe('luna')
  expect(typeOf('codex-subagent:sol')).toBe('sol')
  expect(typeOf('codex-subagent:luna-ro')).toBe('luna-ro')
  expect(typeOf('codex-subagent:other')).toBeUndefined()
  expect(typeOf('general-purpose')).toBeUndefined()
})

// Regression: luna-ro accidentally gains workspace-write access, or a pinned
// model or effort silently falls back to the user's default Codex config.
test('TYPES pins each Codex agent model, effort, and sandbox', async () => {
  expect(TYPES).toEqual({
    luna: { model: 'gpt-5.6-luna', effort: 'xhigh', sandbox: 'workspace-write', blurb: 'implementer for well-planned code changes' },
    sol: { model: 'gpt-5.6-sol', effort: 'medium', sandbox: 'workspace-write', blurb: 'fast implementer for mechanical or small changes' },
    'luna-ro': { model: 'gpt-5.6-luna', effort: 'xhigh', sandbox: 'read-only', blurb: 'reviewer / inspector, never edits' },
  })
})

// Regression: a relayed Skill call hands codex only "Launching skill: x" and
// drops the skill body Claude Code appends after the tool_result, or a failed
// tool reads to codex as a success.
test('toolResultFor returns the matching tool_result plus trailing text, reminders stripped', async () => {
  const api = [
    { role: 'user', content: [{ type: 'text', text: 'ctx' }, { type: 'text', text: 'task' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_codex_c1', name: 'Skill', input: { skill: 's' } }] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_codex_c1', content: 'Launching skill: s\n\n<system-reminder>noise</system-reminder>' },
      { type: 'text', text: 'SKILL BODY' },
    ] },
  ] as any
  expect(toolResultFor(api, 'toolu_codex_c1')).toEqual({ contentItems: [{ type: 'inputText', text: 'Launching skill: s' }, { type: 'inputText', text: 'SKILL BODY' }], success: true })
  expect(toolResultFor(api, 'toolu_other')).toBeUndefined()
  api[2].content[0].is_error = true
  expect(toolResultFor(api, 'toolu_codex_c1')!.success).toBe(false)
})

// Regression: the spawn prompt is sent twice (once inside the inherited
// context, once as the turn), or the instructions file never reaches codex.
test('inheritedContext keeps every first-message block except the trailing prompt', async () => {
  const api = [{ role: 'user', content: [{ type: 'text', text: 'instructions' }, { type: 'text', text: 'skills' }, { type: 'text', text: 'the task' }] }] as any
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
  expect(set.tools[1]!.inputSchema).toEqual({ type: 'object', additionalProperties: true })
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
