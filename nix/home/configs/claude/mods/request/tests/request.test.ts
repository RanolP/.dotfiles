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
// `send` answers session.send; its hook must be registered before the first $ call.
async function start($: Engine, on: On, answer: string | undefined, send?: Send) {
  const asked: string[] = []
  const runs: { argv: readonly string[]; cwd?: string }[] = []
  const sends: { to: string; text: string }[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  let waiters: (() => void)[] = []
  // Resolves at the next ui.status the plugin sets; a walk sets one, at its end.
  const nextStatus = () => new Promise<void>(resolve => { waiters.push(resolve) })
  on('ui.status', async () => {
    const ready = waiters
    waiters = []
    for (const resolve of ready) resolve()
    return { value: undefined }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    if (answer === undefined) return { deny: 'dismissed' }
    const questions = e.questions.map(q => ({ ...q, header: q.header ?? '', multiSelect: q.multiSelect ?? false }))
    return { result: { questions, answers: { [question]: answer } } }
  })
  on('process.run', async (_$, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: { exitCode: 3, stdout: 'out', stderr: 'err', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  if (send) on('session.send', async (_$, e) => { sends.push({ to: e.to, text: e.text }); return send })
  const delivered = new Promise<string>(resolve => {
    on('prompt.submit', async (_$, e) => { resolve(e.text); return { text: e.text } })
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { asked, runs, sends, delivered, nextStatus }
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
  const { sends, nextStatus } = await start($, on, 'Approve and run', { isDelivered: true })
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
  const { delivered, nextStatus } = await start($, on, 'Approve and run', { isDelivered: false, reason: 'no such agent' })
  await $.tool.call({ tool: RAISE, ...INPUT, agentId: 'agent-7' })
  const walked = nextStatus()
  await $.command.run(APPROVALS)
  const text = await delivered
  await walked
  expect(text).toContain('Exit code: 3')
  expect(text).toContain('Relay this message to it')
})
