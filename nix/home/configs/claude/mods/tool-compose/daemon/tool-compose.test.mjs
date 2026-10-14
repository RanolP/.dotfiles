import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { READY_LINE, SANDBOX_PROFILE } from './protocol.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const daemon = path.join(here, 'tool-compose.mjs')
const READY = READY_LINE

class EnvironmentBlocked extends Error {}

function blockedByOuterSandbox(text) {
  return /Operation not permitted|EPERM/.test(text)
}

function request(socketPath, route, method = 'GET', value, token = '', timeoutMs = 5000) {
  const body = value === undefined ? undefined : JSON.stringify(value)
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath, path: route, method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
        ...(token ? { 'x-tool-compose-token': token } : {}),
      },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }) }
        catch (err) { reject(new Error(`status=${res.statusCode}; body=${text}; ${err}`)) }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`request timed out after ${timeoutMs} ms; route=${route}`)))
    req.end(body)
  })
}

async function startDaemon() {
  const root = await fs.mkdtemp(path.join('/tmp', 'tc-'))
  const socketPath = path.join(root, 's.sock')
  const child = spawn(process.execPath, [daemon, socketPath, 'test-fingerprint'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let readyResolve
  let readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  child.stdout.on('data', chunk => {
    stdout = (stdout + chunk).slice(-4000)
    if (stdout.includes(READY)) readyResolve()
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  child.once('exit', (code, signal) => readyReject(new Error(`daemon exited before ready; status=${code ?? signal}; stdout=${stdout}; stderr=${stderr}`)))
  try {
    let timer
    try {
      await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`daemon readiness timed out; stdout=${stdout}; stderr=${stderr}`)), 5000) })])
    } finally { clearTimeout(timer) }
  } catch (err) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'close').catch(() => {})
    }
    await fs.rm(root, { recursive: true, force: true })
    if (/listen EPERM|listen EACCES|socket path setup.*Operation not permitted/i.test(`${err.message} ${stderr}`))
      throw new EnvironmentBlocked(`Unix-domain socket tests blocked by the enclosing sandbox: ${stderr || err.message}`)
    throw err
  }
  const directoryMode = (await fs.stat(root)).mode & 0o777
  const socketMode = (await fs.stat(socketPath)).mode & 0o777
  return {
    root, socketPath, child, directoryMode, socketMode, get stderr() { return stderr },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        await once(child, 'close')
      }
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

async function daemonFor(t) {
  try {
    const harness = await startDaemon()
    t.after(() => harness.close())
    return harness
  } catch (err) {
    if (err instanceof EnvironmentBlocked) { t.skip(err.message); return undefined }
    throw err
  }
}

function token() { return `${crypto.randomUUID()}${crypto.randomUUID()}` }

async function startRun(harness, script, timeoutMs = 10_000) {
  const runId = `test-${crypto.randomUUID().replaceAll('-', '')}`
  const controlToken = token()
  const response = await request(harness.socketPath, '/run', 'POST', {
    runId, controlToken, script,
    tools: [{ name: 'Read', description: 'Read a file', mcp: false }, { name: 'Grep', description: 'Search files', mcp: false }],
    timeoutMs,
  }, controlToken)
  return { runId, controlToken, response }
}

