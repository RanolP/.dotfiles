#!/usr/bin/env node
// HTTP-on-unix-socket bridge from the Claude mod to Antigravity's ACP stdio server.
let separator = '/'
let resolvePath = value => {
  const absolute = value.startsWith('/') ? value : `${process.cwd()}/${value}`
  const parts = []
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}
const inside = (target, root) => target === root || target.startsWith(root.endsWith(separator) ? root : `${root}${separator}`)

export const decidePermission = (toolCall, { sandbox, writableRoots, tmpDir }) => {
  if (sandbox === 'read-only') return toolCall?.kind === 'read' || toolCall?.kind === 'search' ? 'allow' : 'deny'
  if (String(toolCall?.name ?? '').startsWith('mcp_')) return 'allow'
  if (toolCall?.kind === 'execute') return 'allow'
  if (toolCall?.kind !== 'edit') return 'deny'
  const locations = toolCall.locations ?? []
  if (!locations.length) return 'deny'
  const allowedRoots = [...writableRoots, tmpDir].map(root => resolvePath(root))
  return locations.every(location => {
    if (typeof location?.path !== 'string') return false
    const target = resolvePath(location.path)
    return allowedRoots.some(root => inside(target, root))
  }) ? 'allow' : 'deny'
}

export const readOnlyMode = modes => {
  const modeIds = modes?.availableModes?.map(mode => mode.id).filter(id => typeof id === 'string') ?? []
  return { modeIds, modeId: modeIds.includes('default') ? 'default' : undefined }
}

const childPendingHandlers = pending => {
  const reject = error => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  return { error: reject, exit: reject }
}

const clearQueuedEvents = queue => { queue.length = 0 }

const consumePendingInterrupt = (session, pendingInterrupts) => {
  const cancelled = Boolean(session.cancelRequested) || pendingInterrupts.delete(session.key)
  session.cancelRequested = false
  return cancelled
}

export const installChildPending = session => {
  const pending = new Map()
  session.pending = pending
  return { pending, handlers: childPendingHandlers(pending) }
}

export const beginAcpPrompt = (session, pendingInterrupts, emit) => {
  if (!consumePendingInterrupt(session, pendingInterrupts)) return true
  emit(session.key, { final: { text: '', status: 'cancelled', errors: [] } })
  return false
}

export const runAcpStep = async (body, { open, box, prompt }) => {
  const session = await open(body)
  if (body.toolResult) throw new Error('ACP bridge does not relay Claude-side tools')
  if (body.prompt === undefined) throw new Error('step needs prompt')
  if (session.active) { session.nextPrompts.push(body.prompt); return }
  clearQueuedEvents(box(body.key).queue)
  await prompt(session, body.prompt)
}

export const interruptAcp = ({ key }, { sessions, inFlight, pendingInterrupts }) => {
  const session = sessions.get(key)
  if (!session) {
    if (!inFlight.has(key)) return { interrupted: false }
    pendingInterrupts.add(key)
    return { interrupted: true, deferred: true }
  }
  if (!session.active) {
    if (!inFlight.has(key)) return { interrupted: false }
    session.cancelRequested = true
    return { interrupted: true, deferred: true }
  }
  session.nextPrompts = []
  session.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session.sessionId } })
  return { interrupted: true }
}

export const finalAgentMessage = messages => messages.findLast(message => message.trim()) ?? ''

const permissionTarget = toolCall => (toolCall?.locations ?? []).map(location => location.path).join(', ') || JSON.stringify(toolCall?.rawInput ?? {})

export const finalTurnText = session => {
  const message = finalAgentMessage(session.messages)
  if (message || !session.denials.length) return message
  const roots = session.writableRoots.join(', ')
  return session.denials.map(({ name, target }) => `agy ended the turn after a denied ${name}: ${target} (outside the writable roots: ${roots}).`).join('\n')
}

