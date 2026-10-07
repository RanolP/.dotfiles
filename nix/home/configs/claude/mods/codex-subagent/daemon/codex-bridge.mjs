#!/usr/bin/env node
// One codex app-server per Claude session, reachable over HTTP on a unix socket.
// A hooks module has no Node and no raw sockets: `$.http.fetch` with
// `socketPath` is its only duplex channel, and codex app-server speaks
// newline-delimited JSON-RPC, so this bridge translates one into the other.
// The mod normally holds this process as a `$.process.spawn` child; the
// parent-pid and socket watches cover module reloads and hard parent death.
//
// Codex runs in its own CODEX_HOME holding only auth.json and a config that
// turns off codex's MCP servers, plugins, apps, skills, memories, hooks and web
// search: the Claude-side tools reach codex as dynamic tools that this bridge
// relays, so codex sees the Claude session's environment rather than ~/.codex.
//
// One POST /step per Claude turn step. It either starts a codex turn (prompt)
// or answers the dynamic tool call codex is blocked on (toolResult) and
// returns at once; POST /wait then long-polls until codex either calls the
// next dynamic tool or ends the turn. The mod's fetch gives up at 30 s, so no
// request may outlast that: /wait answers {pending:true} after WAIT_MS and the
// event stays queued for the next /wait.
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const sock = process.argv[2]
// The mod's hash of this file at spawn; /health reports it so a reloaded mod can spot a bridge running older code.
const fingerprint = process.argv[3] ?? null
if (!sock) { console.error('usage: codex-bridge.mjs <socket-path> [fingerprint]'); process.exit(2) }
const runDir = path.dirname(sock)
const sessionId = path.basename(sock).replace(/^codex-subagent-/, '').replace(/\.sock$/, '')
const stateFile = path.join(runDir, `codex-subagent-${sessionId}.state.json`)
const schemaCache = path.join(runDir, 'codex-subagent-schemas.json')
const legacySchemaCache = path.join(runDir, `codex-subagent-schemas-${sessionId}.json`)
const parent = process.ppid
let sockIno

fs.mkdirSync(runDir, { recursive: true })

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (err) { return err?.code === 'EPERM' }
}

function unlinkIfPresent(file) {
  try { fs.unlinkSync(file) } catch (err) { if (err?.code !== 'ENOENT') throw err }
}

function pruneStaleRunFiles() {
  for (const name of fs.readdirSync(runDir)) {
    if (name.startsWith('codex-subagent-schemas-') && name.endsWith('.json')) {
      try { unlinkIfPresent(path.join(runDir, name)) } catch (err) { console.error('[bridge] stale schema cache cleanup failed', name, String(err?.message ?? err)) }
      continue
    }
    if (!name.startsWith('codex-subagent-') || !name.endsWith('.state.json')) continue
    const file = path.join(runDir, name)
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (!pidAlive(state.ownerPid) && typeof state.socket === 'string') unlinkIfPresent(state.socket)
    } catch (err) {
      if (err?.code !== 'ENOENT') console.error('[bridge] stale state cleanup failed', file, String(err?.message ?? err))
    }
  }
}
pruneStaleRunFiles()
try { fs.unlinkSync(sock) } catch {}

