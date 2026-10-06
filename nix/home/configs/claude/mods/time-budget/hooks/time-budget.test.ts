import { test, expect, mock, type MockClock } from 'claude-code/testing'
import { GRACE_MS, TOOL } from './budget'

const MIN = 60_000
const T0 = 1_000_000_000

function world(on: any) {
  const seen = {
    files: {} as Record<string, string>,
    status: [] as (string | undefined)[],
    aborted: [] as string[],
    steps: 0,
    ran: [] as string[],
  }
  const clock: MockClock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/t' })
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in seen.files }))
  on('fs.read', (_$: any, e: any) => ({ value: seen.files[e.path] }))
  on('fs.write', (_$: any, e: any) => { seen.files[e.path] = e.text; return { value: undefined } })
  on('ui.status', (_$: any, e: any) => { seen.status.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', (_$: any, e: any) => ({ value: { tool: `mcp__time-budget__${e.name}` } }))
  on('turn.abort', (_$: any, e: any) => { seen.aborted.push(e.turnId); return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text, context: e.context }))
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('agent.spawn', (_$: any, e: any) => ({ model: 'm', agentId: e.description }))
  on('tool.call', (_$: any, e: any) => { seen.ran.push(e.tool); return { result: 'ran' } })
  on('turn.step', async function* (_$: any, e: any) {
    seen.steps++
    yield { kind: 'text', index: 0, text: 'model' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'model', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { seen, clock }
}

const start = ($: any) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
const prompt = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const call = ($: any, tool: string, args: Record<string, unknown> = {}) => $.tool.call({ tool, ...args })
const estimate = ($: any, minutes: number, agentId?: string) =>
  call($, TOOL.estimate, { minutes, scope: 'the task', steps: ['a', 'b'], ...(agentId ? { agentId } : {}) })
const report = ($: any, done: number, open: number, agentId?: string) => call($, TOOL.report, {
  done: Array.from({ length: done }, (_, i) => ({ item: `d${i}`, check: 'test' })),
  open: Array.from({ length: open }, (_, i) => ({ item: `o${i}`, next: 'do it' })),
  ...(agentId ? { agentId } : {}),
})
const denied = (r: any) => r.deny ?? (r.isError ? r.text : undefined)

const CAL = '/home/t/.local/share/claude-time-budget/calibration.jsonl'
const pairs = (seen: { files: Record<string, string> }) => (seen.files[CAL] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))

// Regression: the estimate stays a request the model can ignore, as the python hook's was.
test('Bash before estimate is denied and names the estimate tool', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  expect(denied(await call($, 'Bash', { command: 'ls' }))).toContain(TOOL.estimate)
  expect(seen.ran).toEqual([])
  await estimate($, 30)
  expect((await call($, 'Bash', { command: 'ls' })).result).toBe('ran')
})

// Regression: deferred tool schemas could never load before the estimate, a deadlock.
test('ToolSearch passes before estimate', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  expect((await call($, 'ToolSearch', { query: 'select:x', max_results: 1 })).result).toBe('ran')
  expect(seen.ran).toEqual(['ToolSearch'])
})

// Regression: a subagent rides on main's estimate, or main is blocked by a subagent's missing one.
test("a subagent's first tool call is gated on its own unit, not main's", async ($, on) => {
  world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'work', description: 'ag1', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as any)
  expect(denied(await call($, 'Read', { file_path: '/x', agentId: 'ag1' }))).toContain(TOOL.estimate)
  expect((await call($, 'Read', { file_path: '/x' })).result).toBe('ran')
  await estimate($, 10, 'ag1')
  expect((await call($, 'Read', { file_path: '/x', agentId: 'ag1' })).result).toBe('ran')
})

// Regression: checkpoints fired only from PostToolUse, so a long silent step skipped them,
// and the report they asked for was optional.
test('advancing past 1/3 with no tool call marks the report due; Edit waits on the report', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(10 * MIN + 1)
  expect(seen.status.at(-1)).toContain('checkpoint 1/3 report due')
  await clock.advance(5 * MIN)
  expect(seen.status.at(-1)).toContain('checkpoint 1/2 report due')
  expect(denied(await call($, 'Edit', { file_path: '/x', old_string: 'a', new_string: 'b' }))).toContain('Checkpoint 1/2')
  expect((await report($, 2, 1)).result).toContain('Report recorded')
  expect((await call($, 'Edit', { file_path: '/x', old_string: 'a', new_string: 'b' })).result).toBe('ran')
})

