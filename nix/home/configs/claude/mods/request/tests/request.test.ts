import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, RenderViewport } from 'claude-code'

const RAISE = 'mcp__request__raise_approval_request'
// Quotes, a variable, a pipe, Markdown emphasis and a trailing space: anything a re-quoting, trimming or rendering step would change.
const COMMAND = `printf '%s\\n' "$HOME" *x* | grep -c "/" `
const INPUT = {
  command: COMMAND, cwd: '/tmp', why_only_way: 'only this reads it',
  alternatives: [{ approach: 'Read tool', rejected_because: 'not a file' }], blocks: 'the report',
}
const APPROVALS = { command: 'approvals', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
const APPROVE = 'Approve and run'
const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const ROOMY: RenderViewport = { columns: 120, rows: 40, isFullscreen: false }

type Send = { isDelivered: true } | { isDelivered: false; reason: string }
type Option = { label: string; description?: string; preview?: string }
type Question = { question: string; header?: string; options: Option[] }
const labels = (q: Question | undefined) => (q?.options ?? []).map(o => o.label)

// Nothing stands beneath the plugins in a test: these answer for the engine.
// `answer` answers every review dialog (a function sees which ask it is; undefined dismisses it, as Esc does).
// Each dialog is drawn first at `viewport` (none: drawn unmeasured; `false`: never drawn), as the engine draws
// it before the person can answer; `drawn` keeps the option labels each drawing showed, `shown` the options themselves,
// `questions` the question text it was given and `codes` the props of the Code element the drawing holds, if any.
// `afk` marks every answer as the dialog's idle auto-answer.
// `send` answers session.send (its hook must be registered before the first $ call);
// `hold` keeps every process.run from finishing until it resolves.
async function start($: Engine, on: On, answer: string | undefined | ((n: number) => Promise<string | undefined>), opts: {
  send?: Send; hold?: Promise<void>; viewport?: RenderViewport | null | false; afk?: boolean
} = {}) {
  const { send, hold, viewport = ROOMY, afk = false } = opts
  const asked: Question[] = []
  const drawn: string[][] = []
  const shown: Option[][] = []
  const questions: string[] = []
  const codes: (Record<string, unknown> | undefined)[] = []
  const runs: { argv: readonly string[]; cwd?: string }[] = []
  const sends: { to: string; text: string }[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  let waiters: (() => void)[] = []
  // Resolves when a review walk ends: the walk logs that line last.
  const nextStatus = () => new Promise<void>(resolve => { waiters.push(resolve) })
  on('ui.log', async (_$, e) => {
    if (e.text.includes('review ended')) {
      const ready = waiters
      waiters = []
      for (const resolve of ready) resolve()
    }
    return { value: undefined }
  })
  // The bands beneath this mod's: another mod's row (ask-later's).
  on('ui.render', { component: 'AbovePrompt' }, async ($$, e) => {
    const { Box, Text } = $$.ui.resolve(e)
    return Box({ key: 'other-band', children: Text({ children: 'Q1 pending' }) })
  })
  // The engine's dialog: records the options it was given to draw, then answers with the engine's own drawing.
  on('ui.render', { component: 'AskUserQuestion' }, async (_$, e) => {
    const q = e.props.questions[0] as Question
    drawn.push(labels(q))
    shown.push(q.options)
    questions.push(q.question)
    return { type: 'engine', ref: 0 }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const q = e.questions[0] as Question
    asked.push(q)
    const n = asked.length
    if (viewport !== false) {
      const props = { tool: 'AskUserQuestion', questions: e.questions as unknown[] }
      const ui = await $.ui.mount({ plugin: 'request', surface: 'terminal', component: 'AskUserQuestion', props, requestId: e.tool_use_id, ...(viewport ? { viewport } : {}) })
      await ui.drawn()
      codes.push((await ui.find({ type: 'Code' }))?.props)
    }
    const text = typeof answer === 'function' ? await answer(n) : answer
    if (text === undefined) return { deny: 'dismissed' }
    const questions = e.questions.map(x => ({ ...x, header: x.header ?? '', multiSelect: x.multiSelect ?? false }))
    return { result: { questions, answers: { [q.question]: text }, ...(afk ? { afkTimeoutMs: 60_000 } : {}) } }
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
  return { asked, drawn, shown, questions, codes, runs, sends, submits, delivered, nextStatus }
}

// Raises one request and resolves once the review it opened has ended.
const raise = async ($: Engine, nextStatus: () => Promise<void>, input: Record<string, unknown> = {}) => {
  const walked = nextStatus()
  const r = await $.tool.call({ tool: RAISE, ...INPUT, ...input })
  await walked
  return r
}

// Regression: the command that runs differing from the one the user approved (re-quoted, trimmed, rebuilt, rendered),
// or the review needing /approvals instead of opening when the request is raised.
test('raising opens the review at once and runs the shown string byte for byte', async ($, on) => {
  const { asked, drawn, runs, delivered, nextStatus } = await start($, on, APPROVE)
  expect(String((await raise($, nextStatus)).text)).toContain('R1 was approved')
  const text = await delivered
  expect(asked).toHaveLength(1)
  expect(asked[0]?.header).toBe('R1')
  // Approve first as the primary choice; Esc, not an option, keeps it pending.
  expect(labels(asked[0])).toEqual([APPROVE, 'Deny'])
  expect(drawn).toEqual([[APPROVE, 'Deny']])
  // The command sits in the question, each line indented, with no side panel.
  expect(asked[0]?.question).toBe([
    'In /tmp, the main session asks to run:', `    ${COMMAND}`, '',
    'Why: only this reads it', 'Not: Read tool — not a file', 'Unblocks: the report', 'Run this command once?',
  ].join('\n'))
  expect(asked[0]?.options.some(o => o.preview !== undefined)).toBe(false)
  expect(runs).toEqual([{ argv: ['bash', '-c', COMMAND], cwd: '/tmp' }])
  expect(text).toContain('Exit code: 3')
  expect(text).toContain('stdout:\nout')
  expect(text).toContain('stderr:\nerr')
})

// Regression: one approval executing the command again on a later review.
test('an approval is single-use', async ($, on) => {
  const { runs, delivered, nextStatus } = await start($, on, APPROVE)
  await raise($, nextStatus)
  await delivered
  const again = await $.command.run(APPROVALS)
  expect(String(again.text)).toContain('no pending approval requests')
  expect(runs).toHaveLength(1)
})

// Regression: a rejection still running the command, losing the user's reason, or reaching the model twice.
test('text under Other denies with that reason and runs nothing', async ($, on) => {
  const { runs, submits, nextStatus } = await start($, on, 'too risky on prod')
  // The rejection answers the raise itself, as AskUserQuestion's answer would, and is not sent again.
  const text = String((await raise($, nextStatus)).text)
  expect(runs).toEqual([])
  expect(text).toContain('REJECTED it: too risky on prod')
  expect(submits).toEqual([])
})

// Regression: Esc or the dialog's idle auto-answer counting as a decision instead of leaving the request
// pending in the band, from where Review opens it again.
for (const [name, answer, afk] of [['Esc', undefined, false], ['a blank answer', '', false], ['an idle Approve', APPROVE, true], ['an idle Deny', 'Deny', true]] as const) {
  test(`${name} keeps the request pending, and Review reopens it`, async ($, on) => {
    const { asked, runs, nextStatus } = await start($, on, answer, { afk })
    await raise($, nextStatus)
    expect(runs).toEqual([])
    const band = await $.ui.mount({ plugin: 'request', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    const walked = nextStatus()
    await band.press({ key: 'review' })
    await walked
    expect(asked).toHaveLength(2)
    // Reopened from the band, the dialog still carries the review.
    expect(asked[1]?.question).toContain(`\n    ${COMMAND}\n`)
    expect(runs).toEqual([])
    expect(await band.find({ key: 'review' })).toBeDefined()
  })
}

// Regression: a second request lost, or decided by the first one's answer, while the first dialog is open.
test('a request raised while a review is open gets its own dialog and decision', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const { asked, runs } = await start($, on, async n => {
    if (n === 1) await gate
    return n === 1 ? undefined : 'Deny'
  })
  const first = $.tool.call({ tool: RAISE, ...INPUT })
  for (let i = 0; i < 1_000 && !asked.length; i++) await Promise.resolve()
  const second = await $.tool.call({ tool: RAISE, ...INPUT, command: 'echo second' })
  expect(String(second.text)).toContain('REJECTED')
  expect(asked.map(q => q.header)).toEqual(['R1', 'R2'])
  expect(asked[1]?.question).toContain('\n    echo second\n')
  release()
  expect(String((await first).text)).toContain('R1 is waiting')
  expect(runs).toEqual([])
  expect(String((await $.command.run(APPROVALS)).text)).toContain('1 pending approval request')
})

// Regression: Approve counted for a command the dialog cannot show whole, or from a dialog never drawn with it.
// The engine refuses a drawing that drops an option, so Approve stays listed and its description says why it is out.
const TALL = Array.from({ length: 30 }, (_, i) => `echo line ${i}`).join('\n')
for (const [name, viewport] of [['too short a window', { columns: 120, rows: 20 }], ['an unmeasured surface', null], ['no drawing', false]] as const) {
  test(`Approve is not offered or counted with ${name}`, async ($, on) => {
    const { drawn, shown, runs, nextStatus } = await start($, on, APPROVE, { viewport })
    await raise($, nextStatus, { command: TALL })
    if (viewport !== false) {
      expect(drawn).toEqual([[APPROVE, 'Deny']])
      expect(shown[0]?.[0]?.description).toStartWith('Unavailable, runs nothing:')
    }
    expect(runs).toEqual([])
    expect(String((await $.command.run(APPROVALS)).text)).toContain('1 pending approval request')
  })
}

// Regression: Approve counted for a review the engine cuts at its question length cap, however tall the window.
test('Approve is not counted for a review longer than the dialog draws', async ($, on) => {
  const { shown, runs, nextStatus } = await start($, on, APPROVE, { viewport: { columns: 400, rows: 400, isFullscreen: false } })
  await raise($, nextStatus, { command: `echo ${'x'.repeat(2_100)}` })
  expect(shown[0]?.[0]?.description).toStartWith('Unavailable, runs nothing:')
  expect(runs).toEqual([])
})

// Regression: a tab drawn as a space, or a bidi mark reordering what is shown, so the dialog differs from what runs;
// or prose the model wrote passing for a line of the command.
test('a command the dialog would redraw is shown JSON-escaped, and prose stays on labelled lines', async ($, on) => {
  const { asked, runs, nextStatus } = await start($, on, APPROVE)
  const command = 'printf "a\tb" # \u202e\\u202e'
  await raise($, nextStatus, { command, why_only_way: 'two\n    rm -rf /' })
  const question = asked[0]?.question ?? ''
  expect(question).toContain('\n    "printf \\"a\\tb\\" # \\u202e\\\\u202e"\n')
  expect(question).not.toMatch(/[\t\u202e]/)
  expect(question).toContain('\nWhy: two rm -rf /\n')
  expect(runs).toEqual([{ argv: ['bash', '-c', command], cwd: '/tmp' }])
})

// Regression: the requested command drawn as plain text instead of highlighted as bash, drawn twice (highlighted
// and again in the question), or a hidden character reaching the highlighter instead of its escaped spelling.
for (const [name, command, source] of [
  ['a plain command', COMMAND, COMMAND],
  ['a command with a tab and a bidi mark', 'printf "a\tb" # \u202e', '"printf \\"a\\tb\\" # \\u202e"'],
] as const) {
  test(`${name} is drawn as highlighted bash above a question that no longer repeats it`, async ($, on) => {
    const { asked, questions, codes, nextStatus } = await start($, on, APPROVE)
    await raise($, nextStatus, { command })
    expect(codes[0]).toMatchObject({ language: 'bash', source })
    expect(questions[0]).toStartWith('In /tmp, the main session asks to run the command above:')
    expect(questions[0]).not.toContain(source)
    expect(questions[0]).toEndWith('Unblocks: the report\nRun this command once?')
    // The asked question keeps the command, for the engine's own drawing should it refuse the tree.
    expect(asked[0]?.question).toContain(`\n    ${source}\n`)
  })
}

// Regression: this mod rewriting an AskUserQuestion dialog the model opened.
test("another caller's AskUserQuestion dialog is drawn untouched", async ($, on) => {
  const { drawn } = await start($, on, undefined)
  const questions = [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: APPROVE, description: 'a' }, { label: 'B', description: 'b' }] }]
  const ui = await $.ui.mount({ plugin: 'request', surface: 'terminal', component: 'AskUserQuestion', props: { tool: 'AskUserQuestion', questions }, viewport: { columns: 40, rows: 5 } })
  await ui.drawn()
  expect(drawn).toEqual([[APPROVE, 'B']])
})

// Regression: a request missing its justification being queued for review anyway.
test('a request without rejected alternatives is refused', async ($, on) => {
  const { asked } = await start($, on, APPROVE)
  const r = await $.tool.call({ tool: RAISE, ...INPUT, alternatives: [] })
  expect(r.isError).toBe(true)
  expect(asked).toEqual([])
})

// Regression: a relative cwd resolving against whatever directory the session happens to be in.
test('a relative cwd is refused and nothing runs', async ($, on) => {
  const { runs, asked } = await start($, on, APPROVE)
  const r = await $.tool.call({ tool: RAISE, ...INPUT, cwd: 'tmp' })
  expect(r.isError).toBe(true)
  expect(String((await $.command.run(APPROVALS)).text)).toContain('no pending approval requests')
  expect(runs).toEqual([])
  expect(asked).toEqual([])
})

// Regression: a subagent's outcome landing in main's conversation while the subagent that raised it waits forever.
test("a subagent's outcome is sent to that subagent", async ($, on) => {
  const { sends, nextStatus } = await start($, on, APPROVE, { send: { isDelivered: true } })
  await raise($, nextStatus, { agentId: 'agent-7' })
  for (let i = 0; i < 10_000 && !sends.length; i++) await Promise.resolve()
  expect(sends).toHaveLength(1)
  expect(sends[0]?.to).toContain('agent-7')
  expect(sends[0]?.text).toContain('Exit code: 3')
})

// Regression: an outcome for an unreachable subagent being dropped instead of handed to main to relay.
test('an undeliverable subagent outcome falls back to main with a relay note', async ($, on) => {
  const { delivered, nextStatus } = await start($, on, APPROVE, { send: { isDelivered: false, reason: 'no such agent' } })
  await raise($, nextStatus, { agentId: 'agent-7' })
  const text = await delivered
  expect(text).toContain('Exit code: 3')
  expect(text).toContain('Relay this message to it')
})

// Regression: a session.start mid-run (a /clear) settled the live run as interrupted and dropped its real
// result, or a run was re-run or reported twice. The kit cannot reload a module or seed its state, so a
// genuine orphan (a running entry no live module instance owns) is not reachable here.
test('a session.start mid-run keeps the live run and reports its real outcome once', async ($, on) => {
  let release = () => {}
  const hold = new Promise<void>(resolve => { release = resolve })
  const { runs, submits, delivered } = await start($, on, APPROVE, { hold })
  await $.tool.call({ tool: RAISE, ...INPUT })
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

// Regression: the band showing with nothing to review (a stale nag), missing while a request waits, or hiding
// the row of a mod drawn beneath it (ask-later's).
test('the band shows only while a request is pending and keeps the row beneath it', async ($, on) => {
  const { nextStatus } = await start($, on, undefined)
  const bandOn = async (surface: 'terminal' | 'desktop', hasSurvey = false) => {
    const band = await $.ui.mount({ plugin: 'request', surface, component: 'AbovePrompt', props: { ...BAND_PROPS, hasSurvey } })
    const found = {
      review: await band.find({ key: 'review' }) !== undefined,
      preview: await band.find({ type: 'Text', text: /^R1 printf/ }) !== undefined,
      beneath: await band.find({ key: 'other-band' }) !== undefined,
    }
    await band.unmount()
    return found
  }
  for (const surface of ['terminal', 'desktop'] as const) expect(await bandOn(surface)).toEqual({ review: false, preview: false, beneath: true })
  await raise($, nextStatus)
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await bandOn(surface)).toEqual({ review: true, preview: true, beneath: true })
    expect((await bandOn(surface, true)).review).toBe(false)
  }
})