// Outside /tmp: codex refuses to install its helper binaries under a temp dir.
const codexHome = path.join(os.homedir(), '.claude-work', 'run', 'codex-subagent-home')
const userCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
fs.mkdirSync(codexHome, { recursive: true })
const authLink = path.join(codexHome, 'auth.json')
const authTarget = path.join(userCodexHome, 'auth.json')
const authTemp = `${authLink}.${process.pid}.tmp`
try { unlinkIfPresent(authTemp) } catch {}
try {
  fs.symlinkSync(authTarget, authTemp)
  fs.renameSync(authTemp, authLink)
} catch (err) {
  try { unlinkIfPresent(authTemp) } catch {}
  let pointsRight = false
  try { pointsRight = path.resolve(path.dirname(authLink), fs.readlinkSync(authLink)) === path.resolve(authTarget) } catch {}
  if (err?.code !== 'EEXIST' || !pointsRight) throw err
}
// The user's model choice carries over; nothing else from ~/.codex/config.toml does.
let userConfig = ''
try { userConfig = fs.readFileSync(path.join(userCodexHome, 'config.toml'), 'utf8') } catch {}
const topLevel = userConfig.split(/^\[/m)[0]
const inherited = topLevel.split('\n').filter(l => /^\s*(model|model_reasoning_effort)\s*=/.test(l))
const config = [
  ...inherited,
  'web_search = "disabled"',
  '[tools]', 'web_search = false',
  '[features]',
  ...['apps', 'plugins', 'memories', 'hooks', 'multi_agent', 'multi_agent_v2', 'image_generation', 'browser_use',
    'browser_use_external', 'computer_use', 'in_app_browser', 'tool_suggest', 'skill_search', 'goals', 'shell_snapshot',
  ].map(f => `${f} = false`),
  '',
].join('\n')
const configPath = path.join(codexHome, 'config.toml')
const configTemp = `${configPath}.${process.pid}.tmp`
fs.writeFileSync(configTemp, config, { mode: 0o600 })
fs.renameSync(configTemp, configPath)

const codex = spawn('codex', ['app-server', '--listen', 'stdio://'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CODEX_HOME: codexHome },
})
codex.stderr.on('data', d => process.stderr.write(`[codex] ${d}`))
let nextId = 1
const pending = new Map() // rpc id -> {resolve, reject, method}
const sessions = new Map() // caller key -> session
const byThread = new Map() // codex threadId -> session
const boxes = new Map() // caller key -> {queue, waiter}: events outlive the session's open and any absent waiter
const inFlight = new Set() // caller keys whose /step run() has not settled
const pendingInterrupts = new Set()
let persisted = { ownerPid: process.pid, socket: sock, agents: {} }
try {
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  if (state && typeof state.agents === 'object') persisted.agents = state.agents
} catch (err) { if (err?.code !== 'ENOENT') console.error('[bridge] state read failed', stateFile, String(err?.message ?? err)) }

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(temp, file)
}

function saveState() {
  if (sockIno !== undefined) {
    try { if (fs.statSync(sock).ino !== sockIno) return } catch { return }
  }
  persisted.ownerPid = process.pid
  persisted.socket = sock
  writeJsonAtomic(stateFile, persisted)
}

saveState()
const box = key => { let b = boxes.get(key); if (!b) boxes.set(key, b = { queue: [], waiter: null }); return b }
const WAIT_MS = 25000

const send = m => codex.stdin.write(JSON.stringify(m) + '\n')
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++
  pending.set(id, { resolve, reject, method })
  send({ id, method, params })
})

function rejectPending(err) {
  for (const [id, p] of pending) { pending.delete(id); p.reject(err) }
}

let buf = ''
codex.stdout.on('data', d => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m
    try { m = JSON.parse(line) } catch { console.error('[bridge] unparsable line from codex:', line.slice(0, 300)); continue }
    onMessage(m)
  }
})

function emit(key, ev) {
  const b = box(key)
  if (b.waiter) { const w = b.waiter; b.waiter = null; w(ev) } else b.queue.push(ev)
}

// Sub-agent guard. codex 0.155.1 serves spawn_agent even with multi_agent and
// multi_agent_v2 off, `[agents] max_depth = 0` and `max_threads = 1` both
// still spawn, and no server request precedes a spawn, so nothing can refuse
// one up front. The bridge interrupts each sub-thread the moment it shows up
// (archiving it if the interrupt fails) and steers the parent turn.
const BLOCK_TEXT = '[codex-subagent] sub-agent spawning is blocked; do the work in this thread'
const SPAWNING_TOOLS = new Set(['spawnAgent', 'sendInput', 'resumeAgent', 'sendMessage', 'followupTask'])
const blocked = new Map() // sub-thread id -> parent session
const foreignTurns = new Map() // thread id this bridge did not start -> its running turn id

function interruptSub(threadId, turnId) {
  rpc('turn/interrupt', { threadId, turnId })
    .then(() => console.error('[bridge] sub-agent turn interrupted', JSON.stringify({ subThread: threadId, turnId })))
    .catch(err => {
      console.error('[bridge] sub-agent interrupt failed; archiving', JSON.stringify({ subThread: threadId, turnId, error: String(err?.message ?? err) }))
      return rpc('thread/archive', { threadId }).catch(e => console.error('[bridge] sub-agent archive failed', threadId, String(e?.message ?? e)))
    })
}

