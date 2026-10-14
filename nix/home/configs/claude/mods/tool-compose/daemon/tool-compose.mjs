#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { READY_LINE, SANDBOX_PROFILE } from './protocol.mjs'

const requestedSocket = process.argv[2]
const fingerprint = process.argv[3] ?? 'unread'
if (!requestedSocket) {
  console.error('[tool-compose] startup failed; status=400; body=missing socket path')
  process.exit(2)
}

const MAX_SCRIPT_BYTES = 256 * 1024
const MAX_BODY_BYTES = 32 * 1024 * 1024
const MAX_TIMEOUT_MS = 30_000
const LONG_POLL_MS = 20_000
const RESULT_PREFIX = 'TOOL_COMPOSE_RESULT '
const requestedRunDir = path.dirname(requestedSocket)
const ownerPid = process.ppid
const runs = new Map()
const cancelledBeforeStart = new Map()
let socketInode
let closing = false

function logFailure(operation, status, body) {
  console.error(`[tool-compose] ${operation} failed; status=${status}; body=${String(body).slice(0, 4000)}`)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function reply(res, status, value) {
  const body = JSON.stringify(value)
  if (status >= 400) logFailure('HTTP response', status, body)
  if (!res.writableEnded && !res.destroyed) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.pause()
        reject(Object.assign(new Error(`request body exceeded ${MAX_BODY_BYTES} bytes`), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (err) { reject(Object.assign(new Error(`invalid JSON request body: ${err.message}`), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

function tokenFrom(req) {
  const token = req.headers['x-tool-compose-token']
  return typeof token === 'string' ? token : ''
}

function authenticated(req, run) {
  return Boolean(run && tokenFrom(req) && tokenFrom(req) === run.controlToken)
}

function pauseScriptTimer(run) {
  if (run.timer === undefined) return
  clearTimeout(run.timer)
  run.timer = undefined
  run.remainingMs = Math.max(0, run.remainingMs - (Date.now() - run.timerStartedAt))
}

function startScriptTimer(run) {
  if (run.state !== 'running' || run.pendingCalls.size > 0 || run.timer !== undefined) return
  if (run.remainingMs <= 0) return stopChild(run, `script timed out after ${run.timeoutMs} ms of execution`)
  run.timerStartedAt = Date.now()
  run.timer = setTimeout(() => stopChild(run, `script timed out after ${run.timeoutMs} ms of execution`), run.remainingMs)
}

function sendToChild(run, callId, response) {
  const pending = run.pendingCalls.get(callId)
  if (!pending) return false
  run.pendingCalls.delete(callId)
  if (run.state === 'running') {
    try { run.child?.stdio[3]?.write(`${JSON.stringify({ kind: 'result', callId, response })}\n`) }
    catch (err) { logFailure(`write relay result for ${run.id}/${callId}`, 'n/a', err?.stack ?? err) }
  }
  if (run.pendingCalls.size === 0) startScriptTimer(run)
  return true
}

function flushNext(run) {
  if (!run.waiter) return
  const waiter = run.waiter
  if (run.queue.length) {
    run.waiter = undefined
    clearTimeout(waiter.timer)
    reply(waiter.res, 200, run.queue.shift())
    return
  }
  if (run.state !== 'running') {
    run.waiter = undefined
    clearTimeout(waiter.timer)
    reply(waiter.res, 200, {
      kind: 'done',
      ok: run.state === 'completed',
      ...(run.state === 'completed' ? { value: run.value } : { error: run.error, stack: run.stack }),
    })
  }
}

function failPendingCalls(run, reason) {
  for (const callId of run.pendingCalls.keys()) sendToChild(run, callId, { ok: false, error: reason })
  run.queue.length = 0
}

function stopChild(run, reason) {
  if (run.state !== 'running') return
  pauseScriptTimer(run)
  run.state = 'cancelling'
  run.error = reason
  logFailure(`stop child for ${run.id}`, reason === 'exec cancelled' ? 'cancelled' : 'timeout', reason)
  failPendingCalls(run, reason)
  try { run.child?.kill('SIGTERM') }
  catch (err) { logFailure(`kill child for ${run.id}`, 'n/a', `${reason}; ${err?.stack ?? err}`) }
  run.killTimer = setTimeout(() => {
    if (run.child && run.state === 'cancelling') {
      try { run.child.kill('SIGKILL') }
      catch (err) { logFailure(`force-kill child for ${run.id}`, 'n/a', err?.stack ?? err) }
    }
  }, 750)
}

function childSource(script, tools) {
  const scriptLiteral = JSON.stringify(script)
  const toolsLiteral = JSON.stringify(JSON.stringify(tools))
  const resultPrefix = JSON.stringify(RESULT_PREFIX)
  return `
import fs from 'node:fs';
const inbound = fs.createReadStream(null, { fd: 3, encoding: 'utf8', autoClose: false });
const outbound = fs.createWriteStream(null, { fd: 3, encoding: 'utf8', autoClose: false });
const availableTools = JSON.parse(${toolsLiteral});
const toolNames = new Set(availableTools.map(tool => tool.name));
const pending = new Map();
let callSequence = 0;
let inputBuffer = '';
for (const name of ['kill', '_kill']) {
  Object.defineProperty(process, name, {
    value: () => { throw new Error('process.' + name + ' is disabled in tool-compose scripts'); },
    writable: false,
    configurable: false,
  });
}
function writeFrame(value) {
  outbound.write(JSON.stringify(value) + '\\n');
}
function callTool(name, input) {
  if (name === 'exec' || name === 'mcp__tool-compose__exec') return Promise.reject(new Error('recursive calls to tool-compose exec are refused'));
  if (!toolNames.has(name)) return Promise.reject(new Error('unknown Claude Code tool: ' + name));
  if (!input || typeof input !== 'object' || Array.isArray(input)) return Promise.reject(new TypeError('a tool call requires one object argument'));
  const callId = String(++callSequence);
  return new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject });
    try { writeFrame({ kind: 'call', callId, tool: name, input }); }
    catch (error) { pending.delete(callId); reject(error); }
  });
}
inbound.on('data', chunk => {
  inputBuffer += chunk;
  let newline;
  while ((newline = inputBuffer.indexOf('\\n')) >= 0) {
    const line = inputBuffer.slice(0, newline);
    inputBuffer = inputBuffer.slice(newline + 1);
    let frame;
    try { frame = JSON.parse(line); }
    catch (error) { process.stderr.write('invalid relay frame: ' + String(error) + '\\n'); process.exit(2); }
    const call = pending.get(frame.callId);
    if (!call) continue;
    pending.delete(frame.callId);
    if (frame.response?.ok === true) call.resolve(frame.response.value);
    else call.reject(new Error(String(frame.response?.error || 'relayed tool call failed')));
  }
});
inbound.on('error', error => {
  for (const call of pending.values()) call.reject(error);
  pending.clear();
});
const tools = new Proxy(Object.create(null), {
  get(_target, key) {
    if (key === 'list') return async () => availableTools;
    if (key === 'then' || key === 'toJSON' || key === Symbol.toStringTag || typeof key !== 'string') return undefined;
    return input => callTool(key, input);
  },
  ownKeys() { return [...availableTools.map(tool => tool.name), 'list']; },
  getOwnPropertyDescriptor() { return { enumerable: true, configurable: true }; },
});
const source = ${scriptLiteral};
async function main() {
  try {
    const execute = new Function('tools', 'return (async () => {\\n' + source + '\\n})()');
    const value = await execute(tools);
    process.stdout.write('\\n' + ${resultPrefix} + JSON.stringify({ ok: true, value: value === undefined ? null : value }) + '\\n', () => process.exit(0));
  } catch (error) {
    const result = { ok: false, error: String(error?.message || error), stack: String(error?.stack || '') };
    process.stdout.write('\\n' + ${resultPrefix} + JSON.stringify(result) + '\\n', () => process.exit(1));
  }
}
void main();
`
}

function failRun(run, error, stack = '') {
  if (run.state !== 'running') return
  pauseScriptTimer(run)
  run.error = error
  run.stack = stack
  run.state = 'failed'
  run.finishedAt = Date.now()
  logFailure(`script ${run.id}`, 1, `${error}; stack=${stack || '(empty)'}`)
  failPendingCalls(run, error)
  flushNext(run)
}

function acceptChildCall(run, frame) {
  if (!isRecord(frame) || frame.kind !== 'call' || typeof frame.callId !== 'string' || frame.callId.length < 1 || frame.callId.length > 100 || typeof frame.tool !== 'string' || !isRecord(frame.input)) {
    const body = JSON.stringify(frame)
    logFailure(`invalid child relay frame for ${run.id}`, 400, body)
    stopChild(run, 'invalid child relay frame')
    return
  }
  if (frame.tool === 'exec' || frame.tool === 'mcp__tool-compose__exec') {
    const body = `recursive calls to tool-compose exec are refused (${frame.callId})`
    logFailure(`recursive exec call in ${run.id}`, 403, body)
    try { run.child?.stdio[3]?.write(`${JSON.stringify({ kind: 'result', callId: frame.callId, response: { ok: false, error: body } })}\n`) }
    catch (err) { logFailure(`write recursive-call refusal for ${run.id}/${frame.callId}`, 'n/a', err?.stack ?? err) }
    return
  }
  if (run.pendingCalls.has(frame.callId)) {
    stopChild(run, `duplicate child call id ${frame.callId}`)
    return
  }
  pauseScriptTimer(run)
  run.pendingCalls.set(frame.callId, frame)
  run.queue.push({ kind: 'call', callId: frame.callId, tool: frame.tool, input: frame.input })
  flushNext(run)
}

function launchRun(payload, req, res) {
  if (!isRecord(payload)) return reply(res, 400, { error: 'run body must be an object' })
  const { runId, script, tools, timeoutMs, controlToken } = payload
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(runId)) return reply(res, 400, { error: 'runId must contain 1-100 letters, digits, underscores or hyphens' })
  if (typeof controlToken !== 'string' || controlToken.length < 32 || tokenFrom(req) !== controlToken) return reply(res, 401, { error: 'a matching per-run control token is required' })
  if (process.platform !== 'darwin') return reply(res, 501, { error: `exec is refused on ${process.platform}: a supported OS sandbox is required; refusing to run the script unsandboxed` })
  try { fs.accessSync('/usr/bin/sandbox-exec', fs.constants.X_OK) }
  catch (err) { return reply(res, 501, { error: `exec is refused because /usr/bin/sandbox-exec is unavailable: ${err.message}; refusing to run the script unsandboxed` }) }
  const cancelled = cancelledBeforeStart.get(runId)
  if (cancelled) {
    cancelledBeforeStart.delete(runId)
    if (cancelled.controlToken === controlToken) return reply(res, 409, { error: 'exec was cancelled before the script started' })
  }
  if (runs.has(runId)) return reply(res, 409, { error: `runId already exists: ${runId}` })
  if (typeof script !== 'string' || Buffer.byteLength(script) > MAX_SCRIPT_BYTES) return reply(res, 413, { error: `script must be a string no larger than ${MAX_SCRIPT_BYTES} bytes` })
  if (!Array.isArray(tools) || tools.some(tool => !isRecord(tool) || typeof tool.name !== 'string')) return reply(res, 400, { error: 'tools must be a list of named tools' })
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) return reply(res, 400, { error: `timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}` })

  const realRunDir = fs.realpathSync(requestedRunDir)
  const file = path.join(realRunDir, `script-${runId}.mjs`)
  if (Buffer.byteLength(file) > 1024) return reply(res, 400, { error: 'canonical script path is too long' })
  if (file.includes(',')) return reply(res, 400, { error: 'canonical script path contains a comma and cannot be represented as one Node --allow-fs-read grant' })
  const source = childSource(script, tools)
  try { fs.writeFileSync(file, source, { mode: 0o600, flag: 'wx' }) }
  catch (err) {
    logFailure(`write script ${runId}`, 'n/a', err?.stack ?? err)
    return reply(res, 500, { error: `could not write script file: ${err?.message ?? err}` })
  }
  const run = {
    id: runId, controlToken, timeoutMs, remainingMs: timeoutMs, timerStartedAt: 0,
    file, state: 'running', value: undefined, error: undefined, stack: undefined,
    child: undefined, childPid: undefined, childExit: undefined, queue: [], waiter: undefined,
    pendingCalls: new Map(), stdoutTail: '', stderrTail: '', timer: undefined, killTimer: undefined,
  }
  runs.set(runId, run)
  try {
    run.child = spawn('/usr/bin/sandbox-exec', ['-p', SANDBOX_PROFILE, process.execPath, '--permission', `--allow-fs-read=${file}`, file], {
      cwd: realRunDir,
      env: {},
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    })
    run.childPid = run.child.pid
    run.child.stdout.setEncoding('utf8')
    run.child.stderr.setEncoding('utf8')
    run.child.stdio[3].setEncoding('utf8')
    let stdoutBuffer = ''
    let relayBuffer = ''
    run.child.stdout.on('data', chunk => {
      stdoutBuffer += chunk
      run.stdoutTail = (run.stdoutTail + chunk).slice(-4000)
      let newline
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).trimEnd()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (!line.startsWith(RESULT_PREFIX)) continue
        try {
          const parsed = JSON.parse(line.slice(RESULT_PREFIX.length))
          if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') throw new Error('result must be an object with a boolean ok field')
          if (parsed.ok) { run.value = parsed.value; run.state = 'completed'; pauseScriptTimer(run); flushNext(run) }
          else failRun(run, typeof parsed.error === 'string' ? parsed.error : 'script failed', typeof parsed.stack === 'string' ? parsed.stack : '')
        } catch (err) {
          failRun(run, `invalid child result JSON: ${err?.message ?? err}`, run.stderrTail || line)
        }
      }
    })
    run.child.stderr.on('data', chunk => { run.stderrTail = (run.stderrTail + chunk).slice(-4000) })
    run.child.stdio[3].on('data', chunk => {
      relayBuffer += chunk
      let newline
      while ((newline = relayBuffer.indexOf('\n')) >= 0) {
        const line = relayBuffer.slice(0, newline)
        relayBuffer = relayBuffer.slice(newline + 1)
        try { acceptChildCall(run, JSON.parse(line)) }
        catch (err) { stopChild(run, `invalid child relay JSON: ${err?.message ?? err}`) }
      }
    })
    run.child.on('error', err => failRun(run, `sandboxed child could not start: ${err?.message ?? err}`, err?.stack ?? ''))
    run.child.on('close', (code, signal) => {
      clearTimeout(run.timer)
      clearTimeout(run.killTimer)
      run.childExit = { code, signal }
      run.child = undefined
      if (run.state === 'cancelling') run.state = 'cancelled'
      else if (run.state === 'running') {
        run.state = 'failed'
        run.error = `script exited without a result; status=${code === null ? `signal ${signal}` : `code ${code}`}`
        run.stack = run.stderrTail || run.stdoutTail
        logFailure(`script ${runId}`, code === null ? signal ?? 'n/a' : code, `${run.error}; stderr=${run.stderrTail || '(empty)'}; stdout=${run.stdoutTail || '(empty)'}`)
      }
      run.finishedAt = Date.now()
      failPendingCalls(run, run.error || 'script has finished')
      flushNext(run)
      try { fs.unlinkSync(file) }
      catch (err) { logFailure(`remove script ${runId}`, 'n/a', err?.stack ?? err) }
    })
    startScriptTimer(run)
  } catch (err) {
    runs.delete(runId)
    try { fs.unlinkSync(file) } catch (cleanupErr) { logFailure(`remove failed script ${runId}`, 'n/a', cleanupErr?.stack ?? cleanupErr) }
    logFailure(`launch script ${runId}`, 'n/a', err?.stack ?? err)
    return reply(res, 500, { error: `could not launch sandboxed script: ${err?.message ?? err}` })
  }
  reply(res, 202, { runId, pid: run.childPid })
}

async function route(req, res) {
  const url = new URL(req.url, 'http://tool-compose')
  if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ready: true, fingerprint, pid: process.pid })
  if (req.method === 'POST' && url.pathname === '/run') return launchRun(await readBody(req), req, res)
  if (req.method === 'GET' && url.pathname === '/next') {
    const runId = url.searchParams.get('runId')
    const run = runs.get(runId)
    if (!authenticated(req, run)) return reply(res, 401, { error: 'a valid per-run control token is required' })
    if (run.queue.length) return reply(res, 200, run.queue.shift())
    if (run.state !== 'running' && run.state !== 'cancelling') return reply(res, 200, {
      kind: 'done', ok: run.state === 'completed',
      ...(run.state === 'completed' ? { value: run.value } : { error: run.error, stack: run.stack }),
    })
    if (run.waiter) return reply(res, 409, { error: `a /next request is already waiting for run ${run.id}` })
    const waiter = { res, timer: undefined }
    run.waiter = waiter
    waiter.timer = setTimeout(() => {
      if (run.waiter !== waiter) return
      run.waiter = undefined
      reply(res, 200, { kind: 'pending' })
    }, LONG_POLL_MS)
    res.on('close', () => {
      if (run.waiter === waiter) { clearTimeout(waiter.timer); run.waiter = undefined }
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/result') {
    const body = await readBody(req)
    const run = isRecord(body) ? runs.get(body.runId) : undefined
    if (!authenticated(req, run)) return reply(res, 401, { error: 'a valid per-run control token is required' })
    if (typeof body.callId !== 'string' || !run.pendingCalls.has(body.callId)) return reply(res, 404, { error: `no pending call ${String(body.callId)} for run ${run.id}` })
    if (!isRecord(body.reply) || typeof body.reply.ok !== 'boolean') return reply(res, 400, { error: 'reply must include a boolean ok field' })
    const delivered = sendToChild(run, body.callId, body.reply)
    return reply(res, 200, { delivered })
  }
  if (req.method === 'POST' && url.pathname === '/cancel') {
    const body = await readBody(req)
    if (!isRecord(body) || typeof body.runId !== 'string' || typeof body.controlToken !== 'string' || body.controlToken !== tokenFrom(req)) return reply(res, 401, { error: 'a matching per-run control token is required' })
    const run = runs.get(body.runId)
    if (run && !authenticated(req, run)) return reply(res, 401, { error: 'a valid per-run control token is required' })
    if (!run) {
      cancelledBeforeStart.set(body.runId, { controlToken: body.controlToken, createdAt: Date.now() })
      return reply(res, 200, { cancelled: true, started: false })
    }
    stopChild(run, 'exec cancelled')
    flushNext(run)
    return reply(res, 200, { cancelled: true, started: true })
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    const run = runs.get(url.searchParams.get('runId'))
    if (!authenticated(req, run)) return reply(res, 401, { error: 'a valid per-run control token is required' })
    return reply(res, 200, {
      runId: run.id, state: run.state, pid: run.childPid, childExit: run.childExit,
      pendingCalls: run.pendingCalls.size, stderr: run.stderrTail,
    })
  }
  if (req.method === 'POST' && url.pathname === '/close') {
    const body = await readBody(req)
    const run = isRecord(body) ? runs.get(body.runId) : undefined
    if (!authenticated(req, run)) return reply(res, 401, { error: 'a valid per-run control token is required' })
    if (run.state === 'running' || run.state === 'cancelling') return reply(res, 409, { error: `run ${run.id} is still active` })
    runs.delete(run.id)
    return reply(res, 200, { closed: true })
  }
  return reply(res, 404, { error: `no route ${req.method} ${url.pathname}` })
}

const server = http.createServer((req, res) => {
  void route(req, res).catch(err => {
    const status = err?.status ?? 500
    const body = { error: err?.stack ?? String(err) }
    logFailure(`${req.method} ${req.url}`, status, JSON.stringify(body))
    reply(res, status, body)
  })
})

function shutdown(reason) {
  if (closing) return
  closing = true
  console.error(`[tool-compose] shutting down; status=200; body=${reason}`)
  const childClosures = []
  for (const run of runs.values()) {
    stopChild(run, `daemon shutdown: ${reason}`)
    flushNext(run)
    if (run.child) childClosures.push(new Promise(resolve => run.child.once('close', resolve)))
  }
  try {
    server.close(() => {
      void Promise.all(childClosures).then(() => {
        try {
          if (socketInode !== undefined && fs.statSync(socketPath).ino === socketInode) fs.unlinkSync(socketPath)
        } catch (err) { if (err?.code !== 'ENOENT') logFailure('remove socket', 'n/a', err?.stack ?? err) }
        process.exit(0)
      })
    })
    server.closeAllConnections?.()
  } catch (err) {
    logFailure('close server', 'n/a', `${reason}; ${err?.stack ?? err}`)
    process.exit(1)
  }
}

let socketPath
try {
  fs.mkdirSync(requestedRunDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(requestedRunDir, 0o700)
  const realRunDir = fs.realpathSync(requestedRunDir)
  socketPath = path.join(realRunDir, path.basename(requestedSocket))
  if (Buffer.byteLength(requestedSocket) > 103 || Buffer.byteLength(socketPath) > 103) throw new Error(`Unix socket path exceeds the 103-byte sun_path limit: ${socketPath}`)
  try { fs.unlinkSync(socketPath) } catch (err) { if (err?.code !== 'ENOENT') throw err }
} catch (err) {
  logFailure('socket path setup', 'n/a', err?.stack ?? err)
  process.exit(2)
}

server.on('error', err => {
  logFailure('socket server', 'n/a', err?.stack ?? err)
  process.exit(1)
})
server.listen(socketPath, () => {
  try {
    fs.chmodSync(socketPath, 0o600)
    socketInode = fs.statSync(socketPath).ino
  } catch (err) {
    logFailure('socket setup', 'n/a', err?.stack ?? err)
    shutdown('socket setup failed')
    return
  }
  process.stdout.write(`${JSON.stringify({ ready: true, fingerprint, pid: process.pid })} ${READY_LINE}\n`)
})

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => shutdown(signal))
setInterval(() => {
  try {
    if (fs.statSync(socketPath).ino !== socketInode) shutdown('socket replaced')
  } catch { shutdown('socket removed') }
  try { process.kill(ownerPid, 0) }
  catch (err) { if (err?.code === 'ESRCH') shutdown(`owner ${ownerPid} exited`); else if (err?.code !== 'EPERM') logFailure('owner liveness check', 'n/a', err?.stack ?? err) }
  for (const [id, cancelled] of cancelledBeforeStart) if (Date.now() - cancelled.createdAt > 60_000) cancelledBeforeStart.delete(id)
  for (const [id, run] of runs) if (run.finishedAt && Date.now() - run.finishedAt > 60_000) runs.delete(id)
}, 5000).unref()
