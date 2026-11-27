import { test, expect, type Engine } from 'claude-code/testing'

import { readWayseekerLedger, wayseekerKey } from './render'
import { SAY_TOOL_ID, type SayResult } from './say'
import { appendAll } from './store'

const STATE = '/home/t/.claude-work/plans/wayseeker-s1.json'
const DECLS = ['decl use(role, tool) key(role) "{role}에 {tool}을 쓴다"', 'serving := "서빙"']
type Row = { role: 'user' | 'assistant'; text: string; toolUses: Use[] }
type Use = { tool_use_id: string; tool: string; input: Record<string, unknown> }

function world(on: any, seed?: string[]) {
  const files: Record<string, string> = {}
  const rows: Row[] = []
  // seed: lines the user's extraction already landed.
  if (seed) files[STATE] = JSON.stringify({ [wayseekerKey('s1:main')]: appendAll(seed) })
  on('env.get', () => ({ value: '/home/t' }))
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: rows.map(row => ({ ...row })) }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] }))
  on('fs.write', (_$: any, e: any) => { files[e.path] = e.text; return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('tool.call', () => ({ result: 'ok' }))
  const ledger = () => readWayseekerLedger(JSON.parse(files[STATE] ?? '{}')[wayseekerKey('s1:main')])
  return { rows, ledger }
}
// A builtin's typed input has no agentId, so a subagent's call goes through the MCP name, whose arguments are loose.
const say = async ($: Engine, lines: string[], agentId?: string): Promise<SayResult> => {
  const r = await $.tool.call({ tool: SAY_TOOL_ID, lines, ...(agentId ? { agentId } : {}) } as unknown as Parameters<Engine['tool']['call']>[0]) as { result: string }
  return JSON.parse(r.result) as SayResult
}
// Regression caught: the speaker taken from the line instead of the call site, so a subagent could speak as the main agent.
test('a subagent call lands as worker and a main-thread call as agent', async ($, on) => {
  const { ledger } = world(on)
  expect((await say($, [...DECLS, '@1 agent: try(use(serving, sglang))'])).landed).toHaveLength(3)
  const worker = await say($, ['@2 worker: guess(use(serving, vllm))', '@2 agent: say(use(serving, vllm))'], 'w1')
  expect(worker.landed).toEqual(['@2 worker: guess(use(serving, vllm))'])
  expect(worker.rejected[0]?.error).toContain('this call speaks as worker')
  expect(ledger().utterances.map(u => [u.id, u.speaker])).toEqual([[1, 'agent'], [2, 'worker']])
})

// Regression caught: the agent writing a line as the user, which would outrank every real user instruction.
test('a line claiming the user speaker is rejected', async ($, on) => {
  const { ledger } = world(on)
  const result = await say($, [...DECLS, '@1 user: say(use(serving, sglang))'])
  expect(result.rejected.map(r => r.line)).toEqual(['@1 user: say(use(serving, sglang))'])
  expect(ledger().utterances).toEqual([])
})

// Regression caught: the agent accepting its own proposal, turning its try into an adopted fact with no one else's yes.
test('an agent accepting its own proposal is rejected', async ($, on) => {
  const { ledger } = world(on)
  await say($, [...DECLS, '@1 agent: try(use(serving, sglang))'])
  const result = await say($, ['@2 agent: accept(@1)'])
  expect(result.landed).toEqual([])
  expect(result.rejected[0]?.error).toContain('cannot accept')
  expect(ledger().utterances.map(u => u.id)).toEqual([1])
})

// Regression caught: an agent line sharing a user's @n, which eval ranks by its lowest speaker and so demotes the user's line.
test('an agent line numbered onto an existing utterance is renumbered, never demoting the user line', async ($, on) => {
  const { ledger } = world(on, [...DECLS, '@1 user: say(use(serving, sglang))'])
  const result = await say($, ['@1 agent: say(use(serving, vllm))'])
  expect(result.rejected).toEqual([])
  expect(result.landed[0]).toContain('renumbered from @1')
  expect(ledger().utterances.map(u => [u.id, u.speaker])).toEqual([[1, 'user'], [2, 'agent']])
})

// Regression caught: a stale or missing @n prefix costing a rejected round trip; bare lines now take the call's id and speaker, while another speaker is still rejected.
test('a bare line lands with the call id and speaker, and a line naming another speaker is rejected', async ($, on) => {
  const { ledger } = world(on, [...DECLS, '@1 user: say(use(serving, sglang))'])
  const result = await say($, ['say(use(serving, vllm))', '@9 user: say(use(serving, x))'])
  expect(result.landed).toEqual(['@2 agent: say(use(serving, vllm))'])
  // Regression caught: a tab after @n mangling the renumbered line.
  expect((await say($, ['@1\tagent: say(use(serving, x))'])).landed).toEqual(['@3 agent: say(use(serving, x))  (renumbered from @1)'])
  expect(result.rejected).toHaveLength(1)
  expect(ledger().utterances.map(u => [u.id, u.speaker])).toEqual([[1, 'user'], [2, 'agent'], [3, 'agent']])
})

// Regression caught: one invalid line costing the call its valid siblings.
test('a bad line is rejected while a good sibling lands', async ($, on) => {
  world(on)
  const result = await say($, [...DECLS, '@1 agent: say(undeclared(x))', '@1 agent: say(use(serving, sglang))'])
  expect(result.landed).toContain('@1 agent: say(use(serving, sglang))')
  expect(result.rejected).toEqual([{ line: '@1 agent: say(undeclared(x))', error: expect.stringContaining('undeclared') }])
})

// Regression caught: the result's open list missing the goal the agent just stated, so it cannot see what is still unresolved.
test('the result open list contains a want just added', async ($, on) => {
  world(on)
  const result = await say($, [...DECLS, '@1 agent: want(use(serving, sglang))'])
  expect(result.open.want.some(line => line.includes('want(use(serving, sglang))'))).toBe(true)
  expect(result.open.ask).toEqual([])
})

// Regression caught: a user want(p) stayed open after the agent reported say(done(p)).
test('want(p) leaves the open list once done(p) holds', async ($, on) => {
  world(on, [...DECLS, 'decl done(task) key(task) "끝난 작업"', '@1 user: want(use(serving, sglang))'])
  const result = await say($, ['@2 agent: say(done(use(serving, sglang)))'])
  expect(result.rejected).toEqual([])
  expect(result.open.want).toEqual([])
})

// Regression caught: the first say of a session rejected for numbering because nothing told the agent which id comes next.
test('the result next is the id a following line must use, and that line lands', async ($, on) => {
  world(on, [...DECLS, '@1 user: say(use(serving, sglang))', '@2 user: want(use(serving, vllm))'])
  const probe = await say($, [])
  expect(probe).toMatchObject({ landed: [], rejected: [], next: 3 })
  const line = '@' + probe.next + ' agent: try(use(serving, vllm))'
  const written = await say($, [line])
  expect(written.landed).toEqual([line])
  expect(written.next).toBe(probe.next + 1)
})