function blockSub(s, subThreadId, itemType) {
  if (!subThreadId || byThread.has(subThreadId) || blocked.has(subThreadId)) return
  blocked.set(subThreadId, s)
  console.error('[bridge] sub-agent blocked', JSON.stringify({ parentThread: s.threadId, subThread: subThreadId, item: itemType }))
  if (!s.errors.includes(BLOCK_TEXT)) s.errors.push(BLOCK_TEXT)
  const turnId = foreignTurns.get(subThreadId)
  if (turnId) interruptSub(subThreadId, turnId)
  if (s.active && s.turnId)
    rpc('turn/steer', { threadId: s.threadId, expectedTurnId: s.turnId, input: [{ type: 'text', text: BLOCK_TEXT, text_elements: [] }] })
      .catch(err => console.error('[bridge] steer after block failed', s.threadId, String(err?.message ?? err)))
}

function guardSubAgents(m, p) {
  if (m.method === 'turn/started' && !byThread.has(p.threadId)) {
    foreignTurns.set(p.threadId, p.turn?.id)
    if (blocked.has(p.threadId)) interruptSub(p.threadId, p.turn?.id)
  } else if (m.method === 'turn/completed' && !byThread.has(p.threadId)) {
    foreignTurns.delete(p.threadId)
    if (blocked.has(p.threadId)) console.error('[bridge] blocked sub-agent turn ended', JSON.stringify({ subThread: p.threadId, status: p.turn?.status }))
  } else if (m.method === 'thread/started') {
    const parent = byThread.get(p.thread?.parentThreadId ?? p.thread?.source?.subAgent?.thread_spawn?.parent_thread_id)
    if (parent) blockSub(parent, p.thread.id, 'thread/started')
  } else if (m.method === 'item/started' || m.method === 'item/completed') {
    const parent = byThread.get(p.threadId)
    const it = p.item
    if (!parent || !it) return
    if (it.type === 'subAgentActivity' && (it.kind === 'started' || it.kind === 'interacted')) blockSub(parent, it.agentThreadId, `subAgentActivity:${it.kind}`)
    else if (it.type === 'collabAgentToolCall' && SPAWNING_TOOLS.has(it.tool)) for (const t of it.receiverThreadIds ?? []) blockSub(parent, t, `collabAgentToolCall:${it.tool}`)
  }
}

async function interruptTurn(s) {
  if (!s.turnId) return false
  s.nextPrompt = undefined // an interrupted worker must not resume itself with a queued message
  // A held tool call keeps the turn blocked; fail it so the interrupt lands.
  for (const rpcId of s.held.values()) send({ id: rpcId, result: { contentItems: [{ type: 'inputText', text: 'interrupted by the user' }], success: false } })
  s.held.clear()
  await rpc('turn/interrupt', { threadId: s.threadId, turnId: s.turnId })
  return true
}

