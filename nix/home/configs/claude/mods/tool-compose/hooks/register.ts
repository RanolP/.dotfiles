import type { EngineInterface, Register, ToolInfo, ToolCallResult } from 'claude-code'
import { READY_LINE } from '../daemon/protocol.mjs'

export const EXEC_TOOL = 'mcp__tool-compose__exec'
export const SCRIPT_TIMEOUT_MS = 30_000
export const MAX_RESULT_CHARS = 50_000
const BUDGET_RESERVE_MS = 150

export const TOOL_DESCRIPTION = `Run JavaScript that composes Claude Code tools in one model request. Use exec for 3+ dependent or fan-out tool calls, or when you can filter large tool results before they reach context. Call any tool by its name with tools.<name>(input); use await tools.list() to inspect available tools. Tool calls still pass through Claude Code permissions and hooks.

Example:
const read = await tools.Read({file_path:"README.md"});
const matches = await tools.Grep({pattern:"TODO", path:"src"});
return {firstLine:read.content.split("\\n")[0], matches};`

type HttpJson = { status: number; ok: boolean; text: string }
export type ExecEngine = {
  http: Pick<EngineInterface['http'], 'fetch'>
  tool: Pick<EngineInterface['tool'], 'list' | 'call'>
  fs: { read(path: string): Promise<string> }
  env: Pick<EngineInterface['env'], 'get'>
  session: Pick<EngineInterface['session'], 'id'>
  process: Pick<EngineInterface['process'], 'spawn'>
  ui: Pick<EngineInterface['ui'], 'log'>
}
type ExecNext = { signal: AbortSignal; budget: { remainingMs: number } }

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void }
  }
}

function logFailure($: { ui: Pick<EngineInterface['ui'], 'log'> }, operation: string, status: string | number, body: string): void {
  try { $.ui.log(`[tool-compose] ${operation} failed; status=${status}; body=${body.slice(0, 4000)}`, { to: 'debug' }) } catch {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function encodeFinal(value: unknown, maxChars = MAX_RESULT_CHARS): string {
  let encoded: string
  try {
    const result = JSON.stringify(value)
    encoded = result === undefined ? 'null' : result
  } catch (err) {
    encoded = JSON.stringify({ error: 'result is not JSON serializable', detail: errorText(err) })
  }
  if (encoded.length <= maxChars) return encoded
  return `${encoded.slice(0, maxChars)}\n[tool-compose: output truncated at ${maxChars} characters]`
}

function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}` : String(err)
}

function daemonSource(root: string): string {
  return `${root}/daemon/tool-compose.mjs`
}

function protocolSource(root: string): string {
  return `${root}/daemon/protocol.mjs`
}

function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}

async function fingerprint($: Pick<ExecEngine, 'fs' | 'ui'>, root: string): Promise<string> {
  try { return hash(`${await $.fs.read(daemonSource(root))}\n${await $.fs.read(protocolSource(root))}`) }
  catch (err) {
    logFailure($, 'fingerprint daemon files', 'n/a', `${errorText(err)}; daemon=${daemonSource(root)}; protocol=${protocolSource(root)}`)
    return 'unread'
  }
}

async function socketPath($: Pick<ExecEngine, 'env' | 'session'>): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  const sessionId = await $.session.id()
  return `${home}/.claude-work/run/tc-${hash(sessionId)}/s.sock`
}

let daemonReady: Promise<void> | undefined
let daemonStarting: Promise<void> | undefined
let activeSocket = ''

function startDaemon($: Pick<ExecEngine, 'process' | 'ui'>, sock: string, source: string, sourceHash: string): Promise<void> {
  let settled = false
  const { promise: ready, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>()
  const fail = (err: Error) => {
    if (!settled) { settled = true; readyReject(err) }
    if (daemonReady === ready) daemonReady = undefined
    logFailure($, 'daemon process', 'n/a', err.message)
  }

  void (async () => {
    let status = 'no exit status'
    let stderr = ''
    try {
      const stream = $.process.spawn({ argv: ['node', source, sock, sourceHash] })
      for await (const chunk of stream) {
        if (chunk.stream === 'stderr') stderr = (stderr + chunk.text).slice(-3000)
        for (const line of chunk.text.trimEnd().split('\n')) {
          if (line.includes(READY_LINE) && !settled) { settled = true; readyResolve() }
          if (line) $.ui.log(`[tool-compose daemon ${chunk.stream}] ${line.slice(0, 3900)}`, { to: 'debug' })
        }
      }
      const result = await stream.result
      status = `code=${result.code ?? 'unknown'} signal=${result.signal ?? 'none'}`
      fail(new Error(`daemon exited (${status}); stderr=${stderr || '(empty)'}`))
    } catch (err) {
      fail(new Error(`daemon startup/stream failed; status=${status}; stderr=${stderr || '(empty)'}; ${errorText(err)}`))
    }
  })()
  return ready
}

async function ensureDaemon($: ExecEngine, root: string): Promise<string> {
  const sock = activeSocket || (activeSocket = await socketPath($))
  const socketBytes = new TextEncoder().encode(sock).length
  if (socketBytes > 103) throw new Error(`Unix socket path is ${socketBytes} bytes; the Darwin sun_path limit is 103 bytes: ${sock}`)
  if (daemonReady) { await daemonReady; return sock }
  if (daemonStarting) { await daemonStarting; return sock }
  const starting = (async () => {
    const source = daemonSource(root)
    const sourceHash = await fingerprint($, root)
    let probeStatus: string | number = 'n/a'
    let probeBody = ''
    try {
      const health = await $.http.fetch('http://tool-compose/health', { method: 'GET', socketPath: sock })
      probeStatus = health.status
      probeBody = health.text
      if (health.ok) {
        const body: unknown = JSON.parse(health.text)
        if (isRecord(body) && body.fingerprint === sourceHash) { daemonReady = Promise.resolve(); return }
        $.ui.log(`[tool-compose] daemon fingerprint changed; status=${health.status}; body=${health.text.slice(0, 2000)}`, { to: 'debug' })
      } else logFailure($, 'daemon health probe', health.status, health.text)
    } catch (err) {
      $.ui.log(`[tool-compose] daemon health probe missed; status=${probeStatus}; body=${probeBody || errorText(err)}`, { to: 'debug' })
    }
    const ready = startDaemon($, sock, source, sourceHash)
    daemonReady = ready
    try { await ready }
    catch (err) {
      if (daemonReady === ready) daemonReady = undefined
      throw err
    }
  })()
  daemonStarting = starting
  try { await starting }
  finally { if (daemonStarting === starting) daemonStarting = undefined }
  return sock
}

async function fetchJson($: Pick<ExecEngine, 'http' | 'ui'>, sock: string, route: string, token: string, body?: unknown): Promise<Record<string, unknown>> {
  let text = ''
  let status: string | number = 'n/a'
  let logged = false
  try {
    const headers = { 'x-tool-compose-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }
    const init = body === undefined
      ? { method: 'GET', socketPath: sock, headers }
      : { method: 'POST', socketPath: sock, headers, body: JSON.stringify(body) }
    const response: HttpJson = await $.http.fetch(`http://tool-compose${route}`, init)
    text = response.text
    status = response.status
    if (!response.ok) {
      logFailure($, route, response.status, response.text)
      logged = true
      throw new Error(`HTTP ${response.status}: ${response.text}`)
    }
    const parsed: unknown = JSON.parse(response.text)
    if (!isRecord(parsed)) throw new Error(`expected JSON object; status=${status}; body=${text}`)
    return parsed
  } catch (err) {
    if (!logged) logFailure($, route, status, text || errorText(err))
    throw err
  }
}

