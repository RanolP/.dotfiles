import { test, expect } from 'claude-code/testing'
import type { EngineInterface, ToolCallResult, ToolInfo } from 'claude-code'
import { READY_LINE } from '../daemon/protocol.mjs'
import { encodeFinal, EXEC_TOOL, handleExec, type ExecEngine } from './register'

// Regression: an oversized composed value reaches model context without a clear truncation marker.
test('large script results carry a visible truncation note', async () => {
  const result = encodeFinal({ value: 'x'.repeat(100) }, 20)
  expect(result.slice(0, 20)).toBe('{"value":"xxxxxxxxxx')
  expect(result.slice(20)).toContain('output truncated at 20 characters')
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stubEngine(nextResponses: unknown[], callTool: ExecEngine['tool']['call'] = async () => ({ result: null })) {
  const routes: { path: string; body: Record<string, unknown>; token: string }[] = []
  const tools: ToolInfo[] = [{ name: 'Read', description: 'Read a file', mcp: false }, { name: EXEC_TOOL, description: 'exec', mcp: false }]
  const $: ExecEngine = {
    http: {
      fetch: async (url, init) => {
        const route = new URL(url).pathname
        const parsedBody: unknown = init?.body ? JSON.parse(init.body) : {}
        const body = isRecord(parsedBody) ? parsedBody : {}
        const control = init?.headers?.['x-tool-compose-token'] ?? ''
        routes.push({ path: route, body, token: control })
        if (route === '/health') return { status: 503, ok: false, headers: {}, text: 'no daemon yet' }
        if (route === '/run') return { status: 202, ok: true, headers: {}, text: JSON.stringify({ runId: body.runId }) }
        if (route === '/next') return { status: 200, ok: true, headers: {}, text: JSON.stringify(nextResponses.shift() ?? { kind: 'pending' }) }
        if (route === '/result' || route === '/cancel' || route === '/close') return { status: 200, ok: true, headers: {}, text: JSON.stringify({ delivered: true, closed: true }) }
        return { status: 404, ok: false, headers: {}, text: `no route ${route}` }
      },
    },
    tool: { list: async () => tools, call: callTool },
    fs: { read: async filePath => filePath.endsWith('/protocol.mjs') ? `export const READY_LINE = '${READY_LINE}'` : 'daemon source' },
    env: { get: async name => name === 'HOME' ? '/tmp/tc-hook' : undefined },
    session: { id: async () => 'unit-test' },
    process: {
      spawn: () => {
        const stream = (async function* () {
          yield { stream: 'stdout' as const, text: `${READY_LINE}\n` }
          return { code: 0, signal: null }
        })()
        return Object.assign(stream, { result: Promise.resolve({ code: 0, signal: null }) })
      },
    },
    ui: { log: async () => {} },
  }
  return { $, routes }
}

// Regression: aborting the hook during a permission dialog leaves its child alive because /cancel was never posted.
test('aborting during a relayed tool call posts an authenticated cancel', async () => {
  let toolStartedResolve = () => {}
  const toolStarted = new Promise<void>(resolve => { toolStartedResolve = resolve })
  let finishTool = (_: ToolCallResult) => {}
  const heldTool = new Promise<ToolCallResult>(resolve => { finishTool = resolve })
  const { $, routes } = stubEngine(
    [{ kind: 'call', callId: 'read-1', tool: 'Read', input: { file_path: 'x' } }],
    async () => { toolStartedResolve(); return heldTool },
  )
  const controller = new AbortController()
  const running = handleExec($, '/test/mod', 'return await tools.Read({file_path:"x"});', { signal: controller.signal, budget: { remainingMs: 10_000 } })
  try {
    await toolStarted
    controller.abort()
    const response = await running
    expect(response.isError).toBe(true)
    const cancel = routes.find(route => route.path === '/cancel')
    const run = routes.find(route => route.path === '/run')
    expect(cancel).toBeDefined()
    expect(cancel?.body.runId).toBe(run?.body.runId)
    expect(cancel?.body.controlToken).toBe(cancel?.token)
  } finally {
    finishTool({ deny: 'settled after abort' })
  }
})

// Regression: a recursive exec reaches $.tool.call and starts a second script instead of returning a refusal.
test('recursive exec calls are refused before calling the tool API', async () => {
  let toolCalls = 0
  const { $, routes } = stubEngine([
    { kind: 'call', callId: 'recursive-1', tool: EXEC_TOOL, input: { script: 'return 1' } },
    { kind: 'done', ok: false, error: 'recursive calls to tool-compose exec are refused', stack: '' },
  ], async () => { toolCalls++; return { result: 'must not be called' } })
  const response = await handleExec($, '/test/mod', 'return await tools["mcp__tool-compose__exec"]({script:"return 1"});', {
    signal: new AbortController().signal,
    budget: { remainingMs: 10_000 },
  })
  expect(response.isError).toBe(true)
  expect(toolCalls).toBe(0)
  const posted = routes.find(route => route.path === '/result')
  expect(posted?.body.reply).toEqual({ ok: false, error: 'recursive calls to tool-compose exec are refused' })
})