async function waitInactive(s) {
  const deadline = Date.now() + 5000
  while (s.active && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  if (s.active) throw new Error(`thread ${s.threadId} remained active 5000ms after interrupt; turnId=${s.turnId ?? 'unknown'}`)
}

function onMessage(m) {
  if (m.id !== undefined && m.method === undefined) {
    const p = pending.get(m.id); pending.delete(m.id)
    if (!p) return
    m.error ? p.reject(new Error(`${p.method}: ${JSON.stringify(m.error)}`)) : p.resolve(m.result)
    return
  }
  const p = m.params ?? {}
  if (m.id !== undefined && m.method) {
    const s = byThread.get(p.threadId)
    if (m.method === 'item/tool/call' && s) {
      console.error('[bridge] dynamic tool call', JSON.stringify({ thread: p.threadId, callId: p.callId, tool: p.tool }))
      s.held.set(p.callId, m.id)
      emit(s.key, { toolCall: { callId: p.callId, tool: p.tool, arguments: p.arguments ?? {} } })
      return
    }
    // approvalPolicy "never" means codex should ask nothing else; log what it did ask.
    console.error('[bridge] refusing server request', m.method, JSON.stringify(p).slice(0, 300))
    send({ id: m.id, error: { code: -32601, message: `codex-subagent does not serve ${m.method}` } })
    return
  }
  guardSubAgents(m, p)
  if (m.method === 'item/started' && p.item?.type && p.item.type !== 'agentMessage' && p.item.type !== 'reasoning')
    console.error('[bridge] item', p.item.type, JSON.stringify(p.item).slice(0, 200))
  const s = byThread.get(p.threadId)
  if (!s) return
  if (m.method === 'turn/started') {
    s.turnId = p.turn?.id ?? s.turnId
    if (s.interruptRequested) {
      s.interrupting = true
      s.interruptRequested = false
      interruptTurn(s).catch(err => {
        s.errors.push(`interrupt failed: ${String(err?.message ?? err)}`)
        console.error('[bridge] deferred interrupt failed', s.threadId, String(err?.message ?? err))
      })
    }
  }
  else if (m.method === 'item/completed' && p.item?.type === 'agentMessage') s.messages.push(p.item.text)
  else if (m.method === 'error') s.errors.push(JSON.stringify(p))
  else if (m.method === 'turn/completed') {
    if (s.nextPrompt !== undefined) {
      // A message the running turn could not take opens the next turn instead of ending this step.
      const prompt = s.nextPrompt
      s.nextPrompt = undefined
      s.turnId = null; s.interrupting = false; s.held.clear(); s.messages = []
      startTurn(s, prompt).catch(err => emit(s.key, { error: `turn/start for the queued message failed: ${String(err?.message ?? err)}` }))
      return
    }
    const text = s.messages.length ? s.messages[s.messages.length - 1] : ''
    const ev = { final: { text, status: p.turn?.status, errors: s.errors } }
    s.active = false; s.turnId = null; s.interrupting = false; s.held.clear(); s.messages = []; s.errors = []; s.nextPrompt = undefined
    saveState()
    emit(s.key, ev)
  }
}

let codexVersion = 'unknown'
let initTimer
const ready = Promise.race([
  rpc('initialize', {
    clientInfo: { name: 'codex-subagent', title: 'Claude Code codex-subagent', version: '0.2.0' },
    capabilities: { experimentalApi: true },
  }).then(r => { if (initTimer) clearTimeout(initTimer); codexVersion = String(r?.userAgent ?? 'unknown'); send({ method: 'initialized' }); return r }),
  new Promise((_, reject) => {
    initTimer = setTimeout(() => reject(new Error('codex initialize timed out after 15000ms')), 15000)
    initTimer.unref()
  }),
]).catch(err => {
  console.error('[bridge] codex initialize failed', String(err?.message ?? err))
  shutdown(`codex initialize failed: ${String(err?.message ?? err)}`)
  throw err
})

// MCP input schemas. Nothing the mod can reach carries them, but Claude Code
// sends every connected MCP tool's full input_schema in its first /v1/messages
// body when tool search is off, which a non-first-party ANTHROPIC_BASE_URL
// guarantees. So a throwaway `claude -p` child points at a loopback recorder
// that keeps tools[] from that body and answers 400: no API call is made.
// Request headers carry the user's credentials; the recorder deletes them on
// arrival and never logs, stores or forwards any header.
let harvested = null // Promise<{ tools: Map<claudeName, inputSchema>, missingServers: string[] }>
let missedAfterHarvest = new Set()

function readSchemaCache() {
  try {
    const all = JSON.parse(fs.readFileSync(schemaCache, 'utf8'))
    const c = all.versions?.[codexVersion]
    if (!c) return null
    return { tools: new Map(Object.entries(c.tools)), missingServers: c.missingServers ?? [] }
  } catch { return null }
}

// The parent session's --mcp-config / --strict-mcp-config, so the child sees
// the same process-scoped MCP servers. Every other MCP scope comes from the
// settings files and claude.ai, which the child reads on its own.
// The <server> segment of mcp__<server>__<tool>, as Claude Code derives it from a server name.
const mcpPrefix = server => server.replace(/[^A-Za-z0-9_-]/g, '_')

export function parseProcessArgs(line) {
  const argv = []
  let word = '', quote = '', escaped = false
  for (const c of line.trim()) {
    if (escaped) { word += c; escaped = false; continue }
    if (c === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) { if (c === quote) quote = ''; else word += c; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (/\s/.test(c)) { if (word) { argv.push(word); word = '' }; continue }
    word += c
  }
  if (escaped) word += '\\'
  if (word) argv.push(word)
  return argv
}

function parentMcpArgs() {
  let argv
  try { argv = fs.readFileSync(`/proc/${process.ppid}/cmdline`, 'utf8').split('\0').filter(Boolean) } catch {
    // macOS exposes only the command line through ps; honor its quoted/escaped
    // arguments, while accepting that an unquoted space is not recoverable.
    const ps = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(process.ppid)], { encoding: 'utf8' })
    argv = parseProcessArgs(ps.stdout ?? '')
  }
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--strict-mcp-config' || a.startsWith('--mcp-config=')) out.push(a)
    else if (a === '--mcp-config') { out.push(a); while (argv[i + 1] && !argv[i + 1].startsWith('-')) out.push(argv[++i]) }
  }
  return out
}

