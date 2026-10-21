import { test, expect, mock, type Engine, type MockClock } from 'claude-code/testing'
import type { AgentSpawnInput, McpToolName, TurnCompleteInput } from 'claude-code'
import { TOOL } from './budget'
import { AWAKE_TOOL } from './awake'

const MIN = 60_000
const T0 = 1_000_000_000

function world(on: any, env: Record<string, string> = {}, persistedState: Record<string, unknown> = {}) {
  const seen = {
    files: {} as Record<string, string>,
    state: { ...persistedState } as Record<string, unknown>,
    status: [] as (string | undefined)[],
    aborted: [] as string[],
    steps: 0,
    ran: [] as string[],
    clm: {} as Record<string, { id: string; title: string; status: string; updated: string }>,
    prompts: [] as string[],
    promptSubmissions: [] as { text: string; origin: any }[],
    goalRuns: [] as string[],
    goalOutput: undefined as string | undefined,
    goalThrows: false,
    toasts: [] as string[],
    downstreamDeny: undefined as string | undefined,
  }
  const clock: MockClock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/t', ...env })
  on('engine.create', async (_$: any, e: any, next: any) => ({
    ...(await next(e)),
    clm: {
      track: () => { throw new Error('test clm.track base') },
      issues: () => { throw new Error('test clm.issues base') },
      resume: () => { throw new Error('test clm.resume base') },
    },
  }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in seen.files }))
  on('fs.read', (_$: any, e: any) => ({ value: seen.files[e.path] }))
  on('fs.write', (_$: any, e: any) => { seen.files[e.path] = e.text; return { value: undefined } })
  on('state.set', async (_$: any, e: any, next: any) => {
    const result = await next(e)
    seen.state[e.key] = e.value
    return result
  })
  on('state.get', (_$: any, e: any, next: any) => Object.prototype.hasOwnProperty.call(persistedState, e.key)
    ? { value: { value: persistedState[e.key], version: 1 } }
    : next(e))
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'rm') delete seen.files[e.argv[2]]
    if (e.argv[0] === 'sh' && e.argv[1] === '-c') {
      const line = e.argv[4]
      const path = e.argv[5]
      seen.files[path] = `${seen.files[path] ?? ''}${line}\n`
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.status', (_$: any, e: any) => { seen.status.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_$: any, e: any) => ({ value: { tool: `mcp__time-budget__${e.name}` } }))
  on('turn.abort', (_$: any, e: any) => { seen.aborted.push(e.turnId); return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$: any, e: any) => {
    seen.prompts.push(e.text)
    seen.promptSubmissions.push({ text: e.text, origin: e.origin })
    return { text: e.text, context: e.context }
  })
  on('clm.track', (_$: any, e: any) => {
    const id = e.issue ?? `task-${Object.keys(seen.clm).length + 1}`
    const issue = seen.clm[id] ?? { id, title: e.title, status: e.status, updated: 'now' }
    issue.status = e.status
    seen.clm[id] = issue
    return { value: issue }
  })
  on('clm.issues', (_$: any, e: any) => ({
    value: Object.values(seen.clm).filter(issue => (!e?.issue || issue.id === e.issue) && (!e?.status || issue.status === e.status)),
  }))
  on('ui.toast', (_$: any, e: any) => { seen.toasts.push(e.text); return { value: undefined } })
  // Core /goal's own output lines, as the 2.1.288 binary prints them.
  on('command.run', { command: 'goal' }, (_$: any, e: any) => {
    seen.goalRuns.push(e.args)
    if (seen.goalThrows) throw new Error('core /goal failed')
    if (seen.goalOutput !== undefined) return { text: seen.goalOutput }
    if (!e.args.trim()) return { text: '' }
    return { text: ['clear', 'stop', 'off', 'reset', 'none', 'cancel'].includes(e.args) ? 'Goal cleared: x' : `Goal set: ${e.args}` }
  })
  on('turn.start', (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('agent.spawn', (_$: any, e: any) => ({ model: 'm', agentId: e.description }))
  on('tool.call', (_$: any, e: any) => {
    seen.ran.push(e.tool)
    return seen.downstreamDeny ? { deny: seen.downstreamDeny } : { result: 'ran' }
  })
  on('turn.step', async function* (_$: any, e: any) {
    seen.steps++
    yield { kind: 'text', index: 0, text: 'model' }
    yield { kind: 'stop', stopReason: 'end_turn', usage: null }
    return { turnId: e.turnId, index: e.index, answer: 'model', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  return { seen, clock }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
const end = ($: Engine) => $.session.end({ sessionId: 's1' } satisfies Parameters<Engine['session']['end']>[0])
const prompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
// A builtin's typed input has no agentId, so a subagent's call goes through an MCP name, whose arguments are loose.
const run = ($: Engine, input: Parameters<Engine['tool']['call']>[0]) => $.tool.call(input)
const call = ($: Engine, tool: McpToolName, args: Record<string, unknown> = {}) => $.tool.call({ tool, ...args })
const estimate = ($: Engine, minutes: number, agentId?: string, task?: string) =>
  call($, TOOL.estimate, { minutes, scope: 'the task', steps: ['a', 'b'], ...(agentId ? { agentId } : {}), ...(task ? { task } : {}) })
const report = ($: Engine, done: number, open: number, agentId?: string, moreMin?: number) => call($, TOOL.report, {
  done: Array.from({ length: done }, (_, i) => ({ item: `d${i}`, check: 'test' })),
  open: Array.from({ length: open }, (_, i) => ({ item: `o${i}`, next: 'do it' })),
  ...(agentId ? { agentId } : {}),
  ...(moreMin === undefined ? {} : { more_min: moreMin }),
})
const complete = ($: Engine, turnId: string, answer: string) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId, reason: 'answer' } satisfies TurnCompleteInput)
type SpawnVia = Pick<AgentSpawnInput, 'subagentType' | 'provider'>
const ENGINE_SPAWN: SpawnVia = { subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' } }
const CODEX_SOL: SpawnVia = { subagentType: 'codex-subagent:sol', provider: { plugin: 'codex-subagent', tier: 'user' } }
const spawn = ($: Engine, tool_use_id: string, prompt: string, description: string, via = ENGINE_SPAWN) =>
  $.agent.spawn({ tool_use_id, prompt, description, ...via, parentModel: 'm', background: false, fork: false } satisfies AgentSpawnInput)
const onlyIssue = (seen: ReturnType<typeof world>['seen']) => {
  const entries = Object.entries(seen.clm)
  if (entries.length !== 1) throw new Error(`expected one clm issue, found ${entries.length}`)
  const entry = entries[0]
  if (!entry) throw new Error('expected one clm issue entry')
  return entry[1]
}

const CAL = '/home/t/.local/share/claude-time-budget/calibration.jsonl'
const EXT = '/home/t/.local/share/claude-time-budget/extensions.jsonl'
const pairs = (seen: { files: Record<string, string> }) => (seen.files[CAL] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
const extensions = (seen: { files: Record<string, string> }) => (seen.files[EXT] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))

// Regression: a main turn with no doing clm issue remains ungated until estimate opens one.
test('main tools remain ungated until an estimate opens a clm task', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  expect((await run($, { tool: 'Bash', command: 'ls' })).result).toBe('ran')
  await estimate($, 30)
  expect(seen.ran).toEqual(['Bash'])
})

test('a downstream tool denial passes through unchanged', async ($, on) => {
  const { seen } = world(on)
  await start($)
  seen.downstreamDeny = 'denied by another plugin'
  const result = await run($, { tool: 'Bash', command: 'ls' })
  expect(result).toEqual({ deny: 'denied by another plugin' })
})

// Regression: deferred tool schemas could never load before the estimate, a deadlock.
test('ToolSearch passes before estimate', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  expect((await run($, { tool: 'ToolSearch', query: 'select:x', max_results: 1 })).result).toBe('ran')
  expect(seen.ran).toEqual(['ToolSearch'])
})

// Regression: a subagent rides on main's estimate, or main is blocked by a subagent's missing one.
test("a subagent's optional Budget line seeds its unit and an unestimated subagent remains ungated", async ($, on) => {
  world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  const unbudgeted = await spawn($, 'tu0', 'work', 'ag0')
  expect(unbudgeted.agentId).toBe('ag0')
  const unestimatedCall = await call($, 'mcp__x__y', { agentId: 'ag0' })
  expect(unestimatedCall.deny).toBeUndefined()
  expect(unestimatedCall.result).toBe('ran')
  await spawn($, 'tu1', 'Budget: 10 min\nwork', 'ag1')
  expect((await call($, 'mcp__x__y', { agentId: 'ag1' })).result).toBe('ran')
})

// Regression: checkpoints fired only from PostToolUse, so a long silent step skipped them,
// and the report they asked for was optional.
test('checkpoint feedback asks for a report once and leaves the next tool available', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(10 * MIN + 1)
  expect(seen.status.at(-1)).toContain('checkpoint 1/3 report due')
  const first = await run($, { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
  expect(first.deny).toBeUndefined()
  expect(first.result).toBe('ran')
  expect((first.context ?? []).join('\n')).toContain('Checkpoint 1/3 is due')
  const next = await run($, { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
  expect((next.context ?? []).join('\n')).not.toContain('Checkpoint 1/3')
  await clock.advance(5 * MIN)
  expect(seen.status.at(-1)).toContain('checkpoint 1/2 report due')
  const second = await run($, { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
  expect(second.result).toBe('ran')
  expect((second.context ?? []).join('\n')).toContain('Checkpoint 1/2 is due')
  expect((await report($, 2, 1)).result).toContain('Report recorded')
  expect((await run($, { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })).result).toBe('ran')
})

test('stay_awake returns a due checkpoint nudge once', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(10 * MIN + 1)
  const first = await call($, AWAKE_TOOL, { minutes: 5 })
  expect(first.deny).toBeUndefined()
  expect(first.result).toContain('Checkpoint 1/3 is due')
  const next = await run($, { tool: 'Read', file_path: '/x' })
  expect((next.context ?? []).join('\n')).not.toContain('Checkpoint 1/3')
})

// Regression: a subagent's report is lost on the way to main, or injected on every call.
test("a subagent's report reaches main's next tool result exactly once", async ($, on) => {
  world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await spawn($, 'tu1', 'Budget: 30 min\nwork', 'ag1')
  await report($, 1, 1, 'ag1')
  const first = await run($, { tool: 'Read', file_path: '/x' })
  expect((first.context ?? []).join('\n')).toContain('Subagent report (general-purpose ag1')
  expect((first.context ?? []).join('\n')).toContain(TOOL.grant)
  expect((await run($, { tool: 'Read', file_path: '/x' })).context ?? []).toEqual([])
})

// Regression: "likely to overrun" went undetected until the budget was spent.
test('a projected overrun gives extension feedback and leaves the next tool available', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(15 * MIN + 1)
  const reportResult = await report($, 2, 4)
  expect(reportResult.result).toContain('Continue at the same depth')
  expect(reportResult.result).toContain(TOOL.extend)
  const r = await run($, { tool: 'Bash', command: 'ls' })
  expect(r.deny).toBeUndefined()
  expect(r.result).toBe('ran')
  expect((r.context ?? []).join('\n')).not.toContain(TOOL.extend)
})

// Regression: a follow-up user prompt does not reset the open task's budget clock.
test('a follow-up prompt keeps the open task budget clock', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(5 * MIN)
  await prompt($, 'follow-up')
  await clock.advance(25 * MIN + 1)
  const result = await run($, { tool: 'Bash', command: 'ls' })
  expect(result.deny).toBeUndefined()
  expect(result.result).toBe('ran')
})

test('overrun reminders repeat at most once per checkpoint-sized interval', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(30 * MIN + 1)
  const first = await run($, { tool: 'Bash', command: 'ls' })
  expect(first.deny).toBeUndefined()
  expect((first.context ?? []).join('\n')).toContain(TOOL.extend)
  await clock.advance(4 * MIN)
  expect((await run($, { tool: 'Bash', command: 'ls' })).context ?? []).not.toContain(expect.stringContaining(TOOL.extend))
  await clock.advance(MIN)
  const repeated = await run($, { tool: 'Bash', command: 'ls' })
  expect((repeated.context ?? []).join('\n')).toContain(TOOL.extend)
})

test('an overrun never aborts a turn or replaces a subagent model request', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 60)
  await spawn($, 'tu1', 'Budget: 15 min\nwork', 'ag1')
  await clock.advance(20 * MIN)
  const chunks: any[] = []
  const stream = $.turn.step({ turnId: 'ts', index: 3, model: 'm', messageCount: 4, agentId: 'ag1' })
  for await (const c of stream) chunks.push(c)
  expect(seen.steps).toBe(1)
  expect(chunks.find(c => c.kind === 'text')?.text).toBe('model')
  expect(seen.aborted).toEqual([])
})

// Regression: changing the estimate does not replace the original calibration pair when the clm task closes.
test('a re-estimate can shrink a budget but calibration keeps the first estimate', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  const task = onlyIssue(seen).id
  expect((await estimate($, 10, undefined, task)).result).toContain('estimate 10 min')
  await complete($, 't1', 'done')
  onlyIssue(seen).status = 'done'
  await complete($, 't2', 'close')
  expect(pairs(seen)[0]).toMatchObject({ estimate_min: 30, budget_min: 15 })
})

// Regression: estimate without task opens a new clm task and closes the old calibration unit.
test('an estimate without task starts a new task', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(10 * MIN + 1)
  await report($, 1, 1)
  expect((await estimate($, 60)).result).toContain('Budget 60 min')
  expect(Object.keys(seen.clm)).toHaveLength(2)
  expect(pairs(seen)[0]).toMatchObject({ estimate_min: 30, actual_min: 10 })
})

