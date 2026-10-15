import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

const mountPane = ($: Engine) => $.ui.mount({
  plugin: 'dash',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'dash',
  props: {
    title: 'Dash',
    isFocused: true,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
})

const emptyStatus: Awaited<ReturnType<Engine['clm']['status']>> = {
  focus: null, stackDepth: 1, pending: [], agents: [], later: [],
  resumeRequest: null, lastFoldAt: null, ledgerPath: '/tmp/l.md', openIssues: 0,
}

const listAgents = (on: any, ids: string[]) => on('agent.list', () => ({ value: ids.map(id => ({ id, description: id, type: 'opus', status: 'running' })) }))

const withClm = (on: any, status: () => Promise<Awaited<ReturnType<Engine['clm']['status']>>>) => on('engine.create', async (_$: any, e: any, next: any) => ({
  ...(await next(e)),
  clm: {
    track: () => { throw new Error('test clm.track base') },
    issues: () => { throw new Error('test clm.issues base') },
    resume: () => { throw new Error('test clm.resume base') },
    status,
  },
}))

// Regression: every session start opened dash, so subagents could create panes and main-session startup could take focus.
test('a main session start opens the dash pane without focus; a subagent session start does not', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  const opens: Array<{ id: string, title?: string, focus?: true }> = []
  on('ui.open', (_$, e) => {
    opens.push(e)
    return { value: { isPlaced: true } }
  })

  await start($)
  const subagentStart = { cwd: '/work', surface: 'terminal' as const, isInteractive: true, agentId: 'agent-1' }
  await $.session.start(subagentStart)

  expect(opens).toEqual([{ id: 'dash', title: 'Dash' }])
})

// Regression: an unasked open waits undrawn below 144 columns, so on a narrow terminal dash never showed until the person's own prompt asked for it.
test('a prompt the person enters opens dash in the main session; an sdk prompt and a subagent session do not', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  const opens: string[] = []
  on('ui.open', (_$, e) => { opens.push(e.id); return { value: { isPlaced: true } } })
  const submit = (origin: { kind: 'composer' } | { kind: 'sdk' }) => $.prompt.submit({ text: 'hi', wait: false, origin } as never)

  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true, agentId: 'agent-1' })
  await submit({ kind: 'composer' })
  expect(opens).toEqual([])

  await start($)
  opens.length = 0
  await submit({ kind: 'sdk' })
  expect(opens).toEqual([])
  await submit({ kind: 'composer' })
  expect(opens).toEqual(['dash'])
})

// Regression: closing dash removed its only view until the next session.
test('a person closing the dash pane leaves it open', { plugins: [{
  name: 'close-dash',
  tier: 'prepend',
  register(on) {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      await $.ui.close({ id: 'dash' })
      return started
    })
  },
}] }, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  let passedThrough = false
  on('ui.close', () => { passedThrough = true; return { value: undefined } })

  await start($)

  expect(passedThrough).toBe(false)
})

// Regression: protecting dash accidentally swallowed close events for every pane.
test("another pane's close still passes through", { plugins: [{
  name: 'close-notes',
  tier: 'prepend',
  register(on) {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      await $.ui.close({ id: 'notes' })
      return started
    })
  },
}] }, async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  const closes: string[] = []
  on('ui.close', (_$, e) => { closes.push(e.id); return { value: undefined } })

  await start($)

  expect(closes).toEqual(['notes'])
})

// Regression: an unload removed dash permanently even though the main-session ticker kept running.
test('the main session ticker reopens dash without focus after unload', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  const opens: Array<{ id: string, title?: string, focus?: true }> = []
  on('ui.open', (_$, e) => {
    opens.push(e)
    return { value: { isPlaced: true } }
  })

  await start($)
  await clock.advance(15_000)

  expect(opens).toEqual([
    { id: 'dash', title: 'Dash' },
    { id: 'dash', title: 'Dash' },
  ])
})