async function runHarvest(cwd, names) {
  const t0 = Date.now()
  const diag = { recorder: { requests: 0, captured: false }, servers: {}, child: {} }
  let onCapture
  const capturedP = new Promise(r => { onCapture = r })
  const recorder = http.createServer((req, res) => {
    delete req.headers.authorization; delete req.headers['x-api-key']; req.rawHeaders.length = 0
    let body = ''
    req.setEncoding('utf8')
    req.on('data', d => { body += d })
    req.on('end', () => {
      diag.recorder.requests++
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'codex-subagent schema harvest: request recorded, not sent' } }))
      if (req.method !== 'POST' || !/^\/v1\/messages(\?|$)/.test(req.url)) return
      let j
      try { j = JSON.parse(body) } catch { return }
      if (!Array.isArray(j.tools)) return
      diag.recorder.captured = true
      onCapture(j.tools.filter(t => typeof t?.name === 'string' && t.name.startsWith('mcp__') && t.input_schema))
    })
  })
  await new Promise((r, e) => recorder.listen(0, '127.0.0.1', r).on('error', e))
  const port = recorder.address().port

  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_PLUGIN_DIRS: '', CODEX_SUBAGENT_HARVEST: '1' }
  // Detach the child from this session: no shared session id (which would load
  // this session's dev mods), no messaging socket, tool search left default-off.
  for (const k of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'CLAUDECODE',
    'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'ENABLE_TOOL_SEARCH']) delete env[k]
  const bin = process.env.CLAUDE_CODE_EXECPATH || 'claude'
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', ...parentMcpArgs()]
  diag.child.argv = [bin, ...args]
  const child = spawn(bin, args, { cwd: cwd || process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] })
  diag.child.pid = child.pid
  let stderrTail = ''
  child.stderr.on('data', d => { stderrTail = (stderrTail + d).slice(-2000) })
  const exited = new Promise(r => child.on('exit', (code, sig) => { diag.child.exit = { code, sig }; r() }))
  child.on('error', err => { diag.child.spawnError = String(err) })
  const waiting = new Map()
  let cbuf = ''
  child.stdout.on('data', d => {
    cbuf += d
    let i
    while ((i = cbuf.indexOf('\n')) >= 0) {
      const line = cbuf.slice(0, i); cbuf = cbuf.slice(i + 1)
      let m
      try { m = JSON.parse(line) } catch { continue }
      const w = m.type === 'control_response' && waiting.get(m.response?.request_id)
      if (w) { waiting.delete(m.response.request_id); w(m.response) }
    }
  })
  child.stdin.on('error', () => {})
  const write = m => child.stdin.write(JSON.stringify(m) + '\n')
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const until = (p, ms) => Promise.race([p, sleep(ms).then(() => undefined)])
  let reqN = 0
  const control = request => {
    const id = `h${++reqN}`
    const p = new Promise(r => waiting.set(id, r))
    write({ type: 'control_request', request_id: id, request })
    return until(p, 5000).finally(() => waiting.delete(id))
  }

  const wanted = new Set(names.map(n => n.split('__')[1]))
  let tools
  try {
    const deadline = Date.now() + 30000
    let statuses = []
    while (Date.now() < deadline && !diag.child.exit) {
      const r = await control({ subtype: 'mcp_status' })
      statuses = r?.response?.mcpServers ?? statuses
      // Servers join the list as their config loads (claude.ai connectors arrive
      // after local ones), so wait until every server the relayed tools name is
      // listed and settled, not merely until nothing listed is pending.
      const settled = new Set(statuses.filter(s => s.status !== 'pending').map(s => mcpPrefix(s.name)))
      if (statuses.length && statuses.every(s => s.status !== 'pending') && [...wanted].every(w => settled.has(w))) break
      await sleep(500)
    }
    for (const s of statuses) diag.servers[s.name] = s.status
    const listed = new Set(statuses.map(s => mcpPrefix(s.name)))
    diag.unlistedServers = [...wanted].filter(w => !listed.has(w))
    write({ type: 'user', message: { role: 'user', content: 'codex-subagent schema harvest' } })
    tools = await until(Promise.race([capturedP, exited.then(() => undefined)]), 30000)
  } finally {
    child.kill('SIGTERM')
    setTimeout(() => { if (!diag.child.exit) child.kill('SIGKILL') }, 3000).unref()
    recorder.close(); recorder.closeAllConnections()
  }
  diag.ms = Date.now() - t0
  const missingServers = [...Object.entries(diag.servers).filter(([, st]) => st !== 'connected').map(([n, st]) => `${n} (${st})`),
    ...diag.unlistedServers.map(w => `${w} (never listed)`)]
  if (!tools) {
    await until(exited, 3000)
    throw new Error(`schema harvest captured nothing: ${JSON.stringify({ ...diag, stderrTail })}`)
  }
  const map = new Map(tools.map(t => [t.name, t.input_schema]))
  let all = { versions: {} }
  try {
    const previous = JSON.parse(fs.readFileSync(schemaCache, 'utf8'))
    if (previous?.versions && typeof previous.versions === 'object') all = previous
  } catch (err) { if (err?.code !== 'ENOENT') console.error('[bridge] schema cache read failed', schemaCache, String(err?.message ?? err)) }
  all.versions[codexVersion] = { harvestedAt: new Date().toISOString(), missingServers, tools: Object.fromEntries(map) }
  writeJsonAtomic(schemaCache, all)
  console.error('[bridge] schema harvest', JSON.stringify({ ms: diag.ms, tools: map.size, cache: schemaCache, recorder: diag.recorder, child: diag.child, servers: diag.servers }))
  if (missingServers.length) console.error('[bridge] schema harvest: servers not connected in the harvest child:', missingServers.join(', '))
  return { tools: map, missingServers, fresh: true }
}