test('estimate remains available when a checkpoint report is due', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(10 * MIN + 1)
  const task = onlyIssue(seen).id
  const estimateResult = await estimate($, 10, undefined, task)
  expect(estimateResult.deny).toBeUndefined()
  expect(estimateResult.result).toContain('estimate 10 min')
  const result = await run($, { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })
  expect(result.deny).toBeUndefined()
  expect(result.result).toBe('ran')
})

test('opening a new task and tools remain available after the estimated budget', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(30 * MIN + 1)
  expect((await estimate($, 60)).result).toContain('Budget 60 min')
  expect(Object.keys(seen.clm)).toHaveLength(2)
  const result = await run($, { tool: 'Bash', command: 'ls' })
  expect(result.deny).toBeUndefined()
  expect(result.result).toBe('ran')
})

test('an upward re-estimate is allowed and recorded while calibration keeps the first estimate', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  const task = onlyIssue(seen).id
  await clock.advance(5 * MIN)
  expect((await estimate($, 120, undefined, task)).result).toContain('estimate 120 min')
  expect(extensions(seen)[0]).toMatchObject({
    kind: 'main', task, estimate_min: 120, budget_before: 30, budget_after: 120, minutes: 90,
    source: 'reestimate', reason: 'Estimate refined for the task.',
  })
  onlyIssue(seen).status = 'done'
  await complete($, 't1', 'close')
  expect(pairs(seen)[0]).toMatchObject({ estimate_min: 30, extended_min: 0, extensions: 0 })
})

