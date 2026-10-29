import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

const mountPane = ($: Engine, bodyColumns = 60) => $.ui.mount({
  plugin: 'dash',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'dash',
  props: {
    title: 'Dash',
    isFocused: true,
    bodyColumns,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
})

const emptyStatus: Awaited<ReturnType<Engine['clm']['status']>> = {
  focus: null, stackDepth: 1, pending: [], agents: [],
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
  expect(await ui.find({ type: 'Text', text: '▸ Focus · depth 3 · issues 4' })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /^▸ no focus · issues 0$/ })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /^  ● 0m {2}Paired task$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  ● 0m {2}running$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· agent-2/ })).toBeUndefined()
})

// Regression: the issues counter moved off the head line into a separate row again.
test('the head line carries the issues counter', async ($, on) => {
  const now = Date.parse('2026-10-15T03:00:00Z')
  mock.clock(on, { now })
  on('session.start', () => ({ cwd: '/work' }))
  withClm(on, async () => ({
    ...emptyStatus,
    focus: { id: 's1-1', title: 'dash 디자인', status: 'doing' },
    openIssues: 1, lastFoldAt: now - 3 * 60_000,
  }))
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '▸ dash 디자인 · issues 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^(Pending|Agents|Resume|Ledger)/ })).toBeUndefined()
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
  expect(await ui.find({ type: 'Text', text: /^  ● 0m {2}running$/ })).toBeDefined()
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
        stackDepth: 1, pending: [], agents: [],
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
  expect(await ui.find({ type: 'Text', text: '▸ dash 디자인 (active) · issues 1' })).toBeDefined()
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

// Regression: the cost, duration and edit-count summary came back into the Usage row.
test('the Usage row carries no used segment', async ($, on) => {
  const now = Date.parse('2026-10-15T03:00:00Z')
  mock.clock(on, { now })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.usage', () => ({ value: {
    startedAt: now - 72 * 60_000,
    context: { window: 200_000, tokens: 1, percent: 1 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 68, resetsAt: new Date(now + 133 * 60_000).toISOString() }],
    cost: { usd: 3.21 },
  } }))
  await start($)

  const ui = await mountPane($, 120)
  expect(await ui.find({ type: 'Text', text: '5h 68% \u{F0450} in 2h13m' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /used|\$3\.21|edits/ })).toBeUndefined()
})

// Regression: the fold age came back onto the Work head line.
test('the head line has no fold segment', async ($, on) => {
  const now = Date.parse('2026-10-15T03:00:00Z')
  mock.clock(on, { now })
  on('session.start', () => ({ cwd: '/work' }))
  withClm(on, async () => ({ ...emptyStatus, lastFoldAt: now - 3 * 60_000 }))
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^▸ no focus · issues 0$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /fold/ })).toBeUndefined()
})

// Regression: the always-true doing label returned, or a non-doing status such as uncertain got hidden with it.
test('the head line hides a doing focus status but shows any other', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }))
  let status: 'doing' | 'uncertain' = 'doing'
  const clock = mock.clock(on, { now: 1_000 })
  withClm(on, async () => ({ ...emptyStatus, focus: { id: 's1', title: 'dash 디자인', status } }))
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '▸ dash 디자인 · issues 0' })).toBeDefined()
  await ui.unmount()
  status = 'uncertain'
  await clock.advance(15_000)
  const again = await mountPane($)
  expect(await again.find({ type: 'Text', text: '▸ dash 디자인 (uncertain) · issues 0' })).toBeDefined()
})

const BASELINE = '29096c9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const withDotfiles = (on: any, answer: { head?: string, count?: { exitCode: number, stdout: string, stderr: string } } = {}) => {
  const runs: string[][] = []
  const logs: string[] = []
  let head = answer.head ?? BASELINE
  let count = answer.count ?? { exitCode: 0, stdout: '3\n', stderr: '' }
  on('env.get', () => ({ value: '/home/me' }))
  on('ui.log', (_$: any, e: any) => { logs.push(e.text); return { value: undefined } })
  on('process.run', (_$: any, e: any) => {
    runs.push([...e.argv])
    if (e.argv.includes('rev-parse')) return { value: { exitCode: 0, stdout: `${head}\n`, stderr: '' } }
    return { value: count }
  })
  return {
    runs, logs,
    setHead: (next: string) => { head = next },
    setCount: (next: typeof count) => { count = next },
  }
}

