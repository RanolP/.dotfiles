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

// Regression: the dashboard was split into tabs and showed context fill, which clm already owns.
test('one pane stacks Usage, Fleet and Clm sections with no tabs and no context line', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  const status: Awaited<ReturnType<Engine['clm']['status']>> = {
    focus: { id: 's1-2', title: 'Focused task', status: 'doing' },
    stackDepth: 3,
    pending: [{ id: 's1-3', title: 'Pending task with a long title that should be clipped at the pane width' }],
    agents: [{ agentId: 'worker-agent-123456', taskId: 's1-4', title: 'Agent task', status: 'doing' }],
    later: [{ text: 'Later task' }],
    resumeRequest: { text: 'Resume task' },
    lastFoldAt: null,
    ledgerPath: '/tmp/clm-ledger.md',
    openIssues: 4,
  }
  on('engine.create', async (_$: any, e: any, next: any) => ({
    ...(await next(e)),
    clm: {
      track: () => { throw new Error('test clm.track base') },
      issues: () => { throw new Error('test clm.issues base') },
      resume: () => { throw new Error('test clm.resume base') },
      status: async () => status,
    },
  }))
  on('session.usage', () => ({ value: {
    startedAt: 0,
    context: { window: 100_000, tokens: 25_000, percent: 25 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-10-14T12:00:00Z' }],
    cost: { usd: 1.5 },
  } }))
  await start($)

  const ui = await mountPane($)
  for (const header of ['Usage', 'Fleet', 'Clm']) expect(await ui.find({ type: 'Text', text: header })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '5h 40% @12:00Z' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Cost $1.50' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Focus: Focused task (doing) · depth 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Pending: .+…/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Agents:' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'worker-a → Agent task (doing)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1. Later task' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Pending resume: Resume task' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Open issues: 4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Ledger: /tmp/clm-ledger.md' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Context/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
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