test('a lower re-estimate keeps extended minutes without an immediate overrun nudge', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 10)
  const task = onlyIssue(seen).id
  await call($, TOOL.extend, { minutes: 20, reason: 'Additional verification remains.' })
  await clock.advance(MIN)
  const lower = await estimate($, 5, undefined, task)
  expect(lower.result).toContain('Budget 35 min')
  expect(lower.result).not.toContain('Budget feedback:')
  const higher = await estimate($, 20, undefined, task)
  expect(higher.result).toContain('Budget 40 min')
  expect(extensions(seen).at(-1)).toMatchObject({ source: 'reestimate', minutes: 5, budget_before: 35, budget_after: 40 })
  const repeated = await estimate($, 20, undefined, task)
  expect(repeated.result).toContain('Budget 40 min')
  expect(extensions(seen)).toHaveLength(2)
})

test('resuming a parked task can refine its budget and records the additional minutes', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  const first = Object.keys(seen.clm)[0] ?? ''
  await report($, 1, 0)
  await estimate($, 20)
  const result = await estimate($, 120, undefined, first)
  expect(result.deny).toBeUndefined()
  expect(result.result).toContain('Budget 120 min')
  expect(extensions(seen)[0]).toMatchObject({ task: first, source: 'reestimate', budget_before: 30, budget_after: 120, minutes: 90 })
})