export function handleAcpLine(line, { pending, sessions, write, log }) {
  let message
  try { message = JSON.parse(line) } catch { log('[acp-bridge] unparsable line', line.slice(0, 300)); return }
  if (message.id !== undefined && message.method === undefined) {
    const request = pending.get(message.id)
    pending.delete(message.id)
    if (!request) return
    if (message.error) request.reject(new Error(`${request.method}: ${JSON.stringify(message.error)}`))
    else request.resolve(message.result)
    return
  }
  const params = message.params ?? {}
  if (message.method === 'session/request_permission') {
    const session = sessions.get(params.sessionId)
    const decision = session ? decidePermission(params.toolCall, session) : 'deny'
    const wantedKind = decision === 'allow' ? 'allow_once' : 'reject_once'
    const option = params.options?.find(candidate => candidate.kind === wantedKind)
    const target = permissionTarget(params.toolCall)
    log(`[acp-bridge] permission ${decision} tool=${params.toolCall?.name ?? '(unknown)'} target=${target}`)
    if (session && decision === 'deny') (session.denials ??= []).push({ name: params.toolCall?.name ?? '(unknown)', target })
    if (option) write({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: option.optionId } } })
    else write({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `no ${wantedKind} permission option` } })
    return
  }
  if (message.method === 'session/update') {
    const session = sessions.get(params.sessionId)
    const update = params.update ?? {}
    if (!session) return
    if (update.sessionUpdate === 'agent_message_chunk' && typeof update.content?.text === 'string') {
      if (!session.messages.length) session.messages.push('')
      session.messages[session.messages.length - 1] += update.content.text
    }
    else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      session.messages.push('')
      const target = (update.locations ?? []).map(location => location.path).join(', ') || JSON.stringify(update.rawInput ?? {})
      log(`[acp-bridge] tool ${update.status ?? 'unknown'} name=${update.name ?? '(unknown)'} kind=${update.kind ?? '(unknown)'} target=${target}`)
    }
    return
  }
  if (message.id !== undefined && message.method)
    write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `hetero-subagents does not serve ${message.method}` } })
}