// Regression: a subagent's report is lost on the way to main, or injected on every call.
test("a subagent's report reaches main's next tool result exactly once", async ($, on) => {
  world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'work', description: 'ag1', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as any)
  await estimate($, 30, 'ag1')
  await report($, 1, 1, 'ag1')
  const first = await call($, 'Read', { file_path: '/x' })
  expect((first.context ?? []).join('\n')).toContain('Subagent report (general-purpose ag1')
  expect((first.context ?? []).join('\n')).toContain(TOOL.grant)
  expect((await call($, 'Read', { file_path: '/x' })).context ?? []).toEqual([])
})

// Regression: "likely to overrun" went undetected until the budget was spent.
test('a projected overrun denies the next tool with the stop text', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(15 * MIN + 1)
  expect((await report($, 2, 4)).result).toContain('Stop here')
  const r = denied(await call($, 'Bash', { command: 'ls' }))
  expect(r).toContain('Stop here')
  expect(r).toContain(TOOL.report)
})

// Regression: the user's "+20m" restarts the clock and loses the elapsed time (port of the python selftest).
test('a +20m reply continues the same clock: start unchanged, budget +20', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(30 * MIN + 1)
  expect(denied(await call($, 'Bash', { command: 'ls' }))).toContain('budget of 30 min is spent')
  await prompt($, 'ok +20m')
  expect(seen.status.at(-1)).toMatch(/^budget 30\/50m/)
  expect((await call($, 'Bash', { command: 'ls' })).result).toBe('ran')
  expect(pairs(seen)).toEqual([])
})

// Regression: a main turn that keeps going past the stop is never cut off.
test('a main turn still running GRACE_MS after 6/6 is aborted, and not before', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await estimate($, 15)
  await clock.advance(15 * MIN + 1)
  await clock.advance(GRACE_MS - 1000)
  expect(seen.aborted).toEqual([])
  await clock.advance(1000)
  expect(seen.aborted).toEqual(['turn-1'])
})

// Regression: a stopped subagent keeps making model requests until it decides to stop.
test("a halted subagent's step past the grace sends no model request and hands back the report", async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 60)
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'work', description: 'ag1', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as any)
  await estimate($, 15, 'ag1')
  await clock.advance(15 * MIN + 1)
  await clock.advance(GRACE_MS)
  const chunks: any[] = []
  const stream = $.turn.step({ turnId: 'ts', index: 3, model: 'm', messageCount: 4, agentId: 'ag1' })
  for await (const c of stream) chunks.push(c)
  expect(seen.steps).toBe(0)
  expect(chunks.find(c => c.kind === 'tool')?.name).toBe('SubagentHandback')
  expect(chunks.find(c => c.kind === 'input')?.json).toContain('Stopped by the time budget')
})

// Regression: a codex agent runs with no estimate because no gate reaches inside codex.
test('a codex spawn without a Budget line is denied, and one with it starts budgeted', async ($, on) => {
  world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  const base = { tool_use_id: 'tu1', subagentType: 'codex-subagent:sol', provider: { plugin: 'codex-subagent', tier: 'user' }, parentModel: 'm' }
  const no = await $.agent.spawn({ ...base, prompt: 'fix it', description: 'cx1' } as any)
  expect(no.deny).toContain('Budget: <N> min')
  const yes = await $.agent.spawn({ ...base, prompt: 'Budget: 20 min\nfix it', description: 'cx2' } as any)
  expect(yes.agentId).toBe('cx2')
  expect((await call($, 'mcp__x__y', { agentId: 'cx2' })).result).toBe('ran')
})

// Regression: calibration logged one turn per unit (actual 0.55 min against 30), or a pair per Stop.
test('a main unit logs one pair at close, measured to its last turn end', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 20)
  await clock.advance(5 * MIN)
  await $.turn.complete({ answer: 'a', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  await clock.advance(7 * MIN)
  await $.turn.complete({ answer: 'b', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as any)
  expect(pairs(seen)).toEqual([])
  await clock.advance(60 * MIN)
  await prompt($, 'next task')
  const logged = pairs(seen)
  expect(logged.length).toBe(1)
  expect(logged[0]).toEqual({ kind: 'main', agent_type: null, estimate_min: 20, budget_min: 20, actual_min: 12, at: Math.floor((T0 + 12 * MIN) / 1000) })
})

// Regression: the user never sees the budget unless the model chooses to say it.
test('a main answer carries the budget line beneath it', async ($, on) => {
  world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 20)
  const r = await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  expect(r.text).toContain('estimate 20m')
  expect(r.text).toContain('budget 0/20m')
})