// Regression: a resumed task restarted its clock at the resume and logged a second calibration pair.
test('resuming a parked task at a lower budget keeps its start and logs one pair', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  const first = Object.keys(seen.clm)[0] ?? ''
  await clock.advance(5 * MIN)
  await estimate($, 20)
  await clock.advance(5 * MIN)
  expect((await estimate($, 25, undefined, first)).result).toContain('10 min elapsed')
  const issue = seen.clm[first]
  if (!issue) throw new Error(`expected clm issue ${first}`)
  issue.status = 'done'
  await complete($, 't1', 'close')
  expect(pairs(seen).map(p => p.estimate_min)).toEqual([30, 20])
})

test('legacy persisted halt fields are ignored when a task loads', async ($, on) => {
  const { seen } = world(on, {}, {
    units: {
      'persisted-task': {
        kind: 'main', start: T0 - 15 * MIN - 1, budgetMin: 15, fired: 5,
        halted: 'the budget of 15 min is spent (15 min elapsed)', haltedAt: T0,
      },
    },
  })
  await start($)
  const result = await run($, { tool: 'Bash', command: 'ls' })
  expect(result.deny).toBeUndefined()
  expect(result.result).toBe('ran')
  expect((result.context ?? []).join('\n')).toContain(TOOL.extend)
})

