import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const ASK = 'mcp__ask-later__ask'
const LIST = 'mcp__ask-later__list'
const OPTIONS = [{ label: 'A' }, { label: 'B' }]

// Nothing stands beneath the plugins in a test: these answer for the engine.
// Returns the plugin's ui.log lines.
async function start($: Engine, on: On) {
  const logs: string[] = []
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('ui.log', async (_$, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.toast', async () => ({ value: undefined }))
  // The engine's own band: an empty box beneath ask-later's.
  on('ui.render', { component: 'AbovePrompt' }, async ($$, e) => $$.ui.resolve(e).Box({}))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  return { logs }
}

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }
const band = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'ask-later', surface, component: 'AbovePrompt', props: BAND_PROPS })
// Presses 답하기; resolves once the walk and its delivery settled.
const pressAnswer = async ($: Engine) => (await band($)).press({ key: 'answer' })

// Answers dialogs by question text; a question with no answer is dismissed, as Esc does.
function dialogs(on: On, answers: Record<string, string>) {
  const opened: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const question = e.questions[0]?.question ?? ''
    opened.push(question)
    const answer = answers[question]
    if (answer === undefined) return { deny: 'dismissed' }
    return { result: { questions: e.questions, answers: { [question]: answer } } } as never
  })
  return opened
}

function submitted(on: On) {
  return new Promise<string>(resolve => {
    on('prompt.submit', async (_$, e) => { resolve(e.text); return { text: e.text } })
  })
}

const listText = async ($: Engine) => String((await $.tool.call({ tool: LIST })).text)

// Regression: ask blocking on a dialog (the whole point is a NON-blocking AskUserQuestion).
test('ask queues without opening a dialog', async ($, on) => {
  const opened = dialogs(on, {})
  await start($, on)
  const r = await $.tool.call({ tool: ASK, question: 'Which db?', options: OPTIONS, assumption: 'A' })
  expect(String(r.text)).toContain('Q1 queued')
  expect(opened).toEqual([])
  expect(await listText($)).toContain('Q1 [pending] Which db?')
})

// Regression: Esc on one dialog dropping the question or aborting the rest of the 답하기 walk.
test('a dismissed dialog leaves its question pending and the next is answered', async ($, on) => {
  const opened = dialogs(on, { 'Second?': 'B' })
  const delivered = submitted(on)
  await start($, on)
  await $.tool.call({ tool: ASK, question: 'First?', options: OPTIONS })
  await $.tool.call({ tool: ASK, question: 'Second?', options: OPTIONS })
  await pressAnswer($)
  const text = await delivered
  expect(opened).toEqual(['First?', 'Second?'])
  expect(text).toContain('Q2: Second?')
  expect(text).not.toContain('Q1')
  const list = await listText($)
  expect(list).toContain('Q1 [pending] First?')
  expect(list).not.toContain('Q2')
})

// Regression: answers given mid-turn waiting for the next idle prompt instead of joining the running turn.
// The kit cannot answer a plugin's session.append (a bottom hook answering without next is skipped),
// so the attempt is read from the plugin's debug line naming the running turn.
test('answers go to the running turn through session.append', async ($, on) => {
  dialogs(on, { 'Mid?': 'A' })
  const fallback = submitted(on)
  const { logs } = await start($, on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.tool.call({ tool: ASK, question: 'Mid?', options: OPTIONS, assumption: 'B' })
  await pressAnswer($)
  const text = await fallback
  expect(logs.some(l => l.includes('session.append') && l.includes('during turn t1'))).toBe(true)
  expect(text).toContain('Q1: Mid?')
  expect(text).toContain('answer: A')
  expect(text).toContain('asked under assumption: B')
})

// Regression: answers given while idle being appended to a transcript no turn will read.
test('answers start a turn through prompt.submit when idle', async ($, on) => {
  dialogs(on, { 'Idle?': 'B' })
  const delivered = submitted(on)
  const { logs } = await start($, on)
  await $.turn.start({ text: 'work', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.tool.call({ tool: ASK, question: 'Idle?', options: OPTIONS })
  await pressAnswer($)
  expect(await delivered).toContain('Q1: Idle?')
  expect(logs.some(l => l.includes('session.append'))).toBe(false)
})

// Regression: the native "Chat about this" row was treated as a skip. It denies the
// AskUserQuestion permission with clarify feedback (claude 2.1.288), which $.ui.ask rejects with,
// keeping only the first 120 characters of it: the feedback here fits.
test('native Chat about this on a 답하기 dialog fills the prompt and leaves the question pending', async ($, on) => {
  const opened: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const question = e.questions[0]?.question ?? ''
    opened.push(question)
    return { deny: `The user wants to clarify these questions.\nQuestions asked:\n- "${question}"\n  (No answer provided)\n  User notes: both?` }
  })
  const filled = new Promise<string>(resolve => {
    on('prompt.fill', async (_$, e) => { resolve(e.text); return { isFilled: true } as never })
  })
  await start($, on)
  await $.tool.call({ tool: ASK, question: 'Chat?', options: OPTIONS })
  await $.tool.call({ tool: ASK, question: 'Later?', options: OPTIONS })
  await pressAnswer($)
  expect(await filled).toBe('[Q1] Chat?\nboth?\n')
  // Chat leaves the walk: the second dialog never opens.
  expect(opened).toEqual(['Chat?'])
  expect(await listText($)).toContain('Q1 [pending] Chat?')
})

// Regression: stale 답하기 band after all questions answered, or a second press during a walk opening the dialogs twice.
test('the band counts pending questions, hides 답하기 during a walk, and disappears at zero', async ($, on) => {
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  let dialogOpened = () => {}
  const firstDialog = new Promise<void>(resolve => { dialogOpened = resolve })
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    dialogOpened()
    await gate
    const question = e.questions[0]?.question ?? ''
    return { result: { questions: e.questions, answers: { [question]: 'A' } } } as never
  })
  const delivered = submitted(on)
  await start($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const empty = await band($, surface)
    expect(await empty.find({ key: 'answer' })).toBeUndefined()
    await empty.unmount()
  }
  await $.tool.call({ tool: ASK, question: 'One?', options: OPTIONS })
  await $.tool.call({ tool: ASK, question: 'Two?', options: OPTIONS })
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: '질문 2개 대기' })).toBeDefined()
  expect((await ui.find({ key: 'answer' }))?.props.label).toBe('답하기')
  const pressed = ui.press({ key: 'answer' })
  // The walk sits on the first dialog until the gate opens.
  await firstDialog
  expect(await ui.find({ key: 'answer' })).toBeUndefined()
  release()
  await pressed
  expect(await delivered).toContain('Q2: Two?')
  expect(await ui.find({ type: 'Text', text: /질문/ })).toBeUndefined()
  expect(await ui.find({ key: 'answer' })).toBeUndefined()
})
