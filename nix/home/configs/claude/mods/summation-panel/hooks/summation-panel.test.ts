import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const S = 'ea702d7a-44ee-497b-9d83-ab020990c06e'
const HOME = '/home/me'
const CLM_PATH = `${HOME}/.claude-work/tracker/events/${S}.jsonl`
const WAYSEEKER_PATH = `${HOME}/.claude-work/plans/wayseeker-${S}.json`

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

const mountPane = ($: Engine, bodyColumns = 60) => $.ui.mount({
  plugin: 'summation-panel',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'summation-panel',
  props: {
    title: 'Summation',
    isFocused: true,
    bodyColumns,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
})

// Fixture lines in the shape clm's writeEvents appends (TrackerEvent in mods/clm/hooks/tracker.ts).
const origin = { session: S, repo: 'github.com/RanolP/.dotfiles', branch: 'main', cwd: '/home/me/.dotfiles' }
let seq = 0
const ev = (issue: string, fields: Record<string, unknown>) =>
  JSON.stringify({ ts: `2026-11-25T13:37:${String(++seq % 60).padStart(2, '0')}.000Z`, seq, origin, issue, ...fields })
const id = (n: number) => `${S.slice(0, 8)}-${n}`
const create = (n: number, title: string, status = 'doing') => ev(id(n), { op: 'create', title, status })
const focus = (stack: number[], pending: number[] = []) => ev(S, { op: 'focus', stack: stack.map(id), pending: pending.map(id), intent: 'continue' })
const log = (...lines: string[]) => `${lines.join('\n')}\n`

// The record wayseeker writes under "wayseeker:<session>:main" (StoredWayseeker in mods/wayseeker/hooks/render.ts).
const fact = (name: string, atom: string) => ({ kind: 'literal', negated: false, fact: { kind: 'fact', name, args: [{ kind: 'atom', name: atom }] } })
const utterance = (n: number, kind: 'want' | 'ask', name: string, atom: string) =>
  ({ id: n, speaker: 'user', kind, content: fact(name, atom), source: `@${n} user: ${kind}(${name}(${atom}))`, act: { kind, content: fact(name, atom) } })
const WAYSEEKER = JSON.stringify({
  [`next-address:${S}:main`]: 3,
  [`wayseeker:${S}:main`]: {
    utterances: [
      utterance(1, 'ask', 'have', 'wayseeker'),
      utterance(2, 'want', 'show', 'panel'),
      utterance(3, 'want', 'show', 'usage'),
      { id: 4, speaker: 'user', kind: 'reject', content: { kind: 'reference', id: 3 }, source: '@4 user: reject(@3)', act: { kind: 'reject', target: 3 } },
    ],
    decls: [{ kind: 'declaration', name: 'have', columns: ['feature'], key: ['feature'], gloss: '{feature}을 갖추고 있다' }],
    glosses: [],
    turns: [{ address: '@w1', firstId: 1 }],
  },
})

/** Answers the session id, HOME and the files the pane reads; returns the debug log lines and the file map to edit. */
const withFiles = (on: any, files: Record<string, string>, read?: (path: string) => Promise<string>) => {
  const logs: string[] = []
  on('session.id', () => ({ value: S }))
  on('env.get', () => ({ value: HOME }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', async (_$: any, e: any) => ({ value: read ? await read(e.path) : files[e.path] }))
  on('ui.log', (_$: any, e: any) => { logs.push(e.text); return { value: undefined } })
  return { logs, files }
}

const listAgents = (on: any, ids: string[]) => on('agent.list', () => ({ value: ids.map(id => ({ id, description: id, type: 'opus', status: 'running' })) }))

// Regression: every session start opened the pane, so subagents could create panes and main-session startup could take focus.
test('a main session start opens the pane without focus; a subagent session start does not', async ($, on) => {
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

  expect(opens).toEqual([{ id: 'summation-panel', title: 'Summation' }])
})

// Regression: an unasked open waits undrawn below 144 columns, so on a narrow terminal the pane never showed until the person's own prompt asked for it.
test('a prompt the person enters opens the pane in the main session; an sdk prompt and a subagent session do not', async ($, on) => {
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
  expect(opens).toEqual(['summation-panel'])
})

// Regression: closing the pane removed its only view until the next session.
test('a person closing the pane leaves it open', { plugins: [{
  name: 'close-summation',
  tier: 'prepend',
  register(on) {
    on('session.start', async ($, e, next) => {
      const started = await next(e)
      await $.ui.close({ id: 'summation-panel' })
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

// Regression: protecting the pane accidentally swallowed close events for every pane.
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

// Regression: an unload removed the pane permanently even though the main-session ticker kept running.
test('the main session ticker reopens the pane without focus after unload', async ($, on) => {
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
    { id: 'summation-panel', title: 'Summation' },
    { id: 'summation-panel', title: 'Summation' },
  ])
})

// Regression caught: the pane drew a closed issue as open, a rejected want as still wanted, or lost the clm focus.
test('the pane draws clm focus and open issues and wayseeker live wants and asks from the files other mods wrote', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  withFiles(on, {
    [CLM_PATH]: log(
      create(1, 'summation-panel 작성'), create(2, 'REUSE 등록', 'todo'), create(3, 'dash 제거'),
      ev(id(3), { op: 'status', status: 'done' }), ev(id(2), { op: 'retitle', title: 'REUSE.toml 등록' }),
      focus([1]), '{"torn',
    ),
    [WAYSEEKER_PATH]: WAYSEEKER,
  })
  await start($)

  const ui = await mountPane($, 80)
  expect(await ui.find({ type: 'Text', text: '▸ summation-panel 작성 · issues 2' })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /^  · / })).map(node => node.text)).toEqual(['  · doing summation-panel 작성', '  · todo REUSE.toml 등록'])
  expect(await ui.find({ type: 'Text', text: '▸ wayseeker · want 1 · ask 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  want  @2 user: want(show(panel))' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  ask  @1 user: ask(have(wayseeker))' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /show\(usage\)/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▸ resources: not tracked yet' })).toBeDefined()
})

// Regression caught: a missing or corrupt file blanked the pane or vanished without a trace in the debug log.
test('a missing clm log and an unreadable wayseeker file each show one line and log to debug once', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  const { logs } = withFiles(on, { [WAYSEEKER_PATH]: '{not json' })
  await start($)
  await clock.advance(15_000)

  const ui = await mountPane($, 200)
  expect(await ui.find({ type: 'Text', text: `▸ clm: no file at ${CLM_PATH}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`^▸ wayseeker: unreadable ${WAYSEEKER_PATH}: `) })).toBeDefined()
  expect(logs.filter(text => text.startsWith(`[summation-panel] clm: no file at ${CLM_PATH}`))).toHaveLength(1)
  expect(logs.filter(text => text.startsWith('[summation-panel] wayseeker: unreadable'))).toHaveLength(1)
})

// Regression: the pane was split into tabs, or a Usage or Work header row came back and wastes pane height.
test('one pane stacks Usage rows and the Work head line with no tabs and no header rows', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  withFiles(on, { [CLM_PATH]: log(
    create(1, 'Root'), create(2, 'Middle'), create(3, 'Focus'),
    create(4, 'Pending task with a long title that should be clipped at the pane width', 'todo'),
    focus([1, 2, 3], [4]),
  ) })
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
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
})

// Regression: a Usage or Work header row came back above the rows and wasted pane height.
test('neither a Usage nor a Work header row renders', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  withFiles(on, { [CLM_PATH]: log(focus([])) })
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^── (Usage|Work)/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^▸ no focus · issues 0$/ })).toBeDefined()
})

// Regression: a listed agent lost its status word when it had no task description.
test('an agent with no task description keeps its status word', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  listAgents(on, ['agent-1'])
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^  ● 0m {2}running$/ })).toBeDefined()
})

// Regression: a spawned agent's rows ignored running-first order, or kept every finished agent in view.
test('running agents come first and only the two newest finished agents stay', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  on('session.receive', (_$: any, e: any) => ({ text: e.text }))
  await start($)
  for (const agentId of ['old', 'middle', 'newest']) {
    await clock.advance(1_000)
    await $.turn.complete({ agentId, answer: `${agentId} finished` } as never)
  }
  await $.session.receive({ agentId: 'live', text: 'Working on it' } as never)

  const ui = await mountPane($, 80)
  const rows = (await ui.findAll({ type: 'Text', text: /^  [●✓] / })).map(node => node.text)
  expect(rows[0]).toMatch(/^  ● /)
  expect(rows.slice(1).every(row => row.startsWith('  ✓ '))).toBe(true)
  expect(rows).toHaveLength(3)
  expect(await ui.find({ type: 'Text', text: /old finished/ })).toBeUndefined()
})

// Regression: the issues counter moved off the head line into a separate row again.
test('the head line carries the issues counter', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-10-15T03:00:00Z') })
  on('session.start', () => ({ cwd: '/work' }))
  withFiles(on, { [CLM_PATH]: log(create(1, 'dash 디자인'), focus([1])) })
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '▸ dash 디자인 · issues 1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^(Pending|Agents|Resume|Ledger)/ })).toBeUndefined()
})

// Regression: while the clm file is loading the agents vanished along with it.
test('the head line falls back to Loading while the clm file is loading and agents still render', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  listAgents(on, ['agent-1'])
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  withFiles(on, { [CLM_PATH]: log(focus([])) }, async path => { await gate; return path === CLM_PATH ? log(focus([])) : '' })
  const started = start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '▸ Loading clm…' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^  ● 0m {2}running$/ })).toBeDefined()
  release()
  await started
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
  withFiles(on, { [CLM_PATH]: log(create(1, 'dash 디자인', 'uncertain'), focus([1])) })
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
  expect(await ui.find({ type: 'Text', text: '▸ dash 디자인 (uncertain) · issues 1' })).toBeDefined()
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

// Regression: the always-true doing label returned, or a non-doing status such as uncertain got hidden with it.
test('the head line hides a doing focus status but shows any other, re-read on the next tick', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }))
  const clock = mock.clock(on, { now: 1_000 })
  const { files } = withFiles(on, { [CLM_PATH]: log(create(1, 'dash 디자인'), focus([1])) })
  await start($)

  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: '▸ dash 디자인 · issues 1' })).toBeDefined()
  await ui.unmount()
  files[CLM_PATH] += log(ev(id(1), { op: 'status', status: 'uncertain' }))
  await clock.advance(15_000)
  const again = await mountPane($)
  expect(await again.find({ type: 'Text', text: '▸ dash 디자인 (uncertain) · issues 1' })).toBeDefined()
})

const BASELINE = '29096c9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const withDotfiles = (on: any, answer: { head?: string, count?: { exitCode: number, stdout: string, stderr: string } } = {}) => {
  const runs: string[][] = []
  let head = answer.head ?? BASELINE
  let count = answer.count ?? { exitCode: 0, stdout: '3\n', stderr: '' }
  const { logs } = withFiles(on, { [CLM_PATH]: log(focus([])) })
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
  const git = withDotfiles(on, { count: { exitCode: 128, stdout: '', stderr: 'fatal: bad revision\n' } })
  await start($)

  const ui = await mountPane($, 80)
  await ui.press({ key: 'refresh' })
  expect(await settle(() => ui.find({ type: 'Text', text: '▸ no focus · issues 0 · @29096c9 · behind ?' }))).toBeDefined()
  expect(git.logs).toContain(`[summation-panel] git -C /home/me/.dotfiles rev-list --count ${BASELINE}..HEAD: exit 128: fatal: bad revision`)
})

// Regression: a hot reload re-runs session.start, and re-taking the baseline there hid every commit made before the reload.
test('a second session.start keeps the first baseline', async ($, on) => {
  mock.clock(on, { now: 1_000 })
  on('session.start', () => ({ cwd: '/work' }))
  const git = withDotfiles(on)
  await start($)

  git.setHead('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  await start($)
  const ui = await mountPane($, 80)
  expect(await ui.find({ type: 'Text', text: '▸ no focus · issues 0 · @29096c9' })).toBeDefined()
})