// Regression: resuming a parked task dropped reportDue, so an owed checkpoint report was forgotten.
test('a report due before session end is still due when resumed', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  const first = Object.keys(seen.clm)[0] ?? ''
  await clock.advance(11 * MIN)
  const firstCall = await run($, { tool: 'Bash', command: 'ls' })
  expect((firstCall.context ?? []).join('\n')).toContain('Checkpoint 1/3 is due')
  await end($)
  await start($)
  await estimate($, 30, undefined, first)
  const resumed = await run($, { tool: 'Bash', command: 'ls' })
  expect(resumed.result).toBe('ran')
  expect((resumed.context ?? []).join('\n')).not.toContain('Checkpoint 1/3')
})

test('extend adds minutes to the current budget and writes every extension record field', async ($, on) => {
  const { seen, clock } = world(on, { TIME_BUDGET_DIR: '/custom/time-budget' })
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  const task = onlyIssue(seen).id
  await clock.advance(5 * MIN)
  const file = '/custom/time-budget/extensions.jsonl'
  seen.files[file] = `${JSON.stringify({ at: 1, kind: 'sub', agent_type: 'worker', task: 'old-task', scope: 'old', estimate_min: 10, budget_before: 10, budget_after: 15, minutes: 5, elapsed_min: 2, reason: 'prior extension', source: 'extend' })}\n`
  const result = await call($, TOOL.extend, { minutes: 10, reason: 'More verification is needed.' })
  expect(result.deny).toBeUndefined()
  expect(result.result).toContain('now 40 min')
  const records = (seen.files[file] ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
  expect(records).toHaveLength(2)
  const record = records[1]
  expect(record).toMatchObject({
    at: Math.floor((T0 + 5 * MIN) / 1000), kind: 'main', agent_type: null, task, scope: 'the task', estimate_min: 30,
    budget_before: 30, budget_after: 40, minutes: 10, elapsed_min: 5, reason: 'More verification is needed.', source: 'extend',
  })
})

test('calibration pairs include the total extension and count', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 10)
  await clock.advance(15 * MIN + 1)
  await complete($, 't1', 'done')
  await call($, TOOL.extend, { minutes: 5, reason: 'The open item needs another check.' })
  await clock.advance(5 * MIN)
  await complete($, 't2', 'continued')
  onlyIssue(seen).status = 'done'
  await complete($, 't3', 'close')
  expect(pairs(seen)[0]).toMatchObject({ extended_min: 5, extensions: 1, actual_min: 20 })
})

test('grant adds time to a subagent budget and records source grant', async ($, on) => {
  const { clock, seen } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 60)
  await spawn($, 'tu1', 'Budget: 15 min\nwork', 'ag1')
  await clock.advance(11 * MIN)
  await report($, 1, 3, 'ag1')
  expect((await call($, 'mcp__x__y', { agentId: 'ag1' })).result).toBe('ran')
  expect((await call($, TOOL.grant, { agent_id: 'ag1', minutes: 5 })).result).toContain('now 20 min')
  expect(extensions(seen)[0]).toMatchObject({ task: 'ag1', kind: 'sub', budget_before: 15, budget_after: 20, minutes: 5, source: 'grant' })
  expect((await call($, 'mcp__x__y', { agentId: 'ag1' })).result).toBe('ran')
})

test('a grant adds time to the current subagent budget', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 60)
  await spawn($, 'tu1', 'Budget: 30 min\nwork', 'ag1')
  await clock.advance(5 * MIN)
  expect((await call($, TOOL.grant, { agent_id: 'ag1', minutes: 10 })).result).toContain('now 40 min')
  await clock.advance(16 * MIN)
  expect((await report($, 1, 0, 'ag1')).result).toContain('against 40 min')
})