function runId(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`
}

function controlToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`
}

function awaitAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('exec interrupted'))
  let abortListener = () => {}
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(new Error('exec interrupted'))
    signal.addEventListener('abort', abortListener, { once: true })
  })
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener('abort', abortListener))
}

function toolInput(name: string, input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new TypeError(`tools.${name} expects one object argument`)
  return { ...input, tool: name }
}

function isToolCallInput(v: Record<string, unknown>, names: Set<string>): v is Parameters<EngineInterface['tool']['call']>[0] {
  return typeof v.tool === 'string' && names.has(v.tool)
}

async function relay(
  $: ExecEngine,
  message: Record<string, unknown>,
  names: Set<string>,
  signal: AbortSignal,
): Promise<{ callId: string; reply: Record<string, unknown> }> {
  const callId = typeof message.callId === 'string' ? message.callId : ''
  const name = typeof message.tool === 'string' ? message.tool : ''
  if (!callId || !name || !isRecord(message.input)) throw new Error(`daemon returned a malformed tool call: ${encodeFinal(message, 2000)}`)

  if (name === EXEC_TOOL || name === 'exec') {
    const reply = { ok: false, error: 'recursive calls to tool-compose exec are refused' }
    logFailure($, 'recursive exec call', 403, reply.error)
    return { callId, reply }
  }
  if (!names.has(name)) {
    const reply = { ok: false, error: `unknown Claude Code tool: ${name}` }
    logFailure($, `unknown relayed tool ${name}`, 400, reply.error)
    return { callId, reply }
  }
  const call = toolInput(name, message.input)
  if (!isToolCallInput(call, names)) {
    const reply = { ok: false, error: `unknown Claude Code tool: ${name}` }
    logFailure($, `invalid relayed tool ${name}`, 400, reply.error)
    return { callId, reply }
  }
  try {
    const result = await awaitAbort(signal, $.tool.call(call))
    if ('deny' in result && result.deny !== undefined) {
      const reply = { ok: false, error: result.deny }
      logFailure($, `relayed tool ${name}`, 403, result.deny)
      return { callId, reply }
    }
    return { callId, reply: { ok: true, value: result.result } }
  } catch (err) {
    if (signal.aborted) throw err
    const body = errorText(err)
    logFailure($, `relayed tool ${name}`, 'n/a', body)
    return { callId, reply: { ok: false, error: body } }
  }
}

