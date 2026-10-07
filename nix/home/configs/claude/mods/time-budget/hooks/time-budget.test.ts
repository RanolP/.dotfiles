import { test, expect, mock, type MockClock } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'
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
    clm: {} as Record<string, { id: string; title: string; status: string; updated: string }>,
    prompts: [] as string[],
  }
  const clock: MockClock = mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/t' })
  on('engine.create', async (_$: any, e: any, next: any) => ({
    ...(await next(e)),
    clm: {
      track: () => { throw new Error('test clm.track base') },
      issues: () => { throw new Error('test clm.issues base') },
    },
  }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in seen.files }))
  on('fs.read', (_$: any, e: any) => ({ value: seen.files[e.path] }))
  on('fs.write', (_$: any, e: any) => { seen.files[e.path] = e.text; return { value: undefined } })
  on('process.run', (_$: any, e: any) => {
    if (e.argv[0] === 'mv') {
      seen.files[e.argv[2]] = seen.files[e.argv[1]]
      delete seen.files[e.argv[1]]
    }
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.status', (_$: any, e: any) => { seen.status.push(e.text); return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('tool.register', (_$: any, e: any) => ({ value: { tool: `mcp__time-budget__${e.name}` } }))
  on('turn.abort', (_$: any, e: any) => { seen.aborted.push(e.turnId); return { value: undefined } })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.end', (_$: any, e: any) => ({ sessionId: e.sessionId }))
  on('prompt.submit', (_$: any, e: any) => { seen.prompts.push(e.text); return { text: e.text, context: e.context } })
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
const estimate = ($: any, minutes: number, agentId?: string, task?: string) =>
  call($, TOOL.estimate, { minutes, scope: 'the task', steps: ['a', 'b'], ...(agentId ? { agentId } : {}), ...(task ? { task } : {}) })
const report = ($: any, done: number, open: number, agentId?: string, moreMin?: number) => call($, TOOL.report, {
  done: Array.from({ length: done }, (_, i) => ({ item: `d${i}`, check: 'test' })),
  open: Array.from({ length: open }, (_, i) => ({ item: `o${i}`, next: 'do it' })),
  ...(agentId ? { agentId } : {}),
  ...(moreMin === undefined ? {} : { more_min: moreMin }),
})
const denied = (r: any) => r.deny ?? (r.isError ? r.text : undefined)
const ABOVE_PROMPT_PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isWorking: false, maxRows: 5, bodyColumns: 80, scroll: { offset: 0, bodyRows: 5 }, view: {},
}
const onlyIssue = (seen: ReturnType<typeof world>['seen']) => {
  const entries = Object.entries(seen.clm)
  if (entries.length !== 1) throw new Error(`expected one clm issue, found ${entries.length}`)
  const entry = entries[0]
  if (!entry) throw new Error('expected one clm issue entry')
  return entry[1]
}

const CAL = '/home/t/.local/share/claude-time-budget/calibration.jsonl'
const pairs = (seen: { files: Record<string, string> }) => (seen.files[CAL] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))

// Regression: a main turn with no doing clm issue remains ungated until estimate opens one.
test('main tools remain ungated until an estimate opens a clm task', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  expect((await call($, 'Bash', { command: 'ls' })).result).toBe('ran')
  await estimate($, 30)
  expect(seen.ran).toEqual(['Bash'])
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
test("a subagent's Budget line opens its own unit without an estimate call", async ($, on) => {
  world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  const unbudgeted = await $.agent.spawn({ tool_use_id: 'tu0', prompt: 'work', description: 'ag0', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as any)
  expect(unbudgeted.agentId).toBe('ag0')
  expect(denied(await call($, 'Read', { file_path: '/x', agentId: 'ag0' }))).toContain(TOOL.estimate)
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'Budget: 10 min\nwork', description: 'ag1', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as any)
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
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'Budget: 30 min\nwork', description: 'ag1', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as any)
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

// Regression: a report's requested extension appears as a button and recalculates the budget from the press time.
test('a projected halt +35m button updates the status budget', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 20)
  await clock.advance(10 * MIN + 1)
  expect((await report($, 2, 4, undefined, 35)).result).toContain('Stop here')
  const ui = await $.ui.mount({ plugin: 'time-budget', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT_PROPS })
  await ui.press({ key: 'time-budget:+35m' })
  expect(seen.status.at(-1)).toMatch(/budget 10\/45m/)
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
  expect(denied(await call($, 'Bash', { command: 'ls' }))).toContain('budget of 30 min is spent')
})

// Regression: pressing +20m on a halted unit re-arms its clock and resumes tool calls.
test('the +20m button extends a halted unit and submits a continuation', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(30 * MIN + 1)
  expect(denied(await call($, 'Bash', { command: 'ls' }))).toContain('budget of 30 min is spent')
  const ui = await $.ui.mount({ plugin: 'time-budget', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT_PROPS })
  await ui.press({ key: 'time-budget:+20m' })
  expect((await call($, 'Bash', { command: 'ls' })).result).toBe('ran')
  expect(seen.prompts.at(-1)).toBe('Continue this task.')
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
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'Budget: 15 min\nwork', description: 'ag1', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as any)
  await clock.advance(15 * MIN + 1)
  await clock.advance(GRACE_MS)
  const chunks: any[] = []
  const stream = $.turn.step({ turnId: 'ts', index: 3, model: 'm', messageCount: 4, agentId: 'ag1' })
  for await (const c of stream) chunks.push(c)
  expect(seen.steps).toBe(0)
  expect(chunks.find(c => c.kind === 'tool')?.name).toBe('SubagentHandback')
  expect(chunks.find(c => c.kind === 'input')?.json).toContain('Stopped by the time budget')
})