const settle = async (find: () => Promise<unknown>) => {
  for (let tries = 0; tries < 50 && !(await find()); tries++) await Promise.resolve()
  return find()
}

// Regression: the dotfiles version never showed, so a stale session could not be told apart from a fresh one.
test('the head line shows the start-time dotfiles HEAD and no behind part until refresh is pressed, even across ticks', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  withClm(on, async () => emptyStatus)
  const git = withDotfiles(on)
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true, agentId: 'agent-1' })
  expect(git.runs).toEqual([])
  await start($)

  await clock.advance(15_000)
  const ui = await mountPane($, 80)
  expect(await ui.find({ type: 'Text', text: '▸ no focus · issues 0 · @29096c9' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'refresh' })).toBeDefined()
  expect(git.runs).toEqual([['git', '-C', '/home/me/.dotfiles', 'rev-parse', 'HEAD']])
})

// Regression: pressing refresh did not count commits made since session start, or hid a zero count.
test('pressing refresh counts commits since the baseline and shows behind N, including 0', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  withClm(on, async () => emptyStatus)
  const git = withDotfiles(on)
  await start($)

  const ui = await mountPane($, 80)
  await ui.press({ key: 'refresh' })
  expect(await settle(() => ui.find({ type: 'Text', text: '▸ no focus · issues 0 · @29096c9 · behind 3' }))).toBeDefined()
  expect(git.runs.at(-1)).toEqual(['git', '-C', '/home/me/.dotfiles', 'rev-list', '--count', `${BASELINE}..HEAD`])
  await ui.unmount()

  // Regression: clipping the whole head line at the default width cut the version label first.
  const narrow = await mountPane($, 48)
  expect(await narrow.find({ type: 'Text', text: /^▸ no focus.*… · @29096c9 · behind 3$/ })).toBeDefined()
  await narrow.unmount()
  const again = await mountPane($, 80)

  git.setCount({ exitCode: 0, stdout: '0\n', stderr: '' })
  await again.press({ key: 'refresh' })
  expect(await settle(() => again.find({ type: 'Text', text: '▸ no focus · issues 0 · @29096c9 · behind 0' }))).toBeDefined()
})

// Regression: a failed count read as "not behind", or failed without a log naming the command, exit code and stderr.
test('a failed refresh shows behind ? and logs the command, exit code and stderr', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  withClm(on, async () => emptyStatus)
  const git = withDotfiles(on, { count: { exitCode: 128, stdout: '', stderr: 'fatal: bad revision\n' } })
  await start($)

  const ui = await mountPane($, 80)
  await ui.press({ key: 'refresh' })
  expect(await settle(() => ui.find({ type: 'Text', text: '▸ no focus · issues 0 · @29096c9 · behind ?' }))).toBeDefined()
  expect(git.logs).toContain(`[dash] git -C /home/me/.dotfiles rev-list --count ${BASELINE}..HEAD: exit 128: fatal: bad revision`)
})

// Regression: a hot reload re-runs session.start, and re-taking the baseline there hid every commit made before the reload.
test('a second session.start keeps the first baseline', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  withClm(on, async () => emptyStatus)
  const git = withDotfiles(on)
  await start($)

  git.setHead('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  await start($)
  const ui = await mountPane($, 80)
  expect(await ui.find({ type: 'Text', text: '▸ no focus · issues 0 · @29096c9' })).toBeDefined()
})

// Regression caught: clm dropped its later queue, and the head line threw on `status.later.length`.
test('a status object with no later field renders without throwing', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }))
  withClm(on, async () => ({ ...emptyStatus }))
  await start($)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '▸ no focus · issues 0' })).toBeDefined()
})
