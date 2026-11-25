import { expect, test } from 'claude-code/testing'
import type { EngineInterface, HttpInit } from 'claude-code'
import { BETA, EDIT, handle, settings } from '../hooks/register'

const API = 'https://api.anthropic.com'
const OK = { status: 200, ok: true, headers: {}, text: '{}' }

// Drives the hook as the engine raises an engine request; `next` stands for the send and records each request exactly as it would leave.
function wire(options: Record<string, unknown> = {}) {
  const sent: { url: string; init?: HttpInit }[] = []
  const logs: string[] = []
  const s = settings(options)
  const logged = new Set<string>()
  const $ = { ui: { log: async (text: string) => { logs.push(text) } } } as unknown as EngineInterface
  const next = Object.assign(async (e: { url: string; init?: HttpInit }) => { sent.push(e); return { value: OK } }, { origin: { plugin: 'engine' } })
  return { sent, logs, send: (url: string, init: HttpInit) => handle($, { url, init }, next, s, logged) }
}

const messagesBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
  model: 'claude-haiku-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], ...extra,
})

// Regression: the hook replaces Claude Code's own beta list or context_management instead of merging,
// dropping its clear_thinking edit or other betas, or loses `compress` so the body leaves uncompressed.
test('a Messages request gets the beta and the edit merged in', async () => {
  const { sent, send } = wire()
  const thinking = { type: 'clear_thinking_20251015', keep: { type: 'thinking_turns', value: 1 } }
  await send(`${API}/v1/messages?beta=true`, {
    method: 'POST', compress: true,
    headers: { 'Anthropic-Beta': 'oauth-2025-04-20, fine-grained-tool-streaming-2025-05-14', 'content-type': 'application/json' },
    body: messagesBody({ context_management: { edits: [thinking] } }),
  })
  expect(sent.length).toBe(1)
  const init = sent[0]!.init!
  expect(init.compress).toBe(true)
  expect(init.headers!['Anthropic-Beta']).toBe(`oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,${BETA}`)
  expect(init.headers!['anthropic-beta']).toBe(undefined)
  const body = JSON.parse(init.body as string)
  expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
  expect(body.context_management.edits).toEqual([thinking, {
    type: EDIT,
    trigger: { type: 'input_tokens', value: 100000 },
    keep: { type: 'tool_uses', value: 3 },
    clear_at_least: { type: 'input_tokens', value: 20000 },
  }])
})

// Regression: a request that already carries ${EDIT} (Claude Code's own tool-result clearing) gets a
// second copy, which the API rejects.
test('an existing clear_tool_uses edit is kept as the only one', { options: { triggerTokens: 50000 } }, async () => {
  const { sent, send } = wire()
  const own = { type: EDIT, trigger: { type: 'tool_uses', value: 30 } }
  await send(`${API}/v1/messages`, { method: 'POST', headers: { 'anthropic-beta': BETA }, body: messagesBody({ context_management: { edits: [own] } }) })
  const init = sent[0]!.init!
  expect(init.headers!['anthropic-beta']).toBe(BETA)
  expect(JSON.parse(init.body as string).context_management.edits).toEqual([own])
})

// Regression: the edit lands beside a message `thread`; the API answers 400 thread_unsupported_request and
// Claude Code resends stateless and keeps that thread stateless for the rest of the session (seen in a live probe).
test('a request carrying a thread passes through byte-identical', async () => {
  const { sent, send } = wire()
  const init: HttpInit = { method: 'POST', headers: { 'anthropic-beta': 'message-threads-2026-08-12' }, body: messagesBody({ thread: { id: 't1' } }) }
  await send(`${API}/v1/messages`, init)
  expect(sent[0]).toEqual({ url: `${API}/v1/messages`, init })
  expect(sent[0]!.init!.body).toBe(init.body)
})

// Regression: a non-Messages engine request (a GET, an OAuth call) is reserialized or gains the beta header.
test('a non-Messages request passes through byte-identical', async () => {
  const { sent, send } = wire()
  const init: HttpInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{ "messages": [ ] ,"x":1}' }
  await send(`${API}/v1/oauth/token`, init)
  expect(sent[0]).toEqual({ url: `${API}/v1/oauth/token`, init })
  expect(sent[0]!.init!.body).toBe(init.body)
})

// Regression: count_tokens gains context_management, which that endpoint answers with a 400,
// so the context meter breaks.
test('a count_tokens request passes through byte-identical', async () => {
  const { sent, send } = wire()
  const init: HttpInit = { method: 'POST', headers: { 'anthropic-beta': 'token-counting-2024-11-01' }, body: messagesBody() }
  await send(`${API}/v1/messages/count_tokens`, init)
  expect(sent[0]).toEqual({ url: `${API}/v1/messages/count_tokens`, init })
  expect(sent[0]!.init!.body).toBe(init.body)
})

// Regression: a body that is not JSON (or arrives as bytes) makes the hook throw or rewrite it,
// so the request fails or leaves altered instead of going out as written.
test('a non-JSON body passes through byte-identical', async () => {
  const { sent, send } = wire()
  const text: HttpInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"messages": [' }
  const bytes: HttpInit = { method: 'POST', headers: {}, body: { base64: 'H4sIAAAAAAAAA6tWyk0sLkktUrJSUEpKzEsuyVfSUSpKLS7NKSkG8gEAWGzT3iAAAAA=' } }
  await send(`${API}/v1/messages`, text)
  await send(`${API}/v1/messages`, bytes)
  expect(sent).toEqual([{ url: `${API}/v1/messages`, init: text }, { url: `${API}/v1/messages`, init: bytes }])
  expect(sent[0]!.init!.body).toBe(text.body)
})