// The harvested schema for each relayed MCP tool (Claude name -> schema).
// Harvests once per bridge; again only when a tool is missing that was not
// already missing right after the last harvest, so a server the child never
// reaches does not cost a harvest per thread.
async function mcpSchemas(names, cwd) {
  const failed = prev => err => { console.error('[bridge]', String(err?.message ?? err)); harvested = null; return prev }
  harvested ??= Promise.resolve(readSchemaCache()).then(c => c ?? runHarvest(cwd, names))
  let h = await harvested.catch(failed(null))
  if (h && !h.fresh && names.some(n => !h.tools.has(n) && !missedAfterHarvest.has(n))) {
    harvested = runHarvest(cwd, names)
    h = await harvested.catch(failed(h))
  }
  if (h) { h.fresh = false; missedAfterHarvest = new Set(names.filter(n => !h.tools.has(n))) }
  return h?.tools ?? new Map()
}

// dynamicTools with each MCP tool's harvested schema in place of the mod's open object.
async function withSchemas(b) {
  const tools = b.dynamicTools ?? []
  const mcp = b.mcpTools ?? {} // codex name -> Claude name
  if (!Object.keys(mcp).length) return undefined
  const schemas = await mcpSchemas(Object.values(mcp), b.cwd)
  const stubbed = []
  const out = tools.map(t => {
    const s = mcp[t.name] && schemas.get(mcp[t.name])
    if (mcp[t.name] && !s) stubbed.push(mcp[t.name])
    return s ? { ...t, inputSchema: s } : t
  })
  if (stubbed.length) console.error('[bridge] no harvested schema, relayed as an open object:', stubbed.join(', '))
  console.error('[bridge] harvested schemas applied:', out.filter(t => mcp[t.name] && schemas.has(mcp[t.name])).map(t => `${t.name}(required=${(t.inputSchema.required ?? []).join('|')})`).join(', '))
  return out
}

async function open(b) {
  let s = sessions.get(b.key)
  if (s) return s
  const common = { model: b.model ?? null, cwd: b.cwd ?? null, approvalPolicy: 'never', sandbox: b.sandbox ?? 'read-only', developerInstructions: b.developerInstructions ?? null }
  // A threadId from the mod means this bridge restarted: rejoin the thread codex persisted.
  let r
  if (b.threadId) r = await rpc('thread/resume', { threadId: b.threadId, ...common, excludeTurns: true })
  else {
    const harvestedTools = await withSchemas(b)
    try {
      r = await rpc('thread/start', { ...common, ephemeral: false, dynamicTools: harvestedTools ?? b.dynamicTools ?? [] })
    } catch (err) {
      // A harvested schema codex refuses must not cost the agent its MCP tools.
      if (!harvestedTools) throw err
      console.error('[bridge] thread/start refused the harvested schemas; retrying with open objects:', String(err?.message ?? err))
      r = await rpc('thread/start', { ...common, ephemeral: false, dynamicTools: b.dynamicTools ?? [] })
    }
  }
  const interruptRequested = pendingInterrupts.delete(b.key)
  s = { key: b.key, agentType: b.agentType, cwd: b.cwd, threadId: r.thread.id, model: r.model, resumed: !!b.threadId, turnId: null, active: false, interruptRequested, interrupting: interruptRequested, held: new Map(), messages: [], errors: [] }
  sessions.set(b.key, s); byThread.set(s.threadId, s)
  persisted.agents[b.key] = { type: s.agentType, cwd: s.cwd, threadId: s.threadId }
  saveState()
  console.error('[bridge] thread', b.threadId ? 'resumed' : 'started', s.threadId, 'tools', (b.dynamicTools ?? []).map(t => t.name).join(','))
  return s
}

