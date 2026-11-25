import { test, expect, type Engine } from 'claude-code/testing'

import { readWayseekerLedger, wayseekerKey } from './render'
import { isReadOnlyBash, SAY_TOOL_ID, type SayResult } from './say'
import { appendAll } from './store'

const STATE = '/home/t/.claude-work/plans/wayseeker-s1.json'
const DECLS = ['decl use(role, tool) key(role) "{role}에 {tool}을 쓴다"', 'serving := "서빙"']
type Use = { tool_use_id: string; tool: string; input: Record<string, unknown> }
type Row = { role: 'user' | 'assistant'; text: string; toolUses: Use[] }

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
  on('classic.Stop', () => ({}))
  const ledger = () => readWayseekerLedger(JSON.parse(files[STATE] ?? '{}')[wayseekerKey('s1:main')])
  return { rows, ledger }
}
// A builtin's typed input has no agentId, so a subagent's call goes through the MCP name, whose arguments are loose.
const say = async ($: Engine, lines: string[], agentId?: string): Promise<SayResult> => {
  const r = await $.tool.call({ tool: SAY_TOOL_ID, lines, ...(agentId ? { agentId } : {}) } as unknown as Parameters<Engine['tool']['call']>[0]) as { result: string }
  return JSON.parse(r.result) as SayResult
}
const human = (text: string): Row => ({ role: 'user', text, toolUses: [] })
const acting = (...uses: [tool: string, input?: Record<string, unknown>][]): Row =>
  ({ role: 'assistant', text: '', toolUses: uses.map(([tool, input], i) => ({ tool_use_id: 't' + i, tool, input: input ?? {} })) })
const stop = ($: Engine, active = false) => $.classic.Stop({ stop_hook_active: active })

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
test('an agent line numbered onto an existing utterance is rejected with the id to use', async ($, on) => {
  const { ledger } = world(on, [...DECLS, '@1 user: say(use(serving, sglang))'])
  const result = await say($, ['@1 agent: say(use(serving, vllm))'])
  expect(result.rejected[0]?.error).toContain('@2')
  expect(ledger().utterances.map(u => u.speaker)).toEqual(['user'])
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

// Regression caught: a turn that edited files ending without a ledger record, or the nudge re-blocking its own re-prompt forever.
test('Stop blocks once after an Edit with no say', async ($, on) => {
  const { rows } = world(on)
  rows.push(human('fix it'), acting(['Edit']))
  expect((await stop($)).block).toContain(SAY_TOOL_ID)
  expect((await stop($, true)).block).toBeUndefined()
})

// Regression caught: nudging a turn that already recorded its work.
test('Stop does not block when say was called this turn', async ($, on) => {
  const { rows } = world(on)
  rows.push(human('fix it'), acting(['Edit'], [SAY_TOOL_ID, { lines: [] }]))
  expect((await stop($)).block).toBeUndefined()
})

// Regression caught: nudging a turn that only looked around, or one whose Edit belonged to an earlier turn.
test('Stop does not block a turn with only read-only Bash', async ($, on) => {
  const { rows } = world(on)
  rows.push(human('before'), acting(['Edit']), human('look'), acting(['Bash', { command: 'git -C /x status && rg foo src | head -5 2>/dev/null' }], ['Bash', { command: 'claude plugin test .' }]))
  expect((await stop($)).block).toBeUndefined()
})

// Regression caught: the nudge looping on the re-prompt it caused.
test('Stop does not block when stop_hook_active', async ($, on) => {
  const { rows } = world(on)
  rows.push(human('fix it'), acting(['Write']))
  expect((await stop($, true)).block).toBeUndefined()
})

// Regression caught: the nudge never firing in REPL-driven sessions, where files change through edit()/write() inside a script.
test('a REPL call with edit( and no say triggers the nudge', async ($, on) => {
  const { rows } = world(on)
  rows.push(human('fix it'), acting(['REPL', { code: "await edit(H+'say.ts', 'a', 'b')" }]))
  expect((await stop($)).block).toContain(SAY_TOOL_ID)
})

// Regression caught: a REPL script that only reads (git status, cd + ls with an interpolated dir) being nudged as work.
test('a REPL call running only read-only shell does not trigger the nudge', async ($, on) => {
  const { rows } = world(on)
  rows.push(human('look'), acting(['REPL', { code: 'const s = await $\x60git status\x60.text(); const l = await $\x60cd ${D} && ls hooks\x60; $(\'pwd\')' }]))
  expect((await stop($)).block).toBeUndefined()
})

// Regression caught: a REPL script hiding a mutation behind a shell template, an interpolated head, or a tools.Bash call.
test('REPL shell outside the allowlist counts as work', async ($, on) => {
  const { rows } = world(on)
  rows.push(human('a'), acting(['REPL', { code: 'await $\x60git commit -m ${msg}\x60' }]))
  expect((await stop($)).block).toBeDefined()
  rows.push(human('b'), acting(['REPL', { code: 'await $\x60${cmd} status\x60' }]))
  expect((await stop($)).block).toBeDefined()
  rows.push(human('c'), acting(['REPL', { code: "await tools.Bash({ command: 'ls' })" }]))
  expect((await stop($)).block).toBeDefined()
  rows.push(human('d'), acting(['REPL', { code: "await edit(p, 'a', 'b'); await tools['" + SAY_TOOL_ID + "']({ lines: [] })" }]))
  expect((await stop($)).block).toBeUndefined()
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

// Regression caught: a write disguised as a reader (redirect, substitution, find -delete) passing as read-only.
test('read-only Bash needs every segment to be an allowlisted reader', () => {
  expect(isReadOnlyBash('git log --oneline -5 | cat')).toBe(true)
  expect(isReadOnlyBash('ls 2>&1 | wc -l')).toBe(true)
  expect(isReadOnlyBash('echo hi > out.txt')).toBe(false)
  expect(isReadOnlyBash('echo "$(rm -rf x)"')).toBe(false)
  expect(isReadOnlyBash('find . -name x -delete')).toBe(false)
  expect(isReadOnlyBash('ls && git commit -m x')).toBe(false)
  expect(isReadOnlyBash('npm test')).toBe(false)
  expect(isReadOnlyBash('cd x && ls')).toBe(true)
  expect(isReadOnlyBash('cd x && rm y')).toBe(false)
})
