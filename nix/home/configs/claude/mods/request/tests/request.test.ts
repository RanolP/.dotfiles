import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const RAISE = 'mcp__request__raise_approval_request'
// Quotes, a variable, a pipe, Markdown emphasis and a trailing space: anything a re-quoting, trimming or rendering step would change.
const COMMAND = `printf '%s\\n' "$HOME" *x* | grep -c "/" `
const INPUT = {
  command: COMMAND, cwd: '/tmp', why_only_way: 'only this reads it',
  alternatives: [{ approach: 'Read tool', rejected_because: 'not a file' }], blocks: 'the report',
}
const APPROVALS = { command: 'approvals', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

type Send = { isDelivered: true } | { isDelivered: false; reason: string }

// Nothing stands beneath the plugins in a test: these answer for the engine.
// `send` answers session.send (its hook must be registered before the first $ call);
// `hold` keeps every process.run from finishing until it resolves.
// `placed` says whether a surface seats the approvals pane; unplaced, /approvals walks the dialog.
async function start($: Engine, on: On, answer: string | undefined, opts: { send?: Send; hold?: Promise<void>; placed?: boolean } = {}) {
  const { send, hold, placed = false } = opts
  const asked: string[] = []
  const runs: { argv: readonly string[]; cwd?: string }[] = []
  const sends: { to: string; text: string }[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  let waiters: (() => void)[] = []
  // Resolves when an /approvals walk ends: the walk logs that line last.
  const nextStatus = () => new Promise<void>(resolve => { waiters.push(resolve) })
  on('ui.log', async (_$, e) => {
    if (e.text.includes('/approvals walk ended')) {
      const ready = waiters
      waiters = []
      for (const resolve of ready) resolve()
    }
    return { value: undefined }
  })
  const opened: string[] = []
  const closed: string[] = []
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: placed ? { isPlaced: true as const } : { isPlaced: false as const, reason: 'no surface places panes in this test' } }
  })
  on('ui.close', async (_$, e) => { closed.push(e.id); return { value: undefined } })
  // The engine draws nothing of its own in the band: an empty Box stands for that.
  on('ui.render', { component: 'AbovePrompt' }, async ($$, e) => $$.ui.resolve(e).Box({}))
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    if (answer === undefined) return { deny: 'dismissed' }
    const questions = e.questions.map(q => ({ ...q, header: q.header ?? '', multiSelect: q.multiSelect ?? false }))
    return { result: { questions, answers: { [question]: answer } } }
  })
  on('process.run', async (_$, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    if (hold) await hold
    return { value: { exitCode: 3, stdout: 'out', stderr: 'err', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  if (send) on('session.send', async (_$, e) => { sends.push({ to: e.to, text: e.text }); return send })
  const submits: string[] = []
  const delivered = new Promise<string>(resolve => {
    on('prompt.submit', async (_$, e) => { submits.push(e.text); resolve(e.text); return { text: e.text } })
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { asked, runs, sends, submits, delivered, nextStatus, opened, closed }
}

// Regression: the command that runs differing from the one the user approved (re-quoted, trimmed, rebuilt, rendered).
test('the executed string is byte-identical to the displayed one', async ($, on) => {
  const { asked, runs, delivered, nextStatus } = await start($, on, 'Approve and run')
  expect(String((await $.tool.call({ tool: RAISE, ...INPUT })).text)).toContain('R1 queued')
  const walked = nextStatus()
  await $.command.run(APPROVALS)
  const text = await delivered
  await walked
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain(`\`\`\`\n${COMMAND}\n\`\`\``)
  expect(runs).toEqual([{ argv: ['bash', '-c', COMMAND], cwd: '/tmp' }])
  expect(text).toContain('Exit code: 3')
  expect(text).toContain('stdout:\nout')
  expect(text).toContain('stderr:\nerr')
})

// Regression: one approval executing the command again on a later /approvals walk.
test('an approval is single-use', async ($, on) => {
  const { runs, delivered, nextStatus } = await start($, on, 'Approve and run')
  await $.tool.call({ tool: RAISE, ...INPUT })
  const walked = nextStatus()
  await $.command.run(APPROVALS)
  await delivered
  await walked
  const again = await $.command.run(APPROVALS)
  expect(String(again.text)).toContain('no pending approval requests')
  expect(runs).toHaveLength(1)
})

// Regression: a rejection still running the command, or losing the user's reason.
test('a rejection runs nothing and delivers the reason', async ($, on) => {
  const { runs, delivered, nextStatus } = await start($, on, 'too risky on prod')
  await $.tool.call({ tool: RAISE, ...INPUT })
  const walked = nextStatus()
  await $.command.run(APPROVALS)
  const text = await delivered
  await walked
  expect(runs).toEqual([])
  expect(text).toContain('REJECTED it: too risky on prod')
})

// Regression: Esc on the review dialog counting as a decision instead of leaving the request pending.
test('a dismissed review leaves the request pending and runs nothing', async ($, on) => {
  const { asked, runs, nextStatus } = await start($, on, undefined)
  await $.tool.call({ tool: RAISE, ...INPUT })
  const walked = nextStatus()
  await $.command.run(APPROVALS)
  await walked
  const walkedAgain = nextStatus()
  const again = await $.command.run(APPROVALS)
  await walkedAgain
  expect(String(again.text)).toContain('1 pending approval request')
  expect(runs).toEqual([])
  expect(asked).toHaveLength(2)
})

// Regression: a request missing its justification being queued for review anyway.
test('a request without rejected alternatives is refused', async ($, on) => {
  await start($, on, 'Approve and run')
  const r = await $.tool.call({ tool: RAISE, ...INPUT, alternatives: [] })
  expect(r.isError).toBe(true)
})

// Regression: a relative cwd resolving against whatever directory the session happens to be in.
test('a relative cwd is refused and nothing runs', async ($, on) => {
  const { runs } = await start($, on, 'Approve and run')
  const r = await $.tool.call({ tool: RAISE, ...INPUT, cwd: 'tmp' })
  expect(r.isError).toBe(true)
  expect(String((await $.command.run(APPROVALS)).text)).toContain('no pending approval requests')
  expect(runs).toEqual([])
})

// Regression: a subagent's outcome landing in main's conversation while the subagent that raised it waits forever.
test("a subagent's outcome is sent to that subagent", async ($, on) => {
  const { sends, nextStatus } = await start($, on, 'Approve and run', { send: { isDelivered: true } })
  await $.tool.call({ tool: RAISE, ...INPUT, agentId: 'agent-7' })
  const walked = nextStatus()
  await $.command.run(APPROVALS)
  await walked
  expect(sends).toHaveLength(1)
  expect(sends[0]?.to).toContain('agent-7')
  expect(sends[0]?.text).toContain('Exit code: 3')
})

// Regression: an outcome for an unreachable subagent being dropped instead of handed to main to relay.
test('an undeliverable subagent outcome falls back to main with a relay note', async ($, on) => {
  const { delivered, nextStatus } = await start($, on, 'Approve and run', { send: { isDelivered: false, reason: 'no such agent' } })
  await $.tool.call({ tool: RAISE, ...INPUT, agentId: 'agent-7' })
  const walked = nextStatus()
  await $.command.run(APPROVALS)
  const text = await delivered
  await walked
  expect(text).toContain('Exit code: 3')
  expect(text).toContain('Relay this message to it')
})

// Regression: a session.start mid-run (a /clear) settled the live run as interrupted and dropped its real
// result, or a run was re-run or reported twice. The kit cannot reload a module or seed its state, so a
// genuine orphan (a running entry no live module instance owns) is not reachable here.
test('a session.start mid-run keeps the live run and reports its real outcome once', async ($, on) => {
  let release = () => {}
  const hold = new Promise<void>(resolve => { release = resolve })
  const { runs, submits, delivered } = await start($, on, 'Approve and run', { hold })
  await $.tool.call({ tool: RAISE, ...INPUT })
  void $.command.run(APPROVALS)
  for (let i = 0; i < 10_000 && !runs.length; i++) await Promise.resolve()
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 1_000; i++) await Promise.resolve()
  expect(submits).toHaveLength(0)
  release()
  const text = await delivered
  expect(text).toContain('Exit code: 3')
  expect(text).not.toContain('interrupted')
  // The walk ends on its own schedule; /approvals answers "already open" until it has.
  let again = ''
  for (let i = 0; i < 200 && !again.includes('no pending'); i++) {
    again = String((await $.command.run(APPROVALS)).text)
  }
  expect(again).toContain('no pending approval requests')
  expect(runs).toHaveLength(1)
  expect(submits).toHaveLength(1)
})

const bandProps = (hasSurvey = false) => ({
  hasSurvey, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {},
})
const PANE_PROPS = { title: 'Approvals', isFocused: true, bodyColumns: 100, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} }

// Regression: the band showing with nothing to review (a stale nag), or missing while a request waits.
test('the band shows only while a request is pending', async ($, on) => {
  const { delivered } = await start($, on, 'too risky')
  const reviewOn = async (surface: 'terminal' | 'desktop', hasSurvey = false) => {
    const band = await $.ui.mount({ plugin: 'request', surface, component: 'AbovePrompt', props: bandProps(hasSurvey) })
    const found = await band.find({ key: 'review' })
    const preview = await band.find({ type: 'Text', text: /^R1 printf/ })
    await band.unmount()
    return found !== undefined && preview !== undefined
  }
  for (const surface of ['terminal', 'desktop'] as const) expect(await reviewOn(surface)).toBe(false)
  await $.tool.call({ tool: RAISE, ...INPUT })
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await reviewOn(surface)).toBe(true)
    expect(await reviewOn(surface, true)).toBe(false)
  }
  await $.command.run(APPROVALS)
  await delivered
  for (const surface of ['terminal', 'desktop'] as const) expect(await reviewOn(surface)).toBe(false)
})

// Regression: the pane approving a command other than the one it shows, or approving it twice.
test('Review opens the pane, which runs the shown command once and closes', async ($, on) => {
  const { runs, delivered, opened, closed } = await start($, on, undefined, { placed: true })
  await $.tool.call({ tool: RAISE, ...INPUT })
  const band = await $.ui.mount({ plugin: 'request', surface: 'terminal', component: 'AbovePrompt', props: bandProps() })
  await band.press({ key: 'review' })
  expect(opened).toEqual(['approvals'])
  const pane = await $.ui.mount({ plugin: 'request', surface: 'terminal', component: 'Pane', requestId: 'approvals', props: PANE_PROPS })
  expect((await pane.find({ type: 'Code' }))?.props.source).toBe(COMMAND)
  await pane.press({ key: 'approve' })
  const text = await delivered
  expect(runs).toEqual([{ argv: ['bash', '-c', COMMAND], cwd: '/tmp' }])
  expect(text).toContain('Exit code: 3')
  expect(closed).toEqual(['approvals'])
  expect(await pane.find({ key: 'approve' })).toBeUndefined()
  expect(String((await $.command.run(APPROVALS)).text)).toContain('no pending approval requests')
  expect(runs).toHaveLength(1)
})

// Regression: Next showing the same request, or Deny in the pane running anything or losing the reason.
test('the pane steps between requests and denies with a reason', async ($, on) => {
  const { runs, delivered } = await start($, on, undefined, { placed: true })
  await $.tool.call({ tool: RAISE, ...INPUT })
  await $.tool.call({ tool: RAISE, ...INPUT, command: 'echo second' })
  const pane = await $.ui.mount({ plugin: 'request', surface: 'terminal', component: 'Pane', requestId: 'approvals', props: PANE_PROPS })
  expect((await pane.find({ type: 'Code' }))?.props.source).toBe(COMMAND)
  await pane.press({ key: 'next' })
  expect((await pane.find({ type: 'Code' }))?.props.source).toBe('echo second')
  await pane.input({ key: 'reason', text: 'not now' })
  const text = await delivered
  expect(text).toContain('echo second')
  expect(text).toContain('REJECTED it: not now')
  expect(runs).toEqual([])
  expect((await pane.find({ type: 'Code' }))?.props.source).toBe(COMMAND)
})

// Regression: /approvals falling back to the plain dialog while the pane could be shown.
test('/approvals opens the pane where one is placed, asking nothing', async ($, on) => {
  const { asked, runs, opened } = await start($, on, 'Approve and run', { placed: true })
  await $.tool.call({ tool: RAISE, ...INPUT })
  const r = await $.command.run(APPROVALS)
  expect(String(r.text)).toBe('1 pending approval request in the approvals pane.')
  expect(opened).toEqual(['approvals'])
  expect(asked).toEqual([])
  expect(runs).toEqual([])
})