const textInput = text => [{ type: 'text', text, text_elements: [] }]

async function startTurn(s, prompt) {
  s.active = true
  try {
    await rpc('turn/start', { threadId: s.threadId, effort: s.effort ?? null, input: textInput(prompt) })
  } catch (err) {
    s.active = false
    s.turnId = null
    s.interruptRequested = false
    s.interrupting = false
    throw err
  }
}

// A message delivered while a dynamic tool ran comes with that tool's result.
// It joins the running turn as steered user input; when the turn will not take
// it, it waits for turn/completed and opens the next turn, so codex reads it once.
async function deliver(s, prompt) {
  if (s.active && s.turnId) {
    try {
      await rpc('turn/steer', { threadId: s.threadId, expectedTurnId: s.turnId, input: textInput(prompt) })
      return
    } catch (err) {
      console.error('[bridge] steer failed; queuing the message for the next turn', JSON.stringify({ thread: s.threadId, turnId: s.turnId, error: String(err?.message ?? err) }))
    }
  }
  if (s.active) { s.nextPrompt = s.nextPrompt === undefined ? prompt : `${s.nextPrompt}\n\n${prompt}`; return }
  await startTurn(s, prompt)
}

// Opening a thread can take a schema harvest (up to a minute), so all of it runs
// past the reply; a failure reaches the mod through /wait as {error}.
async function run(b) {
  await ready
  const s = await open(b)
  if (b.effort !== undefined) s.effort = b.effort
  if (b.toolResult) {
    const rpcId = s.held.get(b.toolResult.callId)
    if (rpcId === undefined) throw new Error(`no held codex tool call ${b.toolResult.callId} on thread ${s.threadId} (bridge restarted mid-call?)`)
    s.held.delete(b.toolResult.callId)
    send({ id: rpcId, result: { contentItems: b.toolResult.contentItems, success: b.toolResult.success } })
    if (b.prompt !== undefined) await deliver(s, b.prompt)
  } else if (b.prompt !== undefined) {
    if (s.active && s.interrupting) await waitInactive(s)
    if (s.active) throw new Error(`thread ${s.threadId} already has a running turn; turnId=${s.turnId ?? 'unknown'}`)
    box(b.key).queue.length = 0 // the end of an interrupted turn nobody waited for
    await startTurn(s, b.prompt)
  } else throw new Error('step needs prompt or toolResult')
}

function step(b) {
  if (!b.key) throw new Error('step needs key')
  if (b.prompt !== undefined) pendingInterrupts.delete(b.key)
  inFlight.add(b.key)
  run(b).catch(err => { console.error('[bridge] step failed', b.key, err); emit(b.key, { error: String(err?.message ?? err) }) }).finally(() => inFlight.delete(b.key))
  return { pending: true }
}

function decorate(key, ev) {
  const s = sessions.get(key)
  return { ...ev, threadId: s?.threadId, model: s?.model, resumed: s?.resumed, bridgePid: process.pid, codexPid: codex.pid }
}

async function wait({ key }, res) {
  const b = box(key)
  if (b.queue.length) return decorate(key, b.queue.shift())
  if (!sessions.has(key) && !inFlight.has(key)) return { error: 'unknown key' }
  let w
  const ev = await new Promise(r => {
    w = r; b.waiter = w
    let timer
    const drop = () => { clearTimeout(timer); if (b.waiter === w) { b.waiter = null; r(null) } }
    timer = setTimeout(drop, WAIT_MS)
    res.on('close', drop)
  })
  if (!ev) return { pending: true }
  if (res.destroyed) { b.queue.unshift(ev); return { pending: true } }
  return decorate(key, ev)
}

async function interrupt({ key }) {
  const s = sessions.get(key)
  if (!s) {
    if (!inFlight.has(key)) return { interrupted: false }
    pendingInterrupts.add(key)
    return { interrupted: true, deferred: true }
  }
  if (!s.active) return { interrupted: false }
  if (!s.turnId) { s.interruptRequested = true; s.interrupting = true; return { interrupted: true, deferred: true } }
  s.interrupting = true
  await interruptTurn(s)
  return { interrupted: true }
}