// Regression: the dashboard was split into tabs, or a Usage or Work header row came back and wastes pane height.
test('one pane stacks Usage rows and the Work head line with no tabs and no header rows', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  const status: Awaited<ReturnType<Engine['clm']['status']>> = {
    focus: { id: 's1-2', title: 'Focus', status: 'doing' },
    stackDepth: 3,
    pending: [{ id: 's1-3', title: 'Pending task with a long title that should be clipped at the pane width' }],
    agents: [{ agentId: 'worker-agent-123456', taskId: 's1-4', title: 'Agent task', status: 'doing' }],
    later: [{ text: 'Later task' }],
    resumeRequest: { text: 'Resume task' },
    lastFoldAt: null,
    ledgerPath: '/tmp/clm-ledger.md',
    openIssues: 4,
  }
  withClm(on, async () => status)
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: { window: 100_000, tokens: 25_000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(1_000 + 133 * 60_000).toISOString() }],
    cost: { usd: 1.5 },
  } }))
  await start($)

  const ui = await mountPane($)
  for (const removed of [/^── /, /^Focus /, /^Agents /, /^No subagents yet/]) expect(await ui.find({ type: 'Text', text: removed })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '5h 40% \u{F0450} in 2h13m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '$1.50 · 0m · +0 -0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▸ Focus (doing) · depth 3 · later 1 · issues 4 · fold never' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  Pending  .+…/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  Resume  Resume task' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  · worker-a Agent task (doing)' })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
})

// Regression: a Usage or Work header row came back above the rows and wasted pane height.
test('neither a Usage nor a Work header row renders', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  withClm(on, async () => emptyStatus)
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^── (Usage|Work)/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^▸ no focus · later 0 · issues 0 · fold never$/ })).toBeDefined()
})

// Regression: a paired agent kept printing running/done instead of its clm task title, or an unpaired agent lost its status word.
test('a paired agent shows its clm title in place of its status; an unpaired agent keeps the status word', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  void clock
  on('session.start', () => ({ cwd: '/work' }))
  listAgents(on, ['agent-1', 'agent-2'])
  withClm(on, async () => ({ ...emptyStatus, agents: [{ agentId: 'agent-2', taskId: 't1', title: 'Paired task', status: 'doing' }] }))
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^  ● opus 0m {2}Paired task$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  ● opus 0m {2}running$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· agent-2/ })).toBeUndefined()
})

// Regression: the later/issues/fold counters moved off the head line into a separate row again.
test('the head line carries later, issues and fold', async ($, on) => {
  const now = Date.parse('2026-10-15T03:00:00Z')
  mock.clock(on, { now })
  on('session.start', () => ({ cwd: '/work' }))
  withClm(on, async () => ({
    ...emptyStatus,
    focus: { id: 's1-1', title: 'dash 디자인', status: 'doing' },
    later: [{ text: 'a' }, { text: 'b' }], openIssues: 1, lastFoldAt: now - 3 * 60_000,
  }))
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '▸ dash 디자인 (doing) · later 2 · issues 1 · fold 3m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^(Later|Pending|Agents|Resume|Ledger)/ })).toBeUndefined()
})

// Regression: while clm is loading the agents vanished along with the clm status.
test('the head line falls back to Loading while clm is loading and agents still render', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  listAgents(on, ['agent-1'])
  let release = () => {}
  withClm(on, () => new Promise(resolve => { release = () => resolve(emptyStatus) }))
  const started = start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '▸ Loading clm status…' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  ● opus 0m {2}running$/ })).toBeDefined()
  release()
  await started
})

// Regression: clm status was fetched only when a Clm tab was pressed, so the unified pane stayed on "Loading".
test('session start fetches clm status, rendering a logged one-line error when clm is unavailable', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  const logs: string[] = []
  on('ui.log', (_$, e) => { logs.push(e.text); return { value: undefined } })
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /Loading clm status/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /clm is unavailable: .+/ })).toBeDefined()
  expect(logs.some(message => message.startsWith('[dash] clm.status:'))).toBe(true)
})

