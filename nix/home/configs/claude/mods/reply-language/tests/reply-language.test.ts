import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Nothing stands beneath the plugins in a test: these answer for the engine.
async function start($: Engine, on: On) {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  const prompts: (readonly string[])[] = []
  on('prompt.submit', async (_$, e) => { prompts.push(e.context ?? []); return { text: e.text, context: e.context } })
  const rows: string[][] = []
  on('session.append', async (_$, e, next) => {
    rows.push(e.message.content.flatMap(b => (b.type === 'text' ? [b.text] : [])))
    return next(e)
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { prompts, rows }
}
// The harness has no store beneath session.append: the test hook observes the row, and the store attempt's rejection is ignored.
const append = ($: Engine, extra: { agentId?: string; door?: string } = {}) =>
  $.session.append({
    message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: 'Approval request r1 ...' }] },
    door: 'note', origin: { kind: 'plugin', name: 'request' }, uuid: 'u1', ...extra,
  } as never).catch(() => undefined)
const hasInstruction = (texts: readonly string[]) => texts.some(t => t.includes('Korean (한국어)'))

// Regression: a turn following an English answer got no Korean instruction, typed by the person or submitted by a mod.
test('every prompt.submit carries the instruction, whatever its origin', async ($, on) => {
  const { prompts } = await start($, on)
  await $.prompt.submit({ text: 'a', wait: false, origin: { kind: 'composer' } } as never)
  await $.prompt.submit({ text: 'b', wait: false, origin: { kind: 'plugin', name: 'request' } } as never)
  expect(prompts.length).toBe(2)
  expect(prompts.every(hasInstruction)).toBe(true)
})

// Regression: a request/ask-later delivery through $.session.append skips prompt.submit and so never got the instruction.
test("a mod's session.append on main carries the instruction", async ($, on) => {
  const { rows } = await start($, on)
  await append($)
  expect(hasInstruction(rows[0]!)).toBe(true)
})

// Regression: a subagent's conversation, or an engine row such as a tool result, picks up an instruction meant for main's replies.
test('a subagent row or a non-note row gets no instruction', async ($, on) => {
  const { rows } = await start($, on)
  await append($, { agentId: 'sub1' })
  await append($, { door: 'tool-result' })
  expect(rows.length).toBe(2)
  expect(rows.some(hasInstruction)).toBe(false)
})