function recover({ key }) {
  const s = sessions.get(key)
  const agent = s ? { type: s.agentType, cwd: s.cwd, threadId: s.threadId } : persisted.agents[key]
  return agent?.type && agent.cwd ? { found: true, ...agent } : { found: false }
}

function remember({ key, type, cwd }) {
  if (!key || !type || !cwd) throw new Error('remember needs key, type, and cwd')
  persisted.agents[key] = { type, cwd, ...(persisted.agents[key]?.threadId ? { threadId: persisted.agents[key].threadId } : {}) }
  saveState()
  return { remembered: true }
}

const server = http.createServer(async (req, res) => {
  const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  try {
    if (req.method === 'GET' && req.url === '/health') {
      const init = await ready
      const busy = [...new Set([...inFlight, ...[...sessions.values()].filter(s => s.active).map(s => s.key)])]
      return reply(200, { bridgePid: process.pid, codexPid: codex.pid, codexHome, fingerprint, busy, threads:[...sessions.values()].map(s => [s.key, s.threadId]), userAgent: init?.userAgent })
    }
    let body = ''
    for await (const d of req) body += d
    if (req.method === 'POST' && req.url === '/step') return reply(200, step(JSON.parse(body)))
    if (req.method === 'POST' && req.url === '/wait') return reply(200, await wait(JSON.parse(body), res))
    if (req.method === 'POST' && req.url === '/interrupt') return reply(200, await interrupt(JSON.parse(body)))
    if (req.method === 'POST' && req.url === '/recover') return reply(200, recover(JSON.parse(body)))
    if (req.method === 'POST' && req.url === '/remember') return reply(200, remember(JSON.parse(body)))
    reply(404, { error: `no route ${req.method} ${req.url}` })
  } catch (err) {
    console.error('[bridge] request failed', req.method, req.url, err)
    reply(500, { error: String(err?.message ?? err) })
  }
})
// /wait holds a request open for up to WAIT_MS.
server.requestTimeout = 0
server.headersTimeout = 0
// A module reload or a restart starts the new bridge before the old one exits,
// on the same path; each bridge removes only the socket inode it created, and
// one whose socket was replaced exits rather than run a second codex.
server.on('error', err => {
  console.error('[bridge] socket server error', err)
  shutdown(`socket server error: ${String(err?.message ?? err)}`)
})
server.listen(sock, () => {
  try { sockIno = fs.statSync(sock).ino; saveState() } catch (err) { shutdown(`socket setup failed: ${String(err?.message ?? err)}`); return }
  console.log(JSON.stringify({ ready: true, sock, bridgePid: process.pid, codexPid: codex.pid, codexHome }))
})

let shuttingDown = false
function shutdown(why) {
  if (shuttingDown) return
  shuttingDown = true
  console.error('[bridge] exiting:', why)
  try { if (fs.statSync(sock).ino === sockIno) fs.unlinkSync(sock) } catch {}
  try { unlinkIfPresent(legacySchemaCache) } catch (err) { console.error('[bridge] schema cache cleanup failed', String(err?.message ?? err)) }
  rejectPending(new Error(`codex app-server stopped: ${why}`))
  const finish = () => {
    try { server.close() } catch {}
    setImmediate(() => process.exit(0))
  }
  if (codex.exitCode !== null || codex.signalCode !== null) return finish()
  codex.kill('SIGTERM')
  const force = setTimeout(() => {
    if (codex.exitCode === null && codex.signalCode === null) codex.kill('SIGKILL')
    setTimeout(finish, 500).unref()
  }, 1000)
  force.unref()
  codex.once('exit', finish)
}
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => shutdown(s))
codex.on('error', err => {
  rejectPending(new Error(`codex app-server spawn failed: ${String(err?.message ?? err)}`))
  console.error('[bridge] codex app-server error', err)
})
codex.on('exit', (code, sig) => {
  rejectPending(new Error(`codex app-server exited code=${code} signal=${sig}`))
  shutdown(`codex app-server exited code=${code} signal=${sig}`)
})
setInterval(() => {
  if (process.ppid !== parent) shutdown(`parent ${parent} gone`)
  let ino
  try { ino = fs.statSync(sock).ino } catch {}
  if (sockIno !== undefined && ino !== sockIno) shutdown('socket replaced by another bridge')
}, 2000).unref()
