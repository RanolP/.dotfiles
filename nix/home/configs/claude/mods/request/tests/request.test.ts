import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const RAISE = 'mcp__request__raise_approval_request'
// Quotes, a variable, a pipe and a trailing space: anything a re-quoting or trimming step would change.
const COMMAND = `printf '%s\\n' "$HOME" | grep -c "/" `
const INPUT = {
  command: COMMAND, cwd: '/tmp', why_only_way: 'only this reads it',
  alternatives: [{ approach: 'Read tool', rejected_because: 'not a file' }], blocks: 'the report',
}
const APPROVALS = { command: 'approvals', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

// Nothing stands beneath the plugins in a test: these answer for the engine.
async function start($: Engine, on: On, answer: string | undefined) {
  const asked: string[] = []
  const runs: { argv: readonly string[]; cwd?: string }[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  let waiters: (() => void)[] = []
  // Resolves at the next ui.status the plugin sets; a walk's last one follows its last delivery.
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
    return { result: { questions: e.questions, answers: { [question]: answer } } } as never
  })
  on('process.run', async (_$, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: { exitCode: 3, stdout: 'out', stderr: 'err', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const delivered = new Promise<string>(resolve => {
    on('prompt.submit', async (_$, e) => { resolve(e.text); return { text: e.text } })
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { asked, runs, delivered, nextStatus }
}

// Regression: the command that runs differing from the one the user approved (re-quoted, trimmed, rebuilt).
test('the executed string is byte-identical to the displayed one', async ($, on) => {
  const { asked, runs, delivered, nextStatus } = await start($, on, 'Approve and run')
  expect(String((await $.tool.call({ tool: RAISE, ...INPUT })).text)).toContain('R1 queued')
  await $.command.run(APPROVALS)
  const text = await delivered
  await nextStatus()
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain(`\n\n${COMMAND}\n\n`)
  expect(runs).toEqual([{ argv: ['bash', '-c', COMMAND], cwd: '/tmp' }])
  expect(text).toContain('Exit code: 3')
  expect(text).toContain('stdout:\nout')
  expect(text).toContain('stderr:\nerr')
})

// Regression: one approval executing the command again on a later /approvals walk.
test('an approval is single-use', async ($, on) => {
  const { runs, delivered, nextStatus } = await start($, on, 'Approve and run')
  await $.tool.call({ tool: RAISE, ...INPUT })
  await $.command.run(APPROVALS)
  await delivered
  await nextStatus()
  const again = await $.command.run(APPROVALS)
  expect(String(again.text)).toContain('no pending approval requests')
  expect(runs).toHaveLength(1)
})

// Regression: a rejection still running the command, or losing the user's reason.
test('a rejection runs nothing and delivers the reason', async ($, on) => {
  const { runs, delivered, nextStatus } = await start($, on, 'too risky on prod')
  await $.tool.call({ tool: RAISE, ...INPUT })
  await $.command.run(APPROVALS)
  const text = await delivered
  await nextStatus()
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
  const again = await $.command.run(APPROVALS)
  expect(String(again.text)).toContain('1 pending approval request')
  expect(runs).toEqual([])
  await nextStatus()
  expect(asked).toHaveLength(2)
})

// Regression: a request missing its justification being queued for review anyway.
test('a request without rejected alternatives is refused', async ($, on) => {
  await start($, on, 'Approve and run')
  const r = await $.tool.call({ tool: RAISE, ...INPUT, alternatives: [] })
  expect(r.isError).toBe(true)
})

// Regression: a subagent's outcome landing in main's conversation while the subagent that raised it waits forever.
test("a subagent's outcome is sent to that subagent", async ($, on) => {
  const sent = new Promise<{ to: string; text: string }>(resolve => {
    on('session.send', async (_$, e) => { resolve({ to: e.to, text: e.text }); return { isDelivered: true } })
  })
  const { nextStatus } = await start($, on, 'Approve and run')
  await $.tool.call({ tool: RAISE, ...INPUT, agentId: 'agent-7' })
  await $.command.run(APPROVALS)
  const s = await sent
  await nextStatus()
  expect(s.to).toContain('agent-7')
  expect(s.text).toContain('Exit code: 3')
})