async function main() {
  const { spawn } = process.getBuiltinModule('node:child_process')
  const http = process.getBuiltinModule('node:http')
  const fs = process.getBuiltinModule('node:fs')
  const os = process.getBuiltinModule('node:os')
  const path = process.getBuiltinModule('node:path')
  separator = path.sep
  resolvePath = path.resolve
  const sock = process.argv[2]
  const fingerprint = process.argv[3] ?? null
  if (!sock) { console.error('usage: acp-bridge.mjs <socket-path> [fingerprint]'); process.exit(2) }
  const runDir = path.dirname(sock)
  const stateFile = sock.replace(/\.sock$/, '.state.json')
  const parent = process.ppid
  let sockIno
  fs.mkdirSync(runDir, { recursive: true })
  try { fs.unlinkSync(sock) } catch (error) { if (error?.code !== 'ENOENT') throw error }

  const logFile = sock.replace(/\.sock$/, '.bridge.log')
  const LOG_MAX = 1 << 20
  const logLines = (stream, chunk) => {
    try {
      let size = 0
      try { size = fs.statSync(logFile).size } catch {}
      if (size > LOG_MAX) fs.renameSync(logFile, `${logFile}.1`)
      const stamp = `${new Date().toISOString()} pid=${process.pid} ${stream}`
      fs.appendFileSync(logFile, String(chunk).replace(/\n$/, '').split('\n').map(line => `${stamp} ${line}\n`).join(''))
    } catch {}
  }
  for (const [name, output] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
    const write = output.write.bind(output)
    output.write = (chunk, ...rest) => { logLines(name, chunk); return write(chunk, ...rest) }
  }
  process.on('exit', code => logLines('exit', `code=${code}`))

  const sessions = new Map()
  const bySessionId = new Map()
  const boxes = new Map()
  const inFlight = new Set()
  const pendingInterrupts = new Set()
  const box = key => { let value = boxes.get(key); if (!value) boxes.set(key, value = { queue: [], waiter: null }); return value }
  const emit = (key, event) => {
    const value = box(key)
    if (value.waiter) { const waiter = value.waiter; value.waiter = null; waiter(event) } else value.queue.push(event)
  }
  let persisted = { ownerPid: process.pid, socket: sock, agents: {} }
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (state && typeof state.agents === 'object') persisted.agents = state.agents
  } catch (error) { if (error?.code !== 'ENOENT') console.error('[acp-bridge] state read failed', stateFile, String(error?.message ?? error)) }

  const writeJsonAtomic = (file, value) => {
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
    fs.renameSync(temp, file)
  }
  const saveState = () => {
    if (sockIno !== undefined) {
      try { if (fs.statSync(sock).ino !== sockIno) return } catch { return }
    }
    persisted.ownerPid = process.pid
    persisted.socket = sock
    writeJsonAtomic(stateFile, persisted)
  }
  saveState()

  const stopChild = session => {
    if (!session.child) return
    session.stopping = true
    session.child.kill('SIGTERM')
    session.child = undefined
    session.pending = undefined
    if (session.sessionId) bySessionId.delete(session.sessionId)
  }

  const startChild = async session => {
    stopChild(session)
    const args = ['acp', ...session.writableRoots.flatMap(root => ['--add-dir', root])]
    const child = spawn('agy', args, { cwd: session.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    session.child = child
    session.stopping = false
    const { pending, handlers: pendingHandlers } = installChildPending(session)
    session.nextId = 0
    const write = message => child.stdin.write(`${JSON.stringify(message)}\n`)
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++session.nextId
      pending.set(id, { resolve, reject, method })
      write({ jsonrpc: '2.0', id, method, params })
    })
    session.write = write
    session.rpc = rpc
    let buffer = ''
    child.stdout.on('data', data => {
      buffer += data
      let newline
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim()) handleAcpLine(line, { pending, sessions: bySessionId, write, log: message => console.error(message) })
      }
    })
    child.stderr.on('data', data => process.stderr.write(`[agy] ${data}`))
    child.on('error', pendingHandlers.error)
    child.on('exit', (code, signal) => {
      const current = child === session.child
      const expected = session.stopping || !current
      if (current) {
        session.child = undefined
        if (session.sessionId) bySessionId.delete(session.sessionId)
      }
      session.stopping = false
      const error = new Error(`agy acp exited code=${code} signal=${signal}`)
      pendingHandlers.exit(error)
      if (!expected) console.error('[acp-bridge] agy exited unexpectedly', error.message)
    })
    await Promise.race([
      rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('agy initialize timed out after 15000ms')), 15000)),
    ])
    // Claude-side MCP and built-in tool relay is the next ACP integration step.
    const mcpServers = []
    let opened
    if (session.sessionId) {
      bySessionId.set(session.sessionId, session)
      opened = await rpc('session/load', { sessionId: session.sessionId, cwd: session.cwd, mcpServers })
    }
    else {
      opened = await rpc('session/new', { cwd: session.cwd, mcpServers })
      session.sessionId = opened.sessionId
    }
    bySessionId.set(session.sessionId, session)
    await rpc('session/set_model', { sessionId: session.sessionId, modelId: session.model })
    const { modeIds, modeId } = readOnlyMode(opened.modes)
    console.error(`[acp-bridge] session modes: ${modeIds.join(', ') || '<none>'}`)
    if (session.sandbox === 'read-only') {
      if (!modeId) throw new Error(`agy reported no non-accept-edits mode; available modes: ${modeIds.join(', ') || '<none>'}`)
      await rpc('session/set_mode', { sessionId: session.sessionId, modeId })
    } else {
      try { await rpc('session/set_mode', { sessionId: session.sessionId, modeId: 'accept-edits' }) }
      catch (error) { console.error('[acp-bridge] session/set_mode failed; continuing in default mode', String(error?.message ?? error)) }
    }
    session.rootsAtSpawn = JSON.stringify(session.writableRoots)
    persisted.agents[session.key] = { type: session.agentType, cwd: session.cwd, writableRoots: session.writableRoots, threadId: session.sessionId }
    saveState()
  }

  const ensureChild = async session => {
    if (!session.child || session.rootsAtSpawn !== JSON.stringify(session.writableRoots)) await startChild(session)
  }

  const open = async body => {
    let session = sessions.get(body.key)
    if (session) {
      if (body.writableRoots?.length) session.writableRoots = [...body.writableRoots]
      return session
    }
    session = {
      key: body.key,
      agentType: body.agentType,
      cwd: body.cwd,
      writableRoots: body.writableRoots?.length ? [...body.writableRoots] : [body.cwd],
      tmpDir: process.env.TMPDIR || os.tmpdir(),
      sessionId: body.threadId,
      model: body.model,
      sandbox: body.sandbox ?? 'read-only',
      resumed: Boolean(body.threadId),
      developerInstructions: body.developerInstructions,
      instructionsSent: Boolean(body.threadId),
      messages: [],
      denials: [],
      errors: [],
      usage: null,
      active: false,
      cancelRequested: false,
      nextPrompts: [],
    }
    sessions.set(body.key, session)
    await ensureChild(session)
    return session
  }

  const prompt = async (session, text) => {
    await ensureChild(session)
    if (!beginAcpPrompt(session, pendingInterrupts, emit)) return
    session.active = true
    session.messages = []
    session.denials = []
    session.errors = []
    const blocks = []
    if (!session.instructionsSent && session.developerInstructions) blocks.push({ type: 'text', text: session.developerInstructions })
    blocks.push({ type: 'text', text })
    session.instructionsSent = true
    let result
    try { result = await session.rpc('session/prompt', { sessionId: session.sessionId, prompt: blocks }) }
    catch (error) { session.active = false; throw error }
    session.usage = result.usage ? {
      inputTokens: result.usage.inputTokens ?? 0,
      cachedInputTokens: result.usage.cachedReadTokens ?? 0,
      cacheWriteInputTokens: result.usage.cachedWriteTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      reasoningOutputTokens: result.usage.thoughtTokens ?? 0,
      totalTokens: result.usage.totalTokens ?? 0,
    } : null
    if (session.nextPrompts.length) {
      const next = session.nextPrompts.splice(0).join('\n\n')
      return prompt(session, next)
    }
    session.active = false
    persisted.agents[session.key] = { type: session.agentType, cwd: session.cwd, writableRoots: session.writableRoots, threadId: session.sessionId }
    saveState()
    emit(session.key, { final: { text: finalTurnText(session), status: result.stopReason, errors: session.errors } })
  }

  const run = body => runAcpStep(body, { open, box, prompt })
  const step = body => {
    if (!body.key) throw new Error('step needs key')
    if (body.prompt !== undefined) {
      pendingInterrupts.delete(body.key)
      const session = sessions.get(body.key)
      if (session) session.cancelRequested = false
    }
    inFlight.add(body.key)
    run(body).catch(error => { console.error('[acp-bridge] step failed', body.key, error); emit(body.key, { error: String(error?.message ?? error) }) }).finally(() => inFlight.delete(body.key))
    return { pending: true }
  }
  const decorate = (key, event) => {
    const session = sessions.get(key)
    return { ...event, threadId: session?.sessionId, model: session?.model, resumed: session?.resumed, bridgePid: process.pid, codexPid: session?.child?.pid ?? 0, usage: session?.usage ?? null }
  }
  const wait = async ({ key }, response) => {
    const value = box(key)
    if (value.queue.length) return decorate(key, value.queue.shift())
    if (!sessions.has(key) && !inFlight.has(key)) return { error: 'unknown key' }
    let waiter
    const event = await new Promise(resolve => {
      waiter = resolve
      value.waiter = waiter
      const timer = setTimeout(() => { if (value.waiter === waiter) { value.waiter = null; resolve(null) } }, 25000)
      response.on('close', () => { clearTimeout(timer); if (value.waiter === waiter) { value.waiter = null; resolve(null) } })
    })
    if (!event) return { pending: true }
    if (response.destroyed) { value.queue.unshift(event); return { pending: true } }
    return decorate(key, event)
  }
  const interrupt = body => interruptAcp(body, { sessions, inFlight, pendingInterrupts })
  const recover = ({ key }) => {
    const session = sessions.get(key)
    const agent = session
      ? { type: session.agentType, cwd: session.cwd, writableRoots: session.writableRoots, threadId: session.sessionId }
      : persisted.agents[key]
    return agent?.type && agent.cwd ? { found: true, ...agent } : { found: false }
  }
  const remember = ({ key, type, cwd, writableRoots }) => {
    if (!key || !type || !cwd) throw new Error('remember needs key, type, and cwd')
    persisted.agents[key] = { type, cwd, writableRoots: writableRoots?.length ? writableRoots : [cwd], ...(persisted.agents[key]?.threadId ? { threadId: persisted.agents[key].threadId } : {}) }
    saveState()
    return { remembered: true }
  }

  const server = http.createServer(async (request, response) => {
    const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    try {
      if (request.method === 'GET' && request.url === '/health') {
        const busy = [...new Set([...inFlight, ...[...sessions.values()].filter(session => session.active).map(session => session.key)])]
        return reply(200, { bridgePid: process.pid, codexPid: 0, fingerprint, busy, threads: [...sessions.values()].map(session => [session.key, session.sessionId]) })
      }
      let body = ''
      for await (const chunk of request) body += chunk
      if (request.method === 'POST' && request.url === '/step') return reply(200, step(JSON.parse(body)))
      if (request.method === 'POST' && request.url === '/wait') return reply(200, await wait(JSON.parse(body), response))
      if (request.method === 'POST' && request.url === '/interrupt') return reply(200, interrupt(JSON.parse(body)))
      if (request.method === 'POST' && request.url === '/recover') return reply(200, recover(JSON.parse(body)))
      if (request.method === 'POST' && request.url === '/remember') return reply(200, remember(JSON.parse(body)))
      reply(404, { error: `no route ${request.method} ${request.url}` })
    } catch (error) {
      console.error('[acp-bridge] request failed', request.method, request.url, error)
      reply(500, { error: String(error?.message ?? error) })
    }
  })
  server.requestTimeout = 0
  server.headersTimeout = 0
  server.listen(sock, () => {
    try { sockIno = fs.statSync(sock).ino; saveState() } catch (error) { shutdown(`socket setup failed: ${String(error?.message ?? error)}`); return }
    console.log(JSON.stringify({ ready: true, sock, bridgePid: process.pid }))
  })

  let shuttingDown = false
  const shutdown = why => {
    if (shuttingDown) return
    shuttingDown = true
    console.error('[acp-bridge] exiting:', why)
    try { if (fs.statSync(sock).ino === sockIno) fs.unlinkSync(sock) } catch {}
    for (const session of sessions.values()) stopChild(session)
    try { server.close() } catch {}
    setImmediate(() => process.exit(0))
  }
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => shutdown(signal))
  setInterval(() => {
    if (process.ppid !== parent) shutdown(`parent ${parent} gone`)
    let inode
    try { inode = fs.statSync(sock).ino } catch {}
    if (sockIno !== undefined && inode !== sockIno) shutdown('socket replaced by another bridge')
  }, 2000).unref()
}

// Compare real paths: home-manager runs this file through a symlink, and node resolves import.meta.url to its target.
const isEntry = () => { try { const fs = process.getBuiltinModule('node:fs'); return fs.realpathSync(process.argv[1]) === fs.realpathSync(decodeURIComponent(new URL(import.meta.url).pathname)) } catch { return false } }
if (typeof process !== 'undefined' && process.argv[1] && isEntry()) await main()