// Regression: the statusline's second line moved here, so the pane must show session duration and edited lines.
test('Usage shows session duration and lines tallied from Edit and Write results', async ($, on) => {
  mock.clock(on, { now: 601_000 })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.usage', () => ({ value: {
    startedAt: 1_000,
    context: { window: 200_000, tokens: 50_000, percent: 25 },
    rateLimits: [],
    cost: { usd: 1.5 },
  } }))
  const patch = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' keep', '-old', '+new', '+extra'] }]
  on('tool.call', (_$, e: any) => ({ result: e.tool === 'Edit'
    ? { structuredPatch: patch }
    : { type: 'create', content: 'a\nb\n', structuredPatch: [] } }) as never)
  await start($)
  await $.tool.call({ tool: 'Edit', file_path: '/work/a', old_string: 'old', new_string: 'new' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/work/b', content: 'a\nb\n' } as never)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^Ctx/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '$1.50 · 10m · +4 -1' })).toBeDefined()
})

// Regression: the compact layout drifted from the statusline's rate-limit rows, split the two limits across rows, brought back the Ctx row, or showed empty clm rows that waste pane height.
test('compact Usage joins both rate limits on one row with no Ctx row, and Work hides empty rows', async ($, on) => {
  const now = Date.parse('2026-10-15T03:00:00Z')
  mock.clock(on, { now })
  on('session.start', () => ({ cwd: '/work' }))
  const weeklyReset = new Date('2026-10-19T00:00:00Z')
  on('session.usage', () => ({ value: {
    startedAt: now - 72 * 60_000,
    context: { window: 200_000, tokens: 84_000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 67.6, resetsAt: new Date(now + 45 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 31, resetsAt: weeklyReset.toISOString() },
    ],
    cost: { usd: 3.21 },
  } }))
  on('engine.create', async (_$: any, e: any, next: any) => ({
    ...(await next(e)),
    clm: {
      track: () => { throw new Error('test clm.track base') },
      issues: () => { throw new Error('test clm.issues base') },
      resume: () => { throw new Error('test clm.resume base') },
      status: async () => ({
        focus: { id: 's1-1', title: 'dash 디자인', status: 'active' },
        stackDepth: 1, pending: [], agents: [], later: [{ text: 'a' }, { text: 'b' }],
        resumeRequest: null, lastFoldAt: now - 3 * 60_000, ledgerPath: '/tmp/l.md', openIssues: 1,
      }),
    },
  }))
  await start($)

  const ui = await mountPane($)
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weeklyReset.getDay()]
  const weekly = `weekly 31% \u{F0450} at ${weekday} ${weeklyReset.getHours()}:${String(weeklyReset.getMinutes()).padStart(2, '0')}`
  expect(await ui.find({ type: 'Text', text: `5h 68% \u{F0450} in 45m / ${weekly}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^5h 68% [^/]*$/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^ \/ $/ }))?.props.color).toBe('gray')
  expect((await ui.find({ type: 'Text', text: /^weekly $/ }))?.props.color).toBe('gray')
  expect((await ui.find({ type: 'Text', text: /^31%$/ }))?.props.color).toBe('whiteBright')
  expect(await ui.find({ type: 'Text', text: /^Ctx/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '$3.21 · 1h12m · +0 -0' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '▸ dash 디자인 (active) · later 2 · issues 1 · fold 3m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^(Pending|Agents|Resume|Ledger)/ })).toBeUndefined()
})

// Regression: a lone limit must not render a dangling separator.
test('Usage with only one rate limit shows that half alone, with no separator', async ($, on) => {
  const now = Date.parse('2026-10-15T03:00:00Z')
  mock.clock(on, { now })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.usage', () => ({ value: {
    startedAt: now,
    context: { window: 200_000, tokens: 84_000, percent: 42 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 68, resetsAt: new Date(now + 133 * 60_000).toISOString() }],
    cost: { usd: 3.21 },
  } }))
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '5h 68% \u{F0450} in 2h13m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / \/ / })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /weekly/ })).toBeUndefined()
})