async function executeThroughRelay(harness, script, respond, timeoutMs = 10_000) {
  const started = await startRun(harness, script, timeoutMs)
  assert.equal(started.response.status, 202, `run start status=${started.response.status}; body=${JSON.stringify(started.response.body)}`)
  for (let i = 0; i < 100; i++) {
    const next = await request(harness.socketPath, `/next?runId=${encodeURIComponent(started.runId)}`, 'GET', undefined, started.controlToken)
    assert.equal(next.status, 200, `poll status=${next.status}; body=${JSON.stringify(next.body)}`)
    if (next.body.kind === 'call') {
      const value = await respond(next.body.tool, next.body.input)
      const delivered = await request(harness.socketPath, '/result', 'POST', {
        runId: started.runId, callId: next.body.callId, reply: { ok: true, value },
      }, started.controlToken)
      assert.equal(delivered.status, 200, `result status=${delivered.status}; body=${JSON.stringify(delivered.body)}`)
    } else if (next.body.kind === 'done') {
      const closed = await request(harness.socketPath, '/close', 'POST', { runId: started.runId }, started.controlToken)
      assert.equal(closed.status, 200, `close status=${closed.status}; body=${JSON.stringify(closed.body)}`)
      return next.body
    } else assert.equal(next.body.kind, 'pending')
  }
  await request(harness.socketPath, '/cancel', 'POST', { runId: started.runId, controlToken: started.controlToken }, started.controlToken)
  throw new Error(`script did not finish; daemon stderr=${harness.stderr}`)
}

async function foreignSocket(t) {
  const root = await fs.mkdtemp(path.join('/tmp', 'tc-'))
  const socketPath = path.join(root, 'f.sock')
  const server = net.createServer(connection => connection.end('foreign socket'))
  try { await new Promise((resolve, reject) => server.once('error', reject).listen(socketPath, resolve)) }
  catch (err) {
    await fs.rm(root, { recursive: true, force: true })
    if (blockedByOuterSandbox(`${err.code} ${err.message}`)) throw new EnvironmentBlocked(`foreign Unix-socket setup blocked by the enclosing sandbox: ${err.code}: ${err.message}`)
    throw err
  }
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await fs.rm(root, { recursive: true, force: true })
  })
  return socketPath
}

function sandboxProbe(socketPath) {
  const source = `
import net from 'node:net';
const socket = net.createConnection({path:${JSON.stringify(socketPath)}});
const connect = await new Promise(resolve => { socket.once('connect', () => { socket.destroy(); resolve('connected') }); socket.once('error', error => resolve(error.code || error.name)); });
let signal;
try { process.kill(process.ppid, 0); signal = 'allowed'; } catch (error) { signal = error.code || error.name; }
process.stdout.write(JSON.stringify({connect, signal}));
`
  return spawnSync('/usr/bin/sandbox-exec', ['-p', SANDBOX_PROFILE, process.execPath, '--input-type=module', '-e', source], { encoding: 'utf8', timeout: 5000 })
}

// Regression: daemon readiness and a two-call script both fail when hook and daemon read different READY markers.
test('a real script composes two tool calls through the pipe relay', async t => {
  const harness = await daemonFor(t)
  if (!harness) return
  assert.equal(harness.directoryMode, 0o700, `run directory mode=${harness.directoryMode.toString(8)}`)
  assert.equal(harness.socketMode, 0o600, `socket mode=${harness.socketMode.toString(8)}`)
  const calls = []
  const result = await executeThroughRelay(harness, `
const read = await tools.Read({file_path: "README.md"});
const matches = await tools.Grep({pattern: read.topic, path: "src"});
return {topic: read.topic, count: matches.length, toolCount: (await tools.list()).length};`, async (tool, input) => {
    calls.push({ tool, input })
    if (tool === 'Read') {
      await new Promise(resolve => setTimeout(resolve, 1300))
      return { topic: 'tool compose' }
    }
    if (tool === 'Grep') return [{ file: 'src/main.ts', line: 'tool compose' }]
    throw new Error(`unexpected tool ${tool}`)
  }, 1000)
  assert.equal(result.ok, true, `script failed; error=${result.error}; stack=${result.stack}`)
  assert.deepEqual(calls, [
    { tool: 'Read', input: { file_path: 'README.md' } },
    { tool: 'Grep', input: { pattern: 'tool compose', path: 'src' } },
  ])
  assert.deepEqual(result.value, { topic: 'tool compose', count: 1, toolCount: 2 })
})

