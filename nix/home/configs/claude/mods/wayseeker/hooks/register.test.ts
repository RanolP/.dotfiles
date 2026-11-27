import { test, expect, mock, type Engine } from 'claude-code/testing'

import { evaluate } from './eval'
import { readWayseekerLedger, renderInstructions, wayseekerKey } from './render'

const DECLS = ['decl use(role, tool) key(role) "{role}에 {tool}을 쓴다"', 'serving := "서빙"']
// The extractor's reply per prompt, as the model would fence it.
const REPLIES: Record<string, string[]> = {
  'sglang 써': [...DECLS, '@1 user: want(use(serving, sglang))'],
  'vllm으로 바꿔': ['@2 user: reject(@1)', '@2 user: want(use(serving, vllm))'],
  '아니 vllm으로': ['@2 user: reject(@1)', '@2 user: want(use(serving, vllm))'],
  '다른 얘기': [],
}

function world(on: any, rowsKeepContext = true) {
  const files: Record<string, string> = {}
  const rows: { role: 'user' | 'assistant'; text: string; toolUses: [] }[] = []
  const contexts: (readonly string[] | undefined)[] = []
  const logs: string[] = []
  mock.env(on, { HOME: '/home/t' })
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: rows.map(row => ({ ...row })) }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] }))
  on('fs.write', (_$: any, e: any) => { files[e.path] = e.text; return { value: undefined } })
  on('ui.log', (_$: any, e: any) => { if (e.to !== 'debug') logs.push(e.message ?? e.text ?? JSON.stringify(e)); return { value: undefined } })
  on('model.complete', (_$: any, e: any) => {
    const prompt = /<user_message>\n([\s\S]*?)\n<\/user_message>/.exec(e.prompt)?.[1]
    return { value: { isAnswered: true, text: `\`\`\`\n${(REPLIES[prompt ?? ''] ?? []).join('\n')}\n\`\`\`` } }
  })
  // Core: the prompt's row lands once the submit chain settles, followed by a reply. A prompt submitted over a
  // running turn (turnId) gets no row: the engine folds it in as a queued_command attachment, which messages() never lists.
  on('prompt.submit', (_$: any, e: any) => {
    contexts.push(e.context)
    if (e.turnId === undefined) rows.push({ role: 'user', text: [e.text, ...(rowsKeepContext ? e.context ?? [] : [])].join('\n'), toolUses: [] }, { role: 'assistant', text: 'ok', toolUses: [] })
    return { text: e.text, context: e.context }
  })
  on('tool.call', (_$: unknown, e: { tool: string }) => e.tool === 'Denied' ? { deny: 'blocked' } : { result: 'ok', context: ['existing context'] })
  // What $.wayseeker.instructions answers, rendered from wayseeker's own per-session file (a test's $ cannot call a plugin noun).
  const instructions = async () => {
    const ledger = readWayseekerLedger(JSON.parse(files['/home/t/.claude-work/plans/wayseeker-s1.json'] ?? '{}')[wayseekerKey('s1:main')])
    return renderInstructions(ledger, evaluate(ledger))
  }
  return { files, rows, contexts, logs, instructions }
}
const submit = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
// The extraction runs after the submit resolves; a few timer turns let it land. setTimeout is reached through globalThis: the mod's types carry no DOM or Node globals.
const tick = (globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => unknown }).setTimeout
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => tick(resolve, 0)) }

// Regression caught: wayseeker reaching into clm for its store or its rewind, so it stops working once clm is removed.
test('with no clm loaded, a prompt is extracted and rendered from the wayseeker store', async ($, on) => {
  const { instructions } = world(on)
  await submit($, 'sglang 써')
  await settle()
  expect(await instructions()).toBe('## user instructions\n\n- 서빙에 sglang을(를) 쓴다. (@1)')
})

// Regression caught: a rewound prompt's instruction outliving the rewind once clm's rewind no longer trims the ledger.
test('a prompt rewound before the next submit loses its extracted lines', async ($, on) => {
  const { rows, instructions } = world(on)
  await submit($, 'sglang 써')
  await settle()
  await submit($, 'vllm으로 바꿔')
  await settle()
  expect(await instructions()).toContain('vllm')
  rows.splice(2) // the rewind takes the transcript back to before "vllm으로 바꿔"
  await submit($, '다른 얘기')
  await settle()
  expect(await instructions()).toBe('## user instructions\n\n- 서빙에 sglang을(를) 쓴다. (@1)')
})