// Regression: closing a clm task appends its pair without trimming calibration history.
test('calibration appends retain the full history beyond the factor window', async ($, on) => {
  const { seen } = world(on)
  seen.files[CAL] = `${Array.from({ length: 50 }, (_, i) => JSON.stringify({ kind: 'main', agent_type: null, estimate_min: 10, budget_min: 15, actual_min: 10, at: i })).join('\n')}\n`
  await start($)
  await prompt($, 'go')
  await estimate($, 20)
  await complete($, 't1', 'done')
  onlyIssue(seen).status = 'done'
  await complete($, 't2', 'close')
  const logged = pairs(seen)
  expect(logged).toHaveLength(51)
  expect(logged[0]?.at).toBe(0)
  expect(logged.at(-1)?.estimate_min).toBe(20)
})

test('a subagent can refine its own estimate upward and the refinement is recorded', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 60)
  await spawn($, 'tu1', 'Budget: 10 min\nwork', 'ag1')
  const result = await estimate($, 20, 'ag1')
  expect(result.deny).toBeUndefined()
  expect(result.result).toContain('estimate 20 min')
  expect(extensions(seen)[0]).toMatchObject({ task: 'ag1', source: 'reestimate', budget_before: 15, budget_after: 20, minutes: 5 })
})

test('a codex spawn without a Budget line is allowed and its tools remain available', async ($, on) => {
  world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  const no = await spawn($, 'tu1', 'fix it', 'cx1', CODEX_SOL)
  expect(no.agentId).toBe('cx1')
  expect((await call($, 'mcp__x__y', { agentId: 'cx1' })).result).toBe('ran')
  const yes = await spawn($, 'tu1', 'Budget: 20 min\nfix it', 'cx2', CODEX_SOL)
  expect(yes.agentId).toBe('cx2')
  expect((await call($, 'mcp__x__y', { agentId: 'cx2' })).result).toBe('ran')
})

test('a subagent can extend its own budget with an explicit reason', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 60)
  await spawn($, 'tu1', 'Budget: 10 min\nwork', 'ag1')
  const result = await call($, TOOL.extend, { agentId: 'ag1', minutes: 5, reason: 'The implementation needs a compatibility check.' })
  expect(result.deny).toBeUndefined()
  expect(result.result).toContain('now 20 min')
  expect(extensions(seen)[0]).toMatchObject({ task: 'ag1', kind: 'sub', budget_before: 15, budget_after: 20, source: 'extend' })
})

test('report records a projection request without changing the budget and names extend', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(15 * MIN)
  const result = await report($, 2, 4, undefined, 20)
  expect(result.result).toContain(`call ${TOOL.extend} with minutes 20 and a reason`)
  expect(extensions(seen)[0]).toMatchObject({ source: 'report', minutes: 20, budget_before: 30, budget_after: 30 })
  expect(pairs(seen)).toEqual([])
})

test('estimate feedback includes extension history and suggests smaller steps for a long single step', async ($, on) => {
  const { seen } = world(on)
  seen.files[CAL] = `${JSON.stringify({ kind: 'main', agent_type: null, estimate_min: 20, budget_min: 30, actual_min: 45, at: 10, extended_min: 10, extensions: 1 })}\n`
  seen.files[EXT] = `${JSON.stringify({ at: 11, kind: 'main', agent_type: null, task: 'old-task', scope: 'fix', estimate_min: 20, budget_before: 30, budget_after: 40, minutes: 10, elapsed_min: 30, reason: 'The fixture exposed another edge case.', source: 'extend' })}\n`
  await start($)
  await prompt($, 'go')
  const result = await call($, TOOL.estimate, { minutes: 40, scope: 'the task', steps: [] })
  expect(result.result).toContain('1/1 recent units needed extra time')
  expect(result.result).toContain('median +10 min per extension')
  expect(result.result).toContain('The fixture exposed another edge case.')
  expect(result.result).toContain('split this estimate into smaller steps')
})

