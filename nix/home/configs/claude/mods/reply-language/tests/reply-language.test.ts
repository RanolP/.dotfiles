import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Nothing stands beneath the plugins in a test: these answer for the engine.
async function start($: Engine, on: On) {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const seen: (readonly string[])[] = []
  on('prompt.submit', async (_$, e) => { seen.push(e.context ?? []); return { text: e.text } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return seen
}
const finish = ($: Engine, answer: string, extra: { agentId?: string; isAborted?: boolean } = {}) =>
  $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...extra } as never)
const hasReminder = (ctx: readonly string[]) => ctx.some(c => c.includes('was not in Korean'))

// Regression: an English reply after an English subagent report never gets corrected on the next prompt.
test('an English-only answer puts the reminder into the next prompt once', async ($, on) => {
  const seen = await start($, on)
  await finish($, 'Done. All tests pass.')
  await $.prompt.submit({ text: 'a' })
  await $.prompt.submit({ text: 'b' })
  expect(hasReminder(seen[0]!)).toBe(true)
  expect(hasReminder(seen[1]!)).toBe(false)
})

// Regression: a reminder after a Korean answer, a subagent's English report or an aborted turn.
test('a Korean answer, a subagent answer or an aborted turn adds no reminder', async ($, on) => {
  const seen = await start($, on)
  await finish($, '완료했습니다.')
  await $.prompt.submit({ text: 'a' })
  await finish($, 'English subagent report', { agentId: 'sub1' })
  await $.prompt.submit({ text: 'b' })
  await finish($, 'Partial English', { isAborted: true })
  await $.prompt.submit({ text: 'c' })
  expect(seen.length).toBe(3)
  expect(seen.some(hasReminder)).toBe(false)
})