// Regression caught: the section riding every changed prompt, re-sending instructions the user's own prompts already carry verbatim.
test('an ordinary human turn gets no instructions attachment even when the section changed', async ($, on) => {
  const { contexts } = world(on)
  await submit($, 'sglang 써')
  await settle()
  await submit($, '다른 얘기')
  await settle()
  await submit($, '아니 vllm으로')
  await settle()
  await submit($, '다른 얘기')
  await settle()
  expect(contexts.every(c => c === undefined)).toBe(true)
})

// Regression caught: a landed compaction dropping the instructions with the pre-compact prompts, so the model never sees them again.
test('the first prompt after a landed compaction gets the section, and the next prompt does not', async ($, on) => {
  const { contexts } = world(on)
  const summary = { role: 'user' as const, text: 'summary', toolUses: [] }
  on('session.compact', () => ({ messages: [summary] }))
  await submit($, 'sglang 써')
  await settle()
  await $.session.compact({ trigger: 'manual', messages: [summary] })
  await submit($, '다른 얘기')
  await settle()
  expect(contexts[1]).toEqual(['<system-reminder>\n## user instructions\n\n- (@1) "sglang 써"\n</system-reminder>'])
  await submit($, '다른 얘기')
  await settle()
  expect(contexts[2]).toBeUndefined()
})

// Regression caught: a skipped compaction (nothing summarised) re-sending the section into a context that still holds it.
test('a skipped compaction arms no delivery', async ($, on) => {
  const { contexts } = world(on)
  on('session.compact', () => ({ skip: 'nothing to do' }))
  await submit($, 'sglang 써')
  await settle()
  await $.session.compact({ trigger: 'manual', messages: [] })
  await submit($, '다른 얘기')
  await settle()
  expect(contexts[1]).toBeUndefined()
})

// Regression caught: an empty ledger at the first post-compaction prompt spending the one-shot, so instructions extracted later never arrive.
test('the delivery stays armed while the section is empty', async ($, on) => {
  const { contexts } = world(on)
  const summary = { role: 'user' as const, text: 'summary', toolUses: [] }
  on('session.compact', () => ({ messages: [summary] }))
  await $.session.compact({ trigger: 'manual', messages: [summary] })
  await submit($, '다른 얘기')
  await settle()
  expect(contexts[0]).toBeUndefined()
  await submit($, 'sglang 써')
  await settle()
  await submit($, '다른 얘기')
  await settle()
  expect(contexts[2]?.[0]).toContain('sglang')
})

test('the user is shown an added instruction, and nothing when the section is unchanged', async ($, on) => {
  const { logs } = world(on)
  await submit($, 'sglang 써')
  await settle()
  expect(logs).toEqual(['want(use(serving, sglang))', '지시 추가: 서빙에 sglang을(를) 쓴다. (@1)'])
  await submit($, '다른 얘기')
  await settle()
  expect(logs).toHaveLength(2)
})

// Regression caught: a landed ask changes no instruction, so the user saw nothing of what wayseeker understood.
test('an ask-only prompt shows the landed act', async ($, on) => {
  const { logs } = world(on)
  REPLIES['sglang 있어?'] = ['decl have(thing) key(thing) "{thing}이 있다"', '@1 user: ask(have(sglang))']
  await submit($, 'sglang 있어?')
  await settle()
  expect(logs).toEqual(['ask(have(sglang))'])
})

// Regression caught: a prompt typed mid-turn, which reaches the transcript only as a queued_command attachment, was
// read as rewound: its extraction was dropped at landing and the next submit cut its address from the prompt list.
test('a prompt folded into the running turn as an attachment lands and is not read as a rewind', async ($, on) => {
  const { files, instructions } = world(on)
  await submit($, 'sglang 써')
  await settle()
  await $.prompt.submit({ text: '아니 vllm으로', wait: false, origin: { kind: 'composer' }, turnId: 't1' })
  await $.session.append({
    door: 'attachment', origin: { kind: 'engine' }, uuid: 'queued-1',
    message: { type: 'attachment', name: 'queued_command', role: 'user', content: [{ type: 'text', text: 'The user sent a new message while you were working:\n아니 vllm으로\n\nAddress the message above.' }] },
  })
  await settle()
  expect(await instructions()).toBe('## user instructions\n\n- 서빙에 vllm을(를) 쓴다. (@2)')
  await submit($, '다른 얘기')
  await settle()
  expect(await instructions()).toBe('## user instructions\n\n- 서빙에 vllm을(를) 쓴다. (@2)')
  const prompts = JSON.parse(files['/home/t/.claude-work/plans/wayseeker-s1.json']!)['prompts:s1:main'] as { address?: string; midTurn?: true }[]
  expect(prompts.map(row => [row.address, row.midTurn ?? false])).toEqual([['@w1', false], ['@w2', true], ['@w3', false]])
})