// Regression: a sandboxed script reaches another Unix socket or signals its parent despite the child boundary.
test('the sandbox blocks foreign Unix sockets and process signaling', async t => {
  const socketPath = await foreignSocket(t).catch(err => {
    if (err instanceof EnvironmentBlocked) { t.skip(err.message); return undefined }
    throw err
  })
  if (!socketPath) return
  const probe = sandboxProbe(socketPath)
  if (probe.status !== 0 && blockedByOuterSandbox(`${probe.stderr} ${probe.error}`)) {
    t.skip(`sandbox-exec profile probe blocked by the enclosing sandbox: status=${probe.status}; stderr=${probe.stderr}`)
    return
  }
  assert.equal(probe.status, 0, `sandbox profile probe failed; status=${probe.status}; stdout=${probe.stdout}; stderr=${probe.stderr}`)
  const measured = JSON.parse(probe.stdout)
  assert.equal(measured.connect, 'EPERM', `sandbox allowed or failed to deny Unix connect: ${JSON.stringify(measured)}`)
  assert.equal(measured.signal, 'EPERM', `sandbox allowed or failed to deny process.kill(ppid, 0): ${JSON.stringify(measured)}`)

  const harness = await daemonFor(t)
  if (!harness) return
  const result = await executeThroughRelay(harness, `
const net = await import("node:net");
const socket = net.createConnection({path:${JSON.stringify(socketPath)}});
const connect = await new Promise(resolve => { socket.once("connect", () => { socket.destroy(); resolve("connected"); }); socket.once("error", error => resolve(error.code || error.name)); });
let kill; try { process.kill(process.ppid, 0); kill = "allowed"; } catch (error) { kill = error.message; }
return {connect, kill};`, async () => { throw new Error('security probe must not call tools') })
  assert.equal(result.ok, true, `security probe script failed; error=${result.error}; stack=${result.stack}`)
  assert.equal(result.value.connect, 'EPERM', `script connected to a foreign Unix socket: ${JSON.stringify(result.value)}`)
  assert.match(result.value.kill, /process\.kill is disabled/)
})

// Regression: a run's bearer token can forge another run's tool result and change its returned value.
test('a per-run control token cannot forge another run result', async t => {
  const harness = await daemonFor(t)
  if (!harness) return
  const runA = await startRun(harness, 'return await tools.Read({file_path:"a"});')
  const runB = await startRun(harness, 'return await tools.Read({file_path:"b"});')
  assert.equal(runA.response.status, 202, `run A status=${runA.response.status}; body=${JSON.stringify(runA.response.body)}`)
  assert.equal(runB.response.status, 202, `run B status=${runB.response.status}; body=${JSON.stringify(runB.response.body)}`)
  const callA = await request(harness.socketPath, `/next?runId=${runA.runId}`, 'GET', undefined, runA.controlToken)
  const callB = await request(harness.socketPath, `/next?runId=${runB.runId}`, 'GET', undefined, runB.controlToken)
  assert.equal(callA.body.kind, 'call', `run A response=${JSON.stringify(callA.body)}`)
  assert.equal(callB.body.kind, 'call', `run B response=${JSON.stringify(callB.body)}`)
  const forged = await request(harness.socketPath, '/result', 'POST', {
    runId: runB.runId, callId: callB.body.callId, reply: { ok: true, value: 'FORGED BY A' },
  }, runA.controlToken)
  assert.equal(forged.status, 401, `foreign result status=${forged.status}; body=${JSON.stringify(forged.body)}`)
  const bResult = await request(harness.socketPath, '/result', 'POST', {
    runId: runB.runId, callId: callB.body.callId, reply: { ok: true, value: 'B SAFE' },
  }, runB.controlToken)
  assert.equal(bResult.status, 200, `run B result status=${bResult.status}; body=${JSON.stringify(bResult.body)}`)
  const bDone = await request(harness.socketPath, `/next?runId=${runB.runId}`, 'GET', undefined, runB.controlToken)
  assert.deepEqual(bDone.body, { kind: 'done', ok: true, value: 'B SAFE' })
  await request(harness.socketPath, '/close', 'POST', { runId: runB.runId }, runB.controlToken)
  const aResult = await request(harness.socketPath, '/result', 'POST', {
    runId: runA.runId, callId: callA.body.callId, reply: { ok: true, value: 'A SAFE' },
  }, runA.controlToken)
  assert.equal(aResult.status, 200, `run A result status=${aResult.status}; body=${JSON.stringify(aResult.body)}`)
  const aDone = await request(harness.socketPath, `/next?runId=${runA.runId}`, 'GET', undefined, runA.controlToken)
  assert.deepEqual(aDone.body, { kind: 'done', ok: true, value: 'A SAFE' })
  await request(harness.socketPath, '/close', 'POST', { runId: runA.runId }, runA.controlToken)
})