export async function handleExec($: ExecEngine, root: string, script: unknown, next: ExecNext): Promise<ToolCallResult> {
  if (typeof script !== 'string') {
    logFailure($, 'invalid exec input', 400, 'script must be a string')
    return { result: encodeFinal({ error: 'script must be a string' }), isError: true }
  }
  if (next.signal.aborted) {
    logFailure($, 'exec interrupted', 'n/a', 'dispatch signal was already aborted')
    return { result: encodeFinal({ error: 'exec interrupted' }), isError: true }
  }
  const remaining = next.budget.remainingMs
  const budgetLimit = Number.isFinite(remaining) ? Math.floor(remaining - BUDGET_RESERVE_MS) : SCRIPT_TIMEOUT_MS
  const timeoutMs = Math.min(SCRIPT_TIMEOUT_MS, budgetLimit)
  if (timeoutMs < 1) {
    const body = `insufficient hook budget (${Math.max(0, remaining)} ms remaining)`
    logFailure($, 'exec budget', 'n/a', body)
    return { result: encodeFinal({ error: body }), isError: true }
  }

  let sock = ''
  const id = runId()
  const token = controlToken()
  let runSubmitted = false
  let cancelled = false
  let cancelFlight: Promise<void> | undefined
  const cancelRun = () => {
    cancelled = true
    if (!sock || !runSubmitted) return Promise.resolve()
    if (!cancelFlight) {
      cancelFlight = fetchJson($, sock, '/cancel', token, { runId: id, controlToken: token }).then(() => {}).catch(err => {
        logFailure($, `cancel run ${id}`, 'n/a', errorText(err))
      })
    }
    return cancelFlight
  }
  const onAbort = () => { void cancelRun() }
  next.signal.addEventListener('abort', onAbort, { once: true })
  try {
    sock = await ensureDaemon($, root)
    if (next.signal.aborted) throw new Error('exec interrupted')
    const tools: ToolInfo[] = await $.tool.list()
    const names = new Set(tools.map(tool => tool.name))
    runSubmitted = true
    const started = await fetchJson($, sock, '/run', token, { runId: id, controlToken: token, script, tools, timeoutMs })
    if (started.runId !== id) throw new Error(`daemon started unexpected run ${String(started.runId)}`)
    if (cancelled || next.signal.aborted) throw new Error('exec interrupted')

    for (;;) {
      const message = await fetchJson($, sock, `/next?runId=${encodeURIComponent(id)}`, token)
      if (message.kind === 'call') {
        const { callId, reply } = await relay($, message, names, next.signal)
        if (next.signal.aborted) throw new Error('exec interrupted')
        const delivered = await fetchJson($, sock, '/result', token, { runId: id, callId, reply })
        if (delivered.delivered !== true) logFailure($, `return result for ${String(message.tool)}`, 409, encodeFinal(delivered, 2000))
        continue
      }
      if (message.kind === 'done') {
        const closed = await fetchJson($, sock, '/close', token, { runId: id })
        if (closed.closed !== true) logFailure($, `close run ${id}`, 409, encodeFinal(closed, 2000))
        if (message.ok === true) return { result: encodeFinal(message.value) }
        return { result: encodeFinal({ error: message.error ?? 'script failed', stack: message.stack ?? '' }), isError: true }
      }
      if (message.kind === 'pending') continue
      throw new Error(`unexpected daemon response: ${encodeFinal(message, 2000)}`)
    }
  } catch (err) {
    logFailure($, `exec ${id}`, 'n/a', errorText(err))
    daemonReady = undefined
    if (runSubmitted || sock) await cancelRun()
    return { result: encodeFinal({ error: errorText(err) }), isError: true }
  } finally {
    next.signal.removeEventListener('abort', onAbort)
    if (cancelled) await cancelFlight
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try { await ensureDaemon($, $.plugin.root) }
    catch (err) { logFailure($, 'session startup', 'n/a', errorText(err)) }
    try {
      await $.tool.register({
        name: 'exec',
        description: TOOL_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: { script: { type: 'string', description: 'JavaScript source. Use await tools.ToolName({...}) and return the value to send back.' } },
          required: ['script'],
          additionalProperties: false,
        },
      })
    } catch (err) {
      logFailure($, 'register exec tool', 'n/a', errorText(err))
      throw err
    }
    return started
  })

  on('tool.call', { tool: EXEC_TOOL }, async ($, e, next) => {
    const { script } = e
    if (typeof script !== 'string') {
      logFailure($, 'invalid exec input', 400, 'script must be a string')
      return { result: encodeFinal({ error: 'script must be a string' }), isError: true }
    }
    return handleExec($, $.plugin.root, script, next)
  })
}