// Regression: calibration logged one turn per unit (actual 0.55 min against 30), or a pair per Stop.
test('a main unit logs one pair at close, measured to its last turn end', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 20)
  await clock.advance(5 * MIN)
  await complete($, 't1', 'a')
  await clock.advance(7 * MIN)
  await complete($, 't2', 'b')
  expect(pairs(seen)).toEqual([])
  onlyIssue(seen).status = 'done'
  await complete($, 't3', 'close')
  const logged = pairs(seen)
  expect(logged.length).toBe(1)
  expect(logged[0]).toEqual({ kind: 'main', agent_type: null, estimate_min: 20, budget_min: 20, actual_min: 12, at: Math.floor((T0 + 12 * MIN) / 1000), extended_min: 0, extensions: 0 })
})

// Regression: a clm issue reaching done closes its unit and appends exactly one calibration pair.
test('a done clm issue closes the main unit once', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 20)
  onlyIssue(seen).status = 'done'
  await complete($, 't1', 'done')
  expect(pairs(seen)).toHaveLength(1)
  await complete($, 't2', 'done')
  expect(pairs(seen)).toHaveLength(1)
})

// Regression: a budget line under every answer showed as a notice row in focus view,
// or a due report went unannounced once that line was dropped.
test('a main answer carries the budget line only when a report is due', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  expect((await complete($, 't1', 'done')).text).toBe('done')
  await clock.advance(11 * MIN)
  const r = await complete($, 't2', 'done')
  expect(r.text).toContain('estimate 30m')
  expect(r.text).toContain('report due')
})

const goal = ($: Engine, args: string) => $.command.run({ command: 'goal', args } satisfies Parameters<Engine['command']['run']>[0])
const AWAKE = '/home/t/.local/state/claude-awake/until'
const awakeAt = (ms: number) => `${Math.floor(ms / 1000 + 30 * 60)}\n`
// The harness has no store beneath session.append, so the row is observed and its store attempt's rejection ignored.
const append = ($: Engine, row: Record<string, unknown>) => $.session.append({ uuid: `row-${Math.random()}`, ...row } as any).catch(() => undefined)
const goalRow = ($: Engine) => append($, { message: { type: 'attachment', name: 'goal_status', content: [] }, door: 'attachment', origin: { kind: 'engine' } })
const responseRow = ($: Engine) => append($, { message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: 'working' }] }, door: 'response', origin: { kind: 'model', model: 'm' } })

test('a typed /goal keeps the Mac awake and suppresses overrun feedback', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 15)
  await clock.advance(15 * MIN + 1)
  await goal($, 'all tests pass')
  expect(seen.goalRuns).toEqual(['all tests pass'])
  expect(seen.state.goal).toBe('all tests pass')
  expect(seen.files[AWAKE]).toBe(awakeAt(T0 + 15 * MIN + 1))
  await clock.advance(3 * MIN)
  const result = await run($, { tool: 'Bash', command: 'ls' })
  expect(result.deny).toBeUndefined()
  expect(result.result).toBe('ran')
  expect((result.context ?? []).join('\n')).not.toContain('Budget feedback:')
})

// Regression: the goal's evaluator writes a final row before turn.complete; only that end turns the mode off.
test('a goal end turns unlimited off and clears stay-awake', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await goal($, 'done')
  await prompt($, 'go')
  await responseRow($)
  await goalRow($)
  await complete($, 'turn-goal', 'met')
  expect(seen.state.goal).toBe(null)
  expect(seen.files[AWAKE]).toBeUndefined()
  expect(seen.status.at(-1)).toContain('goal ended')
  expect(seen.toasts.at(-1)).toContain('unlimited off')
})

// Regression: the one-minute lease stopped refreshing while a typed goal was still active.
test('a running goal refreshes the stay-awake lease every minute', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await goal($, 'all tests pass')
  expect(seen.state.goal).toBe('all tests pass')
  expect(seen.files[AWAKE]).toBe(awakeAt(T0))
  await clock.advance(2 * MIN)
  expect(seen.files[AWAKE]).toBe(awakeAt(T0 + 2 * MIN))
})

// Regression: a "not met" check, which the model answers by working on, ended the unattended run.
test('a goal check followed by more model output keeps unlimited on', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await goal($, 'done')
  await goalRow($)
  await responseRow($)
  await complete($, 'turn-not-met', 'still going')
  expect(seen.state.goal).toBe('done')
})

// Regression: the stay-awake refresh kept rewriting the deadline after the goal was cleared.
test('awake refresh stops when the goal ends', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await goal($, 'done')
  await goal($, 'clear')
  expect(seen.files[AWAKE]).toBeUndefined()
  await clock.advance(5 * MIN)
  expect(seen.files[AWAKE]).toBeUndefined()
})