// Regression: cancellation returns while the permission-limited child remains alive.
test('cancelling an exec terminates its child process', async t => {
  const harness = await daemonFor(t)
  if (!harness) return
  const runId = `abort-${crypto.randomUUID().replaceAll('-', '')}`
  const controlToken = token()
  const started = await request(harness.socketPath, '/run', 'POST', {
    runId, controlToken,
    script: 'await new Promise(resolve => setInterval(resolve, 60_000)); return "late";', tools: [], timeoutMs: 20_000,
  }, controlToken)
  assert.equal(started.status, 202, `run start status=${started.status}; body=${JSON.stringify(started.body)}`)
  const pid = started.body.pid
  assert.ok(Number.isInteger(pid), `script child pid missing: ${JSON.stringify(started.body)}`)
  const cancelled = await request(harness.socketPath, '/cancel', 'POST', { runId, controlToken }, controlToken)
  assert.equal(cancelled.status, 200, `cancel status=${cancelled.status}; body=${JSON.stringify(cancelled.body)}`)
  let status
  for (let i = 0; i < 100; i++) {
    status = (await request(harness.socketPath, `/status?runId=${encodeURIComponent(runId)}`, 'GET', undefined, controlToken)).body
    if (status.state === 'cancelled') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(status.state, 'cancelled', `child did not settle after cancellation; status=${JSON.stringify(status)}; stderr=${harness.stderr}`)
  assert.ok(status.childExit?.signal || status.childExit?.code !== null, `child exit was not recorded: ${JSON.stringify(status)}`)
  assert.throws(() => process.kill(pid, 0), err => err.code === 'ESRCH', `child ${pid} still runs after cancellation`)
  await request(harness.socketPath, '/close', 'POST', { runId }, controlToken)
})

// Regression: Node's fs read permission admits a file outside the canonical run-directory grant.
test('the script cannot read a file outside its permission grant', async t => {
  const harness = await daemonFor(t)
  if (!harness) return
  const result = await executeThroughRelay(harness, `
const fs = await import("node:fs/promises");
try { return {read: true, text: await fs.readFile(${JSON.stringify(daemon)}, "utf8")}; }
catch (error) { return {read: false, code: error.code}; }`, async () => { throw new Error('script must not call tools') })
  assert.equal(result.ok, true, `permission probe script failed; error=${result.error}; stack=${result.stack}`)
  assert.deepEqual(result.value, { read: false, code: 'ERR_ACCESS_DENIED' })
})

// Regression: recursive exec calls consume the daemon relay instead of failing inside the child.
test('recursive exec calls are refused by the child proxy', async t => {
  const harness = await daemonFor(t)
  if (!harness) return
  const result = await executeThroughRelay(harness, `
try { await tools["mcp__tool-compose__exec"]({script:"return 1"}); return {refused:false}; }
catch (error) { return {refused:true, message:error.message}; }`, async () => { throw new Error('recursive exec must not reach the relay') })
  assert.equal(result.ok, true, `recursive probe script failed; error=${result.error}; stack=${result.stack}`)
  assert.deepEqual(result.value, { refused: true, message: 'recursive calls to tool-compose exec are refused' })
})
