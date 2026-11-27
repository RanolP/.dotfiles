import { test, expect } from 'claude-code/testing'

import { EXTRACT_CASES, extractPrompt, extractTurn, parseExtraction } from './extract'
import { append, emptyLedger, type Ledger } from './store'

const ledgerOf = (lines: string[]): Ledger => lines.reduce((ledger, line) => {
  const result = append(ledger, line)
  if (!result.ok) throw new Error(line + ': ' + result.errors.join('; '))
  return result.ledger
}, emptyLedger())

const fence = '\x60\x60\x60'
type Request = { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }
const fakeIo = (text: string, calls: Request[] = []) => ({
  complete: async (request: Request) => {
    calls.push(request)
    return { isAnswered: true, text, reason: '' }
  },
})

// Regression: a chatty model reply leaking its prose into the ledger as lines.
test('parseExtraction keeps only the lines inside the fenced block', () => {
  const reply = 'Sure! Here is the extraction:\n' + fence + 'text\n@3 user: say(use(server, vllm))\n\n  @3 user: say(not(use(server, sglang)))  \n' + fence + '\nThe user prefers vllm.'
  expect(parseExtraction(reply)).toEqual(['@3 user: say(use(server, vllm))', '@3 user: say(not(use(server, sglang)))'])
  expect(parseExtraction('no block here, just say(use(server, vllm))')).toEqual([])
})

// Regression: one invalid line poisoning the whole turn, or slipping into the ledger.
test('extractTurn appends valid lines and reports invalid ones without touching the ledger for them', async () => {
  const ledger = ledgerOf(['decl use(slot, tool) key(slot) "자리마다 쓰는 도구"', '@1 user: ask(use(server, ?x))'])
  const reply = fence + '\n' + [
    'vllm := "빠른 추론 서버"',
    '@2 user: say(use(server, vllm))',
    '@3 user: say(invented(thing))',
    'this is prose',
  ].join('\n') + '\n' + fence
  const calls: Request[] = []
  const result = await extractTurn(fakeIo(reply, calls), ledger, '아 sglang 말고 vllm', 'sglang 어때요')
  expect(calls[0]?.model).toBe('sonnet')
  expect(result.appended).toEqual(['vllm := "빠른 추론 서버"', '@2 user: say(use(server, vllm))'])
  expect(result.rejected.map(item => item.line)).toEqual(['@3 user: say(invented(thing))', 'this is prose'])
  expect(result.rejected.every(item => item.errors.length > 0)).toBe(true)
  expect(result.ledger.utterances.length).toBe(2)
  expect(result.ledger.glosses.map(item => item.atom)).toEqual(['vllm'])
  expect(ledger.utterances.length).toBe(1)
})

const flakyIo = (answers: boolean[], text: string, calls: Request[]) => ({
  complete: async (request: Request) => {
    calls.push(request)
    const isAnswered = answers[calls.length - 1] ?? false
    return isAnswered ? { isAnswered: true as const, text, reason: '' } : { isAnswered: false as const, text: '', reason: 'timeout' }
  },
})

// Regression caught: one timed-out extraction silently dropping the prompt's instructions.
test('extractTurn retries once when the first call is not answered', async () => {
  const calls: Request[] = []
  const reply = fence + '\n@1 user: say(use(server, vllm))\n' + fence
  const result = await extractTurn(flakyIo([false, true], reply, calls), ledgerOf(['decl use(slot, tool) key(slot) "자리마다 쓰는 도구"']), 'vllm 써', '')
  expect(calls.length).toBe(2)
  expect(result.appended.length).toBe(1)
})

// Regression caught: retrying without a bound, or giving up before the one retry.
test('extractTurn gives up after the second failure and appends nothing', async () => {
  const calls: Request[] = []
  const result = await extractTurn(flakyIo([false, false], '', calls), emptyLedger(), 'vllm 써', '')
  expect(calls.length).toBe(2)
  expect(result.appended).toEqual([])
  expect(result.rejected[0]?.errors[0]?.startsWith('not answered')).toBe(true)
})

// Regression: the model inventing a predicate that already exists under another name because it never saw the vocabulary.
test('extractPrompt lists every decl and gloss and numbers from firstId', () => {
  const ledger = ledgerOf([
    'decl use(slot, tool) key(slot) "자리마다 쓰는 도구"',
    'decl filter_events(event) key(event) "거르는 이벤트"',
    'sglang := "빠른 서버 프레임워크"',
  ])
  const prompt = extractPrompt(ledger, 'vllm 써볼까?', '', 7)
  for (const needle of ['use(slot, tool)', '자리마다 쓰는 도구', 'filter_events(event)', '거르는 이벤트', 'sglang := "빠른 서버 프레임워크"', 'FIRST = 7', 'vllm 써볼까?']) {
    expect(prompt.includes(needle)).toBe(true)
  }
  expect(EXTRACT_CASES.length > 0).toBe(true)
})