// Regression: changing the estimate does not replace the original calibration pair when the clm task closes.
test('a re-estimate can shrink a budget but calibration keeps the first estimate', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  const task = onlyIssue(seen).id
  expect((await estimate($, 10, undefined, task)).result).toContain('estimate 10 min')
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  onlyIssue(seen).status = 'done'
  await $.turn.complete({ answer: 'close', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as any)
  expect(pairs(seen)[0]).toMatchObject({ estimate_min: 30, budget_min: 15 })
})

// Regression: estimate without task opens a new clm task and closes the old calibration unit.
test('an estimate without task starts a new task', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(10 * MIN + 1)
  expect((await estimate($, 60)).result).toContain('Budget 60 min')
  expect(Object.keys(seen.clm)).toHaveLength(2)
  expect(pairs(seen)[0]).toMatchObject({ estimate_min: 30, actual_min: 10 })
})

test('a smaller re-estimate cannot bypass a report already due', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 30)
  await clock.advance(10 * MIN + 1)
  await report($, 1, 0)
  const task = onlyIssue(seen).id
  expect((await estimate($, 10, undefined, task)).result).toContain('estimate 10 min')
  expect(denied(await call($, 'Edit', { file_path: '/x' }))).toContain('Checkpoint 2/3')
})

// Regression: extending a halted main task cancels its old abort timer before re-arming grace.
test('a button extension cancels a pending main abort timer', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await estimate($, 15)
  await clock.advance(15 * MIN + 1)
  const ui = await $.ui.mount({ plugin: 'time-budget', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT_PROPS })
  await ui.press({ key: 'time-budget:+10m' })
  // Move past the old 17-minute abort point, then past the new 25-minute budget.
  await clock.advance(3 * MIN)
  expect(seen.aborted).toEqual([])
  await clock.advance(7 * MIN)
  await clock.advance(GRACE_MS - 1000)
  expect(seen.aborted).toEqual([])
  await clock.advance(1000)
  expect(seen.aborted).toEqual(['turn-1'])
})

// Regression: calibration actual excludes the idle gap after an extension button press.
test('calibration actual excludes the idle gap after an extension', async ($, on) => {
  const { seen, clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 10)
  await clock.advance(15 * MIN + 1)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  await clock.advance(60 * MIN)
  await report($, 1, 0, undefined, 5)
  const ui = await $.ui.mount({ plugin: 'time-budget', surface: 'terminal', component: 'AbovePrompt', props: ABOVE_PROMPT_PROPS })
  await ui.press({ key: 'time-budget:+5m' })
  await clock.advance(5 * MIN)
  await $.turn.complete({ answer: 'continued', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as any)
  onlyIssue(seen).status = 'done'
  await $.turn.complete({ answer: 'close', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' } as any)
  expect(pairs(seen)[0]?.actual_min).toBe(20)
})

// Regression: a grant resumes a stopped subagent and recalculates its budget from the grant time.
test('grant clears a stopped subagent report before resuming it', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 60)
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'Budget: 15 min\nwork', description: 'ag1', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as any)
  await clock.advance(11 * MIN)
  await report($, 1, 3, 'ag1')
  expect(denied(await call($, 'Read', { file_path: '/x', agentId: 'ag1' }))).toContain('Stop here')
  expect((await call($, TOOL.grant, { agent_id: 'ag1', minutes: 5 })).result).toContain('Granted +5 min from now')
  expect((await call($, 'Read', { file_path: '/x', agentId: 'ag1' })).result).toBe('ran')
})

// Regression: closing a clm task appends its pair without trimming calibration history.
test('calibration rewrites retain the full history beyond the factor window', async ($, on) => {
  const { seen } = world(on)
  seen.files[CAL] = `${Array.from({ length: 50 }, (_, i) => JSON.stringify({ kind: 'main', agent_type: null, estimate_min: 10, budget_min: 15, actual_min: 10, at: i })).join('\n')}\n`
  await start($)
  await prompt($, 'go')
  await estimate($, 20)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  onlyIssue(seen).status = 'done'
  await $.turn.complete({ answer: 'close', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as any)
  const logged = pairs(seen)
  expect(logged).toHaveLength(51)
  expect(logged[0]?.at).toBe(0)
  expect(Object.keys(seen.files).filter(path => path.includes('.tmp-'))).toEqual([])
})

test('a subagent cannot ask the user for time when re-estimating upward', async ($, on) => {
  world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 60)
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'Budget: 10 min\nwork', description: 'ag1', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm' } as any)
  const r = denied(await estimate($, 20, 'ag1'))
  expect(r).toContain(`Put more_min in your ${TOOL.report} call; main can grant time.`)
  expect(r).not.toContain('Ask the user')
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
  onlyIssue(seen).status = 'done'
  await $.turn.complete({ answer: 'close', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' } as any)
  const logged = pairs(seen)
  expect(logged.length).toBe(1)
  expect(logged[0]).toEqual({ kind: 'main', agent_type: null, estimate_min: 20, budget_min: 20, actual_min: 12, at: Math.floor((T0 + 12 * MIN) / 1000) })
})

// Regression: a clm issue reaching done closes its unit and appends exactly one calibration pair.
test('a done clm issue closes the main unit once', async ($, on) => {
  const { seen } = world(on)
  await start($)
  await prompt($, 'go')
  await estimate($, 20)
  onlyIssue(seen).status = 'done'
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as any)
  expect(pairs(seen)).toHaveLength(1)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' } as any)
  expect(pairs(seen)).toHaveLength(1)
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
