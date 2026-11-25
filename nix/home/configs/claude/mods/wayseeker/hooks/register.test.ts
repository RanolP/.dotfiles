import { test, expect, mock, type Engine } from 'claude-code/testing'

import { evaluate } from './eval'
import { readWayseekerLedger, renderInstructions, wayseekerKey } from './render'

const DECLS = ['decl use(role, tool) key(role) "{role}에 {tool}을 쓴다"', 'serving := "서빙"']
// The extractor's reply per prompt, as the model would fence it.
const REPLIES: Record<string, string[]> = {
  'sglang 써': [...DECLS, '@1 user: say(use(serving, sglang))'],
  'vllm으로 바꿔': ['@2 user: say(use(serving, vllm))'],
  '다른 얘기': [],
}

function world(on: any) {
  const files: Record<string, string> = {}
  const rows: { role: 'user' | 'assistant'; text: string; toolUses: [] }[] = []
  const contexts: (readonly string[] | undefined)[] = []
  mock.env(on, { HOME: '/home/t' })
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: rows.map(row => ({ ...row })) }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] }))
  on('fs.write', (_$: any, e: any) => { files[e.path] = e.text; return { value: undefined } })
  on('ui.log', () => ({ value: undefined }))
  on('model.complete', (_$: any, e: any) => {
    const prompt = /<user_message>\n([\s\S]*?)\n<\/user_message>/.exec(e.prompt)?.[1]
    return { value: { isAnswered: true, text: `\`\`\`\n${(REPLIES[prompt ?? ''] ?? []).join('\n')}\n\`\`\`` } }
  })
  // Core: the prompt's row lands once the submit chain settles, followed by a reply.
  on('prompt.submit', (_$: any, e: any) => {
    contexts.push(e.context)
    rows.push({ role: 'user', text: [e.text, ...(e.context ?? [])].join('\n'), toolUses: [] }, { role: 'assistant', text: 'ok', toolUses: [] })
    return { text: e.text, context: e.context }
  })
  on('tool.call', (_$: unknown, e: { tool: string }) => e.tool === 'Denied' ? { deny: 'blocked' } : { result: 'ok', context: ['existing context'] })
  // What $.wayseeker.instructions answers, rendered from wayseeker's own per-session file (a test's $ cannot call a plugin noun).
  const instructions = async () => {
    const ledger = readWayseekerLedger(JSON.parse(files['/home/t/.claude-work/plans/wayseeker-s1.json'] ?? '{}')[wayseekerKey('s1:main')])
    return renderInstructions(ledger, evaluate(ledger))
  }
  return { files, rows, contexts, instructions }
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
  expect(await instructions()).toBe('## user instructions\n\n- 서빙에 sglang을 쓴다. (@1)')
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
  expect(await instructions()).toBe('## user instructions\n\n- 서빙에 sglang을 쓴다. (@1)')
})

// Regression caught: the instructions reaching the model only through clm's ledger, so they vanish once clm is removed.
test('a human turn gets the wayseeker instructions attachment even with clm absent', async ($, on) => {
  const { contexts } = world(on)
  await submit($, 'sglang 써')
  await settle()
  expect(contexts[0]).toBeUndefined() // the ledger rendered empty: no attachment
  await submit($, '다른 얘기')
  await settle()
  expect(contexts[1]).toEqual(['<system-reminder>\n## user instructions\n\n- 서빙에 sglang을 쓴다. (@1)\n</system-reminder>'])
})

test('an unchanged section present in the transcript is not attached on the next human turn', async ($, on) => {
  const { contexts } = world(on)
  await submit($, 'sglang 써')
  await settle()
  await submit($, '다른 얘기')
  await settle()
  await submit($, '다른 얘기')
  await settle()
  expect(contexts[1]?.[0]).toContain('sglang')
  expect(contexts[2]).toBeUndefined()
})

test('a changed section lands on the next tool call in the same human turn', async ($, on) => {
  const { rows } = world(on)
  await submit($, 'sglang 써')
  await settle()
  const first = await $.tool.call({ tool: 'Read', file_path: '/test' })
  expect(first.context).toEqual(['existing context', '<system-reminder>\n## user instructions\n\n- 서빙에 sglang을 쓴다. (@1)\n</system-reminder>'])
  rows.push({ role: 'assistant', text: (first.context ?? []).join('\n'), toolUses: [] })
  expect((await $.tool.call({ tool: 'Read', file_path: '/test' })).context).toEqual(['existing context'])
  await submit($, 'vllm으로 바꿔')
  await settle()
  const changed = await $.tool.call({ tool: 'Read', file_path: '/test' })
  expect(changed.context?.[1]).toContain('vllm')
})

test('a compacted section is delivered again on prompt submit and tool call', async ($, on) => {
  const { rows, contexts } = world(on)
  await submit($, 'sglang 써')
  await settle()
  await submit($, '다른 얘기')
  await settle()
  const stripSection = () => {
    for (const row of rows) row.text = row.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
  }
  stripSection()
  await submit($, '다른 얘기')
  await settle()
  expect(contexts[2]).toEqual(contexts[1])
  stripSection()
  expect((await $.tool.call({ tool: 'Read', file_path: '/test' })).context?.[1]).toBe(contexts[1]?.[0])
})

test('worker and denied tool calls leave changed instructions for the main agent', async ($, on) => {
  world(on)
  await submit($, 'sglang 써')
  await settle()
  expect((await $.tool.call({ tool: 'Read', file_path: '/test', agentId: 'worker' })).context).toEqual(['existing context'])
  expect((await $.tool.call({ tool: 'Denied' })).context).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: '/test' })).context?.[1]).toContain('sglang')
})