// Regression: clearing an active goal leaves unlimited on or keeps the Mac awake.
test('/goal clear turns unlimited off and lets the Mac sleep', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await goal($, 'ship it')
  await goal($, 'clear')
  expect(seen.state.goal).toBe(null)
  expect(seen.files[AWAKE]).toBeUndefined()
})

// Regression: ending a goal also disabled the configured always-on override.
test('the unlimited environment setting survives goal end', async ($, on) => {
  const { seen, clock } = world(on, { CLAUDE_TIME_BUDGET_UNLIMITED: '1' })
  await start($)
  await prompt($, 'go')
  await estimate($, 15)
  await goal($, 'done')
  await clock.advance(15 * MIN + 1)
  await prompt($, 'go')
  await responseRow($)
  await goalRow($)
  await complete($, 'turn-goal', 'met')
  await report($, 1, 0)
  expect(seen.state.goal).toBe(null)
  expect(seen.files[AWAKE]).toBeUndefined()
  expect((await run($, { tool: 'Bash', command: 'ls' })).result).toBe('ran')
})

test('a persisted goal survives session end and restart with legacy unit fields ignored', async ($, on) => {
  const startAt = T0 - 15 * MIN - 1
  const { seen, clock } = world(on, {}, {
    goal: 'finish the task',
    units: {
      'persisted-task': {
        kind: 'main', start: startAt, budgetMin: 15, fired: 5,
        halted: 'the budget of 15 min is spent (15 min elapsed)', haltedAt: T0,
      },
    },
  })
  await start($)
  expect(seen.state.goal).toBe('finish the task')
  expect(seen.status.at(-1)).toContain('unlimited until goal')
  expect(seen.files[AWAKE]).toBe(awakeAt(T0))
  await end($)
  await start($)
  await clock.advance(2 * MIN)
  expect(seen.files[AWAKE]).toBe(awakeAt(T0 + 2 * MIN))
  await estimate($, 15, undefined, 'persisted-task')
  expect((await run($, { tool: 'Bash', command: 'ls' })).result).toBe('ran')
})

// catches a leaked refresh timer keeping the Mac awake after /clear
test('a cleared goal stays asleep after session restart', async ($, on) => {
  const persistedState: Record<string, unknown> = {}
  const { seen, clock } = world(on, {}, persistedState)
  await start($)
  await goal($, 'finish the task')
  await end($)
  persistedState.goal = null
  await start($)
  const awake = seen.files[AWAKE]
  await clock.advance(2 * MIN)
  expect(seen.files[AWAKE]).toBe(awake)
})

// Regression: a legacy unlimited=true value without a goal must not bypass an exhausted budget.
test('the unlimited environment setting suppresses overrun reminders', async ($, on) => {
  const { clock } = world(on, { CLAUDE_TIME_BUDGET_UNLIMITED: '1' })
  await start($)
  await prompt($, 'go')
  await estimate($, 15)
  await clock.advance(15 * MIN + 1)
  const result = await run($, { tool: 'Bash', command: 'ls' })
  expect(result.deny).toBeUndefined()
  expect(result.result).toBe('ran')
  expect((result.context ?? []).join('\n')).not.toContain('Budget feedback:')
})

// Regression: `/goal` without arguments must leave an empty session without a tracked goal or awake lease.
test('a bare /goal without an active goal changes nothing', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await goal($, '')
  expect(seen.state.goal).toBeUndefined()
  expect(seen.files[AWAKE]).toBeUndefined()
})

// Regression: a rejected or thrown replacement goal must leave the active goal and awake lease intact.
test('a failed replacement goal keeps the existing goal and awake lease', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await goal($, 'finish the task')
  const awake = seen.files[AWAKE]
  seen.goalOutput = 'Goal condition is limited to N'
  await goal($, 'replacement')
  expect(seen.state.goal).toBe('finish the task')
  expect(seen.files[AWAKE]).toBe(awake)

  seen.goalOutput = undefined
  seen.goalThrows = true
  const failure = await goal($, 'another replacement').then(() => undefined, err => String(err))
  expect(failure).toBeTruthy()
  expect(seen.state.goal).toBe('finish the task')
  expect(seen.files[AWAKE]).toBe(awake)
})
