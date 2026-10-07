import type { ApiMessage, EngineInterface, Register, SessionMessage, Timer, TimerCall, TurnStepChunk, TurnStepResult } from 'claude-code'

// codex-subagent: pinned GPT agent types, served by codex app-server.
//
// The Agent tool spawns `codex-subagent:luna` (or `:sol`) like any agent, so
// the engine owns the agentId, the background task, the completion
// notification and SendMessage resumes. This plugin answers every `turn.step`
// of those agents without `next`, so no Claude request is ever sent.
//
// Codex keeps its own shell and apply_patch, sandboxed by the agent type. The
// Claude-side tools codex lacks (read-only MCP tools, Skill, WebFetch, WebSearch)
// are handed to codex as dynamic tools. When codex calls one, the step answers
// with that tool_use and stops with `tool_use`, so Claude Code runs the tool
// inside this agent's loop (hooks, permissions, MCP auth all apply); the next
// step reads the tool_result and hands it back to the codex call that is still
// waiting. The agent's first message (CLAUDE.md, skill listing, environment)
// becomes codex's developer instructions.
//
// A hooks module has no Node and no sockets, so the daemon is a node bridge
// (daemon/codex-bridge.mjs) speaking HTTP on a unix socket to the mod and
// JSON-RPC on stdio to `codex app-server`.

export const TYPES = {
  luna: { model: 'gpt-6-luna', effort: 'xhigh', sandbox: 'workspace-write', blurb: 'implementer for well-planned code changes' },
  sol: { model: 'gpt-5.6-sol', effort: 'medium', sandbox: 'workspace-write', blurb: 'fast implementer for mechanical or small changes' },
} as const
type TypeName = keyof typeof TYPES
const PREFIX = 'codex-subagent:'

// Claude-side tools codex has no equivalent of. Read/Edit/Write/Bash/Grep/Glob
// stay codex's own (shell + apply_patch). Agent is left out: a codex agent
// spawning agents would nest a second agent loop under a step this plugin holds.
type JsonSchema = Record<string, unknown>
const str = (description: string) => ({ type: 'string', description })
export const BUILTIN_RELAY: Record<string, JsonSchema> = {
  Skill: { type: 'object', properties: { skill: str('A skill name from the available-skills list'), args: str('Optional arguments for the skill') }, required: ['skill'] },
  WebFetch: { type: 'object', properties: { url: str('The URL to fetch'), prompt: str('What to extract from the fetched content') }, required: ['url', 'prompt'] },
  WebSearch: {
    type: 'object',
    properties: { query: str('The search query'), allowed_domains: { type: 'array', items: { type: 'string' } }, blocked_domains: { type: 'array', items: { type: 'string' } } },
    required: ['query'],
  },
}
// $.tool.list() carries no input schema, so an MCP tool leaves the mod as an
// open object; the bridge swaps in the schema it harvests (see the bridge),
// and Claude Code's own validator answers a malformed call either way.
const OPEN_OBJECT: JsonSchema = { type: 'object', additionalProperties: true }

// Codex reserves the `mcp__` prefix for its own MCP tools ("dynamic tool name
// is reserved") and the Responses API caps a function name at 64 characters
// of [A-Za-z0-9_-], so an MCP tool goes to codex as `claude_mcp__…`, hashed
// when that would run long. Built-in names pass through unchanged.
export function codexName(claudeName: string): string {
  if (!claudeName.startsWith('mcp__')) return claudeName
  const name = `claude_${claudeName}`.replace(/[^A-Za-z0-9_-]/g, '_')
  if (name.length <= 64) return name
  let h = 0x811c9dc5
  for (let i = 0; i < claudeName.length; i++) h = Math.imul(h ^ claudeName.charCodeAt(i), 0x01000193) >>> 0
  return `${name.slice(0, 55)}_${h.toString(16).padStart(8, '0')}`
}

export type DynamicTool = { type: 'function'; name: string; description: string; inputSchema: JsonSchema }
// `mcp` maps each MCP tool's codex name to its Claude name, the key the bridge's harvested schemas use.
export type Relay = { tools: DynamicTool[]; claudeName: Map<string, string>; mcp: Record<string, string> }
export function relaySet(tools: readonly { name: string; description: string; mcp: boolean }[]): Relay {
  const claudeName = new Map<string, string>()
  const mcp: Record<string, string> = {}
  const out: DynamicTool[] = []
  const readOnly = /^(?:[a-z0-9]+_)*?(get|list|read|search|fetch|query|lookup|find|preview|whoami|guide)(?:_|$|[A-Z])/i
  for (const t of tools) {
    if (!t.mcp && !(t.name in BUILTIN_RELAY)) continue
    const toolName = t.name.slice(t.name.lastIndexOf('__') + 2)
    if (t.mcp && (!t.name.startsWith('mcp__') || !readOnly.test(toolName))) continue
    const name = codexName(t.name)
    claudeName.set(name, t.name)
    if (t.mcp) mcp[name] = t.name
    const description = name === t.name ? t.description || t.name : `Claude Code tool ${t.name}. ${t.description}`.trim()
    out.push({ type: 'function', name, description, inputSchema: BUILTIN_RELAY[t.name] ?? OPEN_OBJECT })
  }
  return { tools: out, claudeName, mcp }
}

export function typeOf(subagentType: string): TypeName | undefined {
  if (!subagentType.startsWith(PREFIX)) return undefined
  const t = subagentType.slice(PREFIX.length)
  return t in TYPES ? (t as TypeName) : undefined
}

// A step naming one of these models is a codex agent's, whatever this module
// knows of its id: Anthropic answers every one of them 404 model_not_found.
export function typeForModel(model: string): TypeName | undefined {
  return (Object.keys(TYPES) as TypeName[]).find(t => TYPES[t].model === model)
}

// A Claude model as the engine names one: an id, a provider-prefixed id, or an alias.
const CLAUDE_MODEL = /claude|anthropic|^(?:opus|sonnet|haiku|fable|opusplan|best|default)(?:\[|-|$)/i

// Whether a step belongs to codex, and which type serves it. The agent's type
// decides first: a model may be a stale definition's (`gpt-5.6-luna` from
// before a reload) or an Agent-tool override (`opus`), and either must still
// stay off Claude. Any non-Claude model also counts, since Anthropic would 404 it.
export type Claim = { ours: boolean; type?: TypeName }
export function codexClaim(model: string, subagentType?: string): Claim {
  if (subagentType?.startsWith(PREFIX)) return { ours: true, type: typeOf(subagentType) ?? typeForModel(model) }
  const type = typeForModel(model)
  if (type) return { ours: true, type }
  return { ours: model !== '' && !CLAUDE_MODEL.test(model) }
}

// The thread cwd is codex's workspace-write root. $.session.cwd() follows a
// shell `cd` in the main session, so a worker spawned from a subdirectory
// could write only there; the repo root keeps the whole project writable.
// Outside a repo (or with no git) the spawn directory itself stays the root.
export async function workspaceRoot(run: EngineInterface['process']['run'], cwd: string): Promise<string> {
  try {
    const r = await run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    const top = r.stdout.trim()
    return r.exitCode === 0 && top ? top : cwd
  } catch {
    return cwd
  }
}

const stripReminders = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

// The text this step must hand codex: the newest user row that is a real
// message (the spawn prompt on the first step, a SendMessage on a resume).
// A tool-result row can also carry a new user message, so its text is real
// prompt input and must not be discarded.
export function pendingPrompt(rows: readonly SessionMessage[]): string | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (!r) continue
    if (r.role === 'assistant') return undefined
    const text = stripReminders(r.text)
    if (text) return text
  }
  return undefined
}

type ContentItem = { type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }

function toItems(content: unknown): ContentItem[] {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  const items: ContentItem[] = []
  for (const b of blocks as { type: string; text?: string; source?: { type: string; media_type?: string; data?: string; url?: string } }[]) {
    if (b.type === 'text' && b.text) {
      const text = stripReminders(b.text)
      if (text) items.push({ type: 'inputText', text })
    } else if (b.type === 'image' && b.source) {
      const url = b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.url
      if (url) items.push({ type: 'inputImage', imageUrl: url })
    }
  }
  return items
}

// The answer to a relayed call: its tool_result, plus the text blocks Claude
// Code puts after it in the same message (a Skill's body arrives that way).
// A message delivered to the agent while the call ran (`delivered`, the texts
// session.receive queued) rides in that same message but is not the tool's:
// it comes back apart as `messages`, for codex to read as user input.
export function toolResultFor(api: readonly ApiMessage[], toolUseId: string, delivered: readonly string[] = []): { contentItems: ContentItem[]; success: boolean; messages?: string[] } | undefined {
  const last = api[api.length - 1]
  if (!last || last.role !== 'user') return undefined
  const blocks = last.content as ApiBlock[]
  const i = blocks.findIndex(b => b.type === 'tool_result' && b.tool_use_id === toolUseId)
  if (i < 0) return undefined
  const r = blocks[i]
  if (!r) return undefined
  const trailing = blocks.slice(i + 1).filter(b => b.type === 'text' || b.type === 'image')
  const isDelivered = (b: ApiBlock) => b.type === 'text' && typeof b.text === 'string' && delivered.some(d => d !== '' && stripReminders(b.text!).includes(d))
  const messages = trailing.filter(isDelivered).map(b => stripReminders(b.text!))
  const contentItems = r.toolDenialKind === 'user-rejected'
    ? [{ type: 'inputText' as const, text: 'user rejected this tool call' }]
    : [...toItems(r.content), ...toItems(trailing.filter(b => !isDelivered(b)))]
  return { contentItems: contentItems.length ? contentItems : [{ type: 'inputText', text: '(empty result)' }], success: !r.is_error, ...(messages.length ? { messages } : {}) }
}

// What the agent's first message carries ahead of the task itself: hook
// context, the deferred-tool list, environment, skill listing, CLAUDE.md,
// date. The last text block is the spawn prompt, which goes in as the turn.
export function inheritedContext(api: readonly ApiMessage[]): string {
  const first = api[0]
  if (!first || first.role !== 'user') return ''
  const texts = (first.content as { type: string; text?: string }[]).filter(b => b.type === 'text' && b.text).map(b => b.text!)
  return texts.slice(0, -1).join('\n\n')
}

const PREAMBLE = `You are running as a subagent inside a Claude Code session; a Claude model delegated this task to you and reads your final message as the result.
- Do file reads, edits and commands with your own shell and apply_patch tools.
- The Claude session's other tools are relayed to you as dynamic tools: read-only mcp__<server>__<tool> as claude_mcp__<server>__<tool>, Skill (load a skill from the listing below by name, then follow what it returns), WebFetch and WebSearch. Call them through tools.<name> in exec. Claude Code runs them with its own permissions and returns the result.
- Never call spawn_agent, followup_task, send_message, wait_agent, interrupt_agent or list_agents: this task runs in one agent, you.
- Where the instructions below name Claude tools you do not have (Read, Edit, Write, Bash, Grep, Glob, Agent, Task*), use your shell or apply_patch for the same effect, or skip the step.

The Claude session's context for this agent follows.`

// In auto mode the harness delivers a subagent's report only through a
// SubagentHandback call and drops its final text, so the mod makes that call
// with codex's answer; codex itself never sees the tool. `handback` holds the
// report until the call's result shows whether it was delivered.
const HANDBACK = 'SubagentHandback'
type Agent = { type: TypeName; cwd: string; threadId?: string; waiting?: { toolUseId: string; callId: string }; relay?: Relay; handback?: { toolUseId: string; text: string } }
export type StepMeta = { threadId: string; model?: string; resumed: boolean; bridgePid: number; codexPid: number }
type StepResult = StepMeta & ({ toolCall: { callId: string; tool: string; arguments: unknown } } | { final: { text: string; status?: string; errors: string[] } })
type StepEvent = StepResult | (StepMeta & { error: string })
export type StepReply = { pending: true } | StepEvent | { error: string }

type ApiBlock = { type: string; id?: string; name?: string; text?: string; input?: { message?: unknown }; tool_use_id?: string; content?: unknown; is_error?: boolean; toolDenialKind?: string }

// $.http.fetch's text for a socket nothing listens on (missing, or left by a
// dead bridge). Its 30 s "aborted: no complete answer" is not one: that bridge
// is alive, and a second one would run the same prompt again.
export const unreachable = (err: unknown) => /\bfailed: .*(FailedToOpenSocket|ConnectionRefused|ECONNREFUSED|ENOENT)/.test(String(err))

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let interrupt = () => {}
  const aborted = new Promise<never>((_, reject) => {
    interrupt = () => reject(new Error('interrupted'))
    if (signal.aborted) interrupt()
    else signal.addEventListener('abort', interrupt, { once: true })
  })
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener('abort', interrupt))
}

export const interrupted = (err: unknown) => err instanceof Error && err.message === 'interrupted'

// The harness aborts a subagent whose stream yields nothing for 600 s, and
// codex can think longer than that without a tool call. Every chunk the turn
// streams counts as progress; an empty thinking chunk is the one the
// transcript does not keep, so the answer stays clean. Pass $.clock.after,
// not $.clock.sleep: a sleep is charged to the dispatch's own time budget.
export const KEEPALIVE_MS = 30_000

export async function* keepalive<T>(work: Promise<T>, signal: AbortSignal, onBeat: () => void, after: TimerCall, intervalMs = KEEPALIVE_MS): AsyncGenerator<TurnStepChunk, T> {
  const settled = work.then(value => ({ value }), (error: unknown) => ({ error }))
  for (;;) {
    let timer: Timer | undefined
    const beat = new Promise<'beat'>(resolve => { timer = after(intervalMs, () => resolve('beat')) })
    const r = await abortable(Promise.race([settled, beat]), signal).finally(() => timer?.cancel())
    if (r === 'beat') {
      onBeat()
      yield { kind: 'thinking', index: 0, text: '' }
      continue
    }
    if ('error' in r) throw r.error
    return r.value
  }
}

export const MAX_WAIT_RETRIES = 3

export async function settlePending(
  reply: StepReply,
  wait: () => Promise<StepReply>,
  onRetry: (err: unknown) => void,
  health: () => Promise<unknown> = async () => {},
): Promise<StepResult> {
  let current = reply
  let retries = 0
  while ('pending' in current) {
    try {
      current = await wait()
    } catch (err) {
      if (!/aborted: no complete answer/.test(String(err))) throw err
      if (retries >= MAX_WAIT_RETRIES) throw new Error(`bridge /wait gave up after ${MAX_WAIT_RETRIES} retries; last error: ${String(err)}`)
      onRetry(err)
      try {
        await health()
      } catch (healthErr) {
        throw new Error(`bridge /wait health check failed after ${retries + 1} retries: ${String(healthErr)}; last /wait error: ${String(err)}`)
      }
      retries++
    }
  }
  if ('error' in current) throw new Error(`bridge: ${current.error}`)
  return current
}

type BridgeChunk = { stream: string; text: string; exitCode?: unknown; signal?: unknown }
const BRIDGE_STARTUP_TIMEOUT_MS = 15_000
// How long an unregistered codex step waits for in-flight spawns to register it.
const SPAWN_WAIT_MS = 5_000
// A hook's own time per dispatch is 10 s (HookBudget.ms), and an await on
// anything but a `$` call or `next` spends it. Such a wait stops this far short
// of the budget, so the step ends itself before the engine deems the hook absent.
const BUDGET_RESERVE_MS = 2_000

function processStatus(err: unknown): string {
  if (!err || typeof err !== 'object') return 'exit code=unknown'
  const e = err as { exitCode?: unknown; code?: unknown; signal?: unknown }
  const code = e.exitCode ?? e.code
  return `${code === undefined ? 'exit code=unknown' : `exit code=${String(code)}`}${e.signal ? ` signal=${String(e.signal)}` : ''}`
}

// `after` is $.clock.after: the hook environment declares no setTimeout.
export function bridgeReady(events: AsyncIterable<BridgeChunk>, after: TimerCall, timeoutMs = BRIDGE_STARTUP_TIMEOUT_MS): Promise<void> {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  let stderrTail = ''
  let status = 'exit code=unknown'
  let settled = false
  let timer: Timer | undefined
  const finish = (error?: Error) => {
    if (settled) return
    settled = true
    timer?.cancel()
    if (error) reject(error)
    else resolve()
  }
  timer = after(timeoutMs, () => finish(new Error(`codex bridge startup timed out after ${timeoutMs}ms; exit code=unknown; stderr tail: ${stderrTail || '(empty)'}`)))
  void (async () => {
    try {
      for await (const { stream, text } of events) {
        if (stream === 'stderr') stderrTail = (stderrTail + text).slice(-2000)
        if (stream === 'exit') status = `${text || 'exit'}${status === 'exit code=unknown' ? '' : `; ${status}`}`
        if (stream === 'stdout' && text.includes('"ready":true')) finish()
      }
      finish(new Error(`codex bridge exited before ready; ${status}; stderr tail: ${stderrTail || '(empty)'}`))
    } catch (err) {
      finish(new Error(`codex bridge failed before ready; ${processStatus(err)}; ${String(err)}; stderr tail: ${stderrTail || '(empty)'}`))
    }
  })()
  return promise
}

// cyrb53: the fingerprint only has to tell one bridge source from another.
export function contentHash(text: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

// The bridge's source as this module sees it on disk. A bridge outlives a
// module reload, so a bridge whose /health reports another fingerprint runs
// code this module was not written against.
export const bridgeSource = ($: EngineInterface) => `${$.plugin.root}/daemon/codex-bridge.mjs`
export const UNREAD_FINGERPRINT = 'unread'
export async function bridgeFingerprint($: EngineInterface): Promise<string> {
  try {
    return contentHash(await $.fs.read(bridgeSource($)))
  } catch (err) {
    // An unreadable source must not keep the bridge from starting; it only skips the staleness check.
    $.ui.log(`[codex-subagent] cannot fingerprint ${bridgeSource($)}: ${String(err)}`, { to: 'debug' })
    return UNREAD_FINGERPRINT
  }
}

// A bridge for the session's life; resolves once it listens. A step calls this
// again when nothing listens on the socket (the bridge or codex died), or when
// the bridge runs stale code; the new bridge takes over the socket (the old one
// exits once its socket is replaced) and resumes threads from the threadId the step sends.
function startBridge($: EngineInterface, sock: string, onFail: (ready: Promise<void>) => void): Promise<void> {
  let stop: (() => void) | undefined
  async function* output() {
    const bridge = await $.process.spawn({ argv: ['node', bridgeSource($), sock, await bridgeFingerprint($)] })
    stop = () => {
      try { (bridge as unknown as { kill?: (signal?: string) => void }).kill?.('SIGTERM') } catch (err) { $.ui.log(`[codex-bridge] failed to stop after startup failure: ${String(err)}`, { to: 'debug' }) }
    }
    for await (const chunk of bridge) {
      const { stream, text } = chunk
      // $.ui.log drops any text over 4096 characters, so long bridge lines go in pieces.
      for (const line of text.trimEnd().split('\n'))
        for (let i = 0; i < line.length; i += 3900) $.ui.log(`[codex-bridge ${stream}] ${line.slice(i, i + 3900)}`, { to: 'debug' })
      yield chunk
    }
    const status = bridge as unknown as { exitCode?: unknown; code?: unknown; signal?: unknown }
    yield { stream: 'exit', text: processStatus(status), exitCode: status.exitCode ?? status.code, signal: status.signal }
    $.ui.log('[codex-bridge] exited', { to: 'debug' })
  }
  const ready = bridgeReady(output(), (ms, fn) => $.clock.after(ms, fn))
  void ready.catch(() => { stop?.(); onFail(ready) })
  return ready
}

async function socketPath($: EngineInterface): Promise<string> {
  const home = (await $.env.get('HOME')) ?? '/tmp'
  return `${home}/.claude-work/run/codex-subagent-${await $.session.id()}.sock`
}

// What one load of this module keeps: a hot reload starts it over.
type ModState = {
  hookLog?: { path: string; text: string }
  logChain: Promise<void>
  registration?: Promise<void>
  registrationLogged: boolean
  // Each agent's definition (`codex-subagent:luna`, `general-purpose`, ...), by id.
  subagentTypes: Map<string, string>
}

// The hook-side log beside the bridge's: `$.fs.write` replaces a whole file,
// so the module keeps the text and writes it back, cut to its newest half
// once it passes LOG_MAX.
const LOG_MAX = 1 << 20
function diag(st: ModState, $: EngineInterface, line: string): void {
  try { $.ui.log(`[codex-subagent] ${line}`, { to: 'debug' }) } catch {}
  st.logChain = st.logChain.then(async () => {
    if (!st.hookLog) {
      const path = (await socketPath($)).replace(/\.sock$/, '.hook.log')
      st.hookLog = { path, text: await $.fs.read(path).catch(() => '') }
    }
    st.hookLog.text += `${new Date().toISOString()} ${line}\n`
    if (st.hookLog.text.length > LOG_MAX) st.hookLog.text = st.hookLog.text.slice(-(LOG_MAX >> 1))
    await $.fs.write(st.hookLog.path, st.hookLog.text)
  }).catch(() => {})
}

// A hot reload runs register() again but not session.start, so the first
// hook of a fresh module registers the types once more; a re-registered name
// is replaced, so a TYPES model change reaches the running session.
function ensureRegistered(st: ModState, $: EngineInterface): Promise<void> {
  return st.registration ??= (async () => {
    if ((await $.env.get('CODEX_SUBAGENT_HARVEST')) === '1') return
    for (const [name, t] of Object.entries(TYPES)) {
      await $.agent.register({
        name,
        description: `Runs the task on OpenAI ${t.model} at ${t.effort} effort in the ${t.sandbox} sandbox through Codex (codex's own shell and edit tools, plus this session's read-only MCP tools and skills relayed; ${t.blurb}). SendMessage continues the same codex thread.`,
        prompt: 'This agent is served by Codex; this prompt is never sent to a Claude model.',
        model: t.model, // never called: every step of this agent is answered by codex
      })
    }
  })().catch(err => {
    st.registration = undefined
    if (!st.registrationLogged) { st.registrationLogged = true; diag(st, $, `agent type registration failed (retried on the next hook): ${String(err)}`) }
  })
}

async function subagentTypeOf(st: ModState, $: EngineInterface, agents: ReadonlyMap<string, Agent>, agentId: string | undefined): Promise<string | undefined> {
  if (!agentId) return undefined
  const known = agents.get(agentId)
  if (known) return `${PREFIX}${known.type}`
  if (!st.subagentTypes.has(agentId)) {
    try {
      for (const a of await $.agent.list()) st.subagentTypes.set(a.id, a.type)
    } catch (err) {
      diag(st, $, `agent list failed while classifying ${agentId}: ${String(err)}`)
    }
  }
  return st.subagentTypes.get(agentId)
}

export const register: Register = (on) => {
  const st: ModState = { logChain: Promise.resolve(), registrationLogged: false, subagentTypes: new Map() }
  const agents = new Map<string, Agent>()
  // Messages delivered to a codex agent and not yet handed to codex, by agent id.
  const inbox = new Map<string, string[]>()
  // Codex spawns whose next(e) has not resolved yet.
  const spawning = new Set<Promise<void>>()
  // The first block index each codex step has not yielded yet: the turn.step
  // .catch handler writes its error there, past the chunks the failed hook left.
  const freeBlock = new Map<string, number>()
  const stepKey = (e: { agentId?: string; turnId: string; index: number }) => `${e.agentId ?? ''}|${e.turnId}|${e.index}`
  // Agents a step has claimed for codex: the .catch handler reads it without awaiting.
  const claimed = new Set<string>()

  on('session.receive', async ($, e, next) => {
    const r = await next(e)
    const text = r.text?.trim()
    if (e.agentId && text && agents.has(e.agentId)) inbox.set(e.agentId, [...(inbox.get(e.agentId) ?? []), text])
    return r
  })
  let sock = ''
  let bridgeReady: Promise<void> | undefined
  const dropFailedBridge = (failed: Promise<void>) => { if (bridgeReady === failed) bridgeReady = undefined }
  // The bridgeReady whose /health matched this module's bridge source.
  let verifiedBridge: Promise<void> | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The bridge's schema-harvest child is a `claude -p` that never reaches the
    // API; were this plugin installed there, it would start a bridge of its own.
    if ((await $.env.get('CODEX_SUBAGENT_HARVEST')) === '1') return started
    sock = await socketPath($)
    await ensureRegistered(st, $)
    bridgeReady = startBridge($, sock, dropFailedBridge)
    return started
  })

  on('agent.spawn', async ($, e, next) => {
    void ensureRegistered(st, $)
    const type = typeOf(e.subagentType)
    if (!type) return next(e)
    // A background agent's loop starts before next(e) resolves, so its first
    // step may already be running: the cwd is resolved first and the agent
    // registered the moment its id exists. turn.step waits on `spawning`.
    let done!: () => void
    const spawned = new Promise<void>(resolve => { done = resolve })
    spawning.add(spawned)
    let r: Awaited<ReturnType<typeof next>>
    let cwd: string
    try {
      cwd = await workspaceRoot((argv, init) => $.process.run(argv, init), e.cwd ?? (await $.session.cwd()))
      r = await next(e)
      if (r.agentId) { agents.set(r.agentId, { type, cwd }); st.subagentTypes.set(r.agentId, e.subagentType) }
    } finally {
      spawning.delete(spawned)
      done()
    }
    if (r.agentId) {
      try {
        sock ||= await socketPath($)
        bridgeReady ??= startBridge($, sock, dropFailedBridge)
        const ready = bridgeReady
        await abortable(ready, next.signal)
        const res = await $.http.fetch('http://codex-bridge/remember', {
          method: 'POST', socketPath: sock, headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: r.agentId, type, cwd }),
        })
        if (!res.ok) throw new Error(`bridge POST /remember ${res.status}: ${res.text.slice(0, 2000)}`)
      } catch (err) {
        diag(st, $, `could not persist ${r.agentId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const agentId = e.agentId
    const key = stepKey(e)
    freeBlock.delete(key)
    for (const k of freeBlock.keys()) { if (freeBlock.size < 64) break; freeBlock.delete(k) }
    const used = (index: number) => { freeBlock.set(key, Math.max(freeBlock.get(key) ?? 0, index + 1)) }
    const finish = (text: string, index = 0) => { used(index); return endTurn(e, text, index) }
    // `work` is no `$` call, so waiting on it is charged to this hook's budget:
    // once what the budget spares has passed, `onExpiry` settles it instead.
    const withinBudget = <T>(work: Promise<T>, capMs: number, onExpiry: () => T): Promise<T> => {
      let timer: Timer | undefined
      const expired = new Promise<T>((resolve, reject) => {
        timer = $.clock.after(Math.max(0, Math.min(capMs, next.budget.remainingMs - BUDGET_RESERVE_MS)), () => {
          try { resolve(onExpiry()) } catch (err) { reject(err) }
        })
      })
      return Promise.race([work, expired]).finally(() => timer?.cancel())
    }
    const bridgeUp = (ready: Promise<void>) => withinBudget(abortable(ready, next.signal), Infinity, () => {
      throw new Error(`the codex bridge is still starting after this step's time budget (${next.budget.ms} ms)`)
    })
    const post = (route: string, payload: unknown) =>
      $.http.fetch(`http://codex-bridge${route}`, { method: 'POST', socketPath: sock, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    void ensureRegistered(st, $)
    let agent = agentId ? agents.get(agentId) : undefined
    if (!agent && agentId && spawning.size) {
      // This may be the first step of a codex spawn still inside next(e); a
      // spawn that never resolves must not hold the step, so the wait is bounded.
      await withinBudget(Promise.all(spawning).then(() => {}), SPAWN_WAIT_MS, () => {})
      agent = agents.get(agentId)
    }
    const subagentType = await subagentTypeOf(st, $, agents, agentId)
    const claim: Claim = agent ? { ours: true, type: agent.type } : codexClaim(e.model, subagentType)
    if (claim.ours && agentId) claimed.add(agentId)
    const cause = `model=${e.model} type=${subagentType ?? '(unknown)'}`
    let rebuilt = false
    if (!agent && agentId) {
      let found = false
      try {
        sock ||= await socketPath($)
        bridgeReady ??= startBridge($, sock, dropFailedBridge)
        const ready = bridgeReady
        await bridgeUp(ready)
        const res = await abortable(post('/recover', { key: agentId }), next.signal)
        if (!res.ok) throw new Error(`bridge POST /recover ${res.status}: ${res.text.slice(0, 2000)}`)
        const recovered = JSON.parse(res.text) as { found?: boolean; type?: TypeName; cwd?: string; threadId?: string }
        found = recovered.found === true
        if (found && recovered.type && recovered.cwd)
          agent = { type: recovered.type, cwd: recovered.cwd, threadId: recovered.threadId }
      } catch (err) {
        diag(st, $, `recovery lookup failed for ${agentId} (${cause}): ${String(err)}`)
        if (claim.ours) return yield* finish(`[codex-subagent error] cannot reach the bridge to recover ${agentId}: ${err instanceof Error ? err.message : String(err)}; send the message again`)
      }
      // Neither this module nor the bridge has seen the spawn: the agent's
      // type (or its model) names the codex type, and the session's repo root
      // is the cwd the spawn would pick.
      if (!agent && !found && claim.ours) {
        if (!claim.type) {
          diag(st, $, `${agentId} is a codex step no type serves (${cause})`)
          return yield* finish(`[codex-subagent error] cannot serve ${agentId} on codex: neither its agent type nor its model names a codex-subagent type (${cause}); this step was not sent to Claude`)
        }
        try {
          agent = { type: claim.type, cwd: await workspaceRoot((argv, init) => $.process.run(argv, init), await $.session.cwd()) }
          rebuilt = true
          diag(st, $, `${agentId} unknown to spawn and bridge; serving it as ${claim.type} in ${agent.cwd} (${cause})`)
        } catch (err) {
          return yield* finish(`[codex-subagent error] cannot recover ${agentId ??'(unknown agent)'}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (agent && agentId) agents.set(agentId, agent)
    }
    if (!agent || !agentId) {
      if (claim.ours) {
        diag(st, $, `ending an unservable codex step for ${agentId ?? '(no agent id)'} (${cause})`)
        return yield* finish(agentId ? `[codex-subagent error] cannot recover ${agentId} (${cause})` : `[codex-subagent error] ${e.model} step carries no agent id`)
      }
      return yield* next(e)
    }
    if (next.signal.aborted) return yield* finish('[codex-subagent error] interrupted')
    const onAbort = () => { void post('/interrupt', { key: agentId }).catch(err => diag(st, $, `interrupt failed: ${String(err)}`)) }
    next.signal.addEventListener('abort', onAbort)
    // Block 0 holds the keepalive's thinking once it beats; the answer then streams in block 1.
    let block = 0
    const ask = async (route: string, payload: unknown) => {
      const res = await abortable(post(route, payload), next.signal)
      if (!res.ok) throw new Error(`bridge POST ${route} ${res.status}: ${res.text.slice(0, 2000)}`)
      const r = JSON.parse(res.text) as StepReply
      if ('error' in r) throw new Error(`bridge: ${r.error}`)
      return r
    }

    // The bridge routes /health for GET only; every other route is a POST.
    const getHealth = () => abortable($.http.fetch('http://codex-bridge/health', { method: 'GET', socketPath: sock }), next.signal)

    const settle = (reply: StepReply): Promise<StepResult> => settlePending(
      reply,
      () => ask('/wait', { key: agentId }),
      err => diag(st, $, `/wait failed (${String(err)}); retrying`),
      async () => {
        const res = await getHealth()
        if (!res.ok) throw new Error(`bridge GET /health ${res.status}: ${res.text.slice(0, 2000)}`)
      }
    )
    // True once the listening bridge runs this module's bridge source. A stale
    // bridge is replaced only while no other agent has a turn in it and this
    // step holds none of its tool calls; otherwise the next step checks again.
    const bridgeCurrent = async (body: Record<string, unknown>): Promise<boolean> => {
      const ready = bridgeReady
      if (!ready || verifiedBridge === ready) return true
      const want = await bridgeFingerprint($)
      if (want === UNREAD_FINGERPRINT) return true
      const res = await getHealth()
      if (!res.ok) {
        diag(st, $, `bridge GET /health ${res.status}: ${res.text.slice(0, 2000)}; cannot check its code, stepping through it`)
        return true
      }
      const health = JSON.parse(res.text) as { fingerprint?: string; busy?: string[]; threads?: [string, string | null][] }
      if (health.fingerprint === want) { verifiedBridge = ready; return true }
      // A bridge from before /health reported `busy` still lists its threads;
      // any of those agents the engine shows running may be mid-turn in it.
      const known = new Set((health.threads ?? []).map(([key]) => key))
      const others = Array.isArray(health.busy)
        ? health.busy.filter(key => key !== agentId)
        : (await $.agent.list()).filter(a => a.id !== agentId && a.status === 'running' && known.has(a.id)).map(a => a.id)
      const holdsCall = body.toolResult !== undefined
      if (others.length || holdsCall) {
        diag(st, $, `bridge runs stale code (fingerprint ${health.fingerprint ?? '(none)'}, want ${want}); restart deferred: ${holdsCall ? `${agentId} answers a held tool call` : `turns running for ${others.join(', ')}`}`)
        return false
      }
      diag(st, $, `bridge runs stale code (fingerprint ${health.fingerprint ?? '(none)'}, want ${want}); replacing it`)
      const fresh = bridgeReady = startBridge($, sock, dropFailedBridge)
      await bridgeUp(fresh)
      verifiedBridge = fresh
      return true
    }
    const step = async (body: Record<string, unknown>): Promise<StepResult> => {
      let submitted = false
      const roundTrip = async () => {
        const ready = bridgeReady ?? (bridgeReady = startBridge($, sock, dropFailedBridge))
        await bridgeUp(ready)
        if (!(await bridgeCurrent(body)) && body.toolResult && body.prompt !== undefined) {
          // A stale bridge may ignore `prompt` beside `toolResult`; the message
          // rides in the tool's output instead, the one place it reaches codex.
          const result = body.toolResult as { contentItems: ContentItem[] }
          body.toolResult = { ...result, contentItems: [...result.contentItems, { type: 'inputText', text: body.prompt as string }] }
          delete body.prompt
        }
        const reply = await ask('/step', body)
        submitted = true
        return settle(reply)
      }
      try {
        return await roundTrip()
      } catch (err) {
        if (!unreachable(err) || submitted) throw err
        diag(st, $, `bridge unreachable (${String(err)}); restarting it`)
        const fresh = bridgeReady = startBridge($, sock, dropFailedBridge)
        await bridgeUp(fresh)
        return roundTrip()
      }
    }

    // A failure from here on reaches the .catch handler below, which ends the
    // turn as text: a failed hook would otherwise fall through to a Claude request.
    try {
      const api = await $.session.messages({ agentId, as: 'api' })
      if (!Array.isArray(api)) throw new Error(`cannot read agent ${agentId}'s messages: ${api.deny}`)
      const rows = await $.session.messages({ agentId })
      const prompt = Array.isArray(rows) ? pendingPrompt(rows) : undefined
      if (!agent.handback) {
        const last = api[api.length - 1]
        const handback = last?.role === 'assistant' ? (last.content as ApiBlock[]).find(b => b.type === 'tool_use' && b.name === HANDBACK && b.id && typeof b.input?.message === 'string') : undefined
        if (handback?.id) agent.handback = { toolUseId: handback.id, text: handback.input!.message as string }
      }
      // A delivered SubagentHandback ends the run with no step after it, so the
      // handback outlives it here; a user message after it is a SendMessage
      // resume, which must start a codex turn rather than replay the old ending.
      if (agent.handback && prompt !== undefined) agent.handback = undefined
      if (agent.handback) {
        // A refused or failed handback ends as plain text, which the harness then delivers.
        const { toolUseId, text } = agent.handback
        agent.handback = undefined
        return yield* finish(toolResultFor(api, toolUseId)?.success ? `(report delivered through ${HANDBACK})` : text)
      }
      agent.relay ??= relaySet(await $.tool.list())
      if (!agent.waiting) {
        const last = api[api.length - 1]
        const call = last?.role === 'assistant' ? (last.content as ApiBlock[]).find(b => b.type === 'tool_use' && b.id?.startsWith('toolu_codex_') && !b.id.startsWith('toolu_codex_handback_')) : undefined
        if (call?.id) agent.waiting = { toolUseId: call.id, callId: call.id.slice('toolu_codex_'.length) }
      }
      const type = TYPES[agent.type]
      const body: Record<string, unknown> = { key: agentId, agentType: agent.type, threadId: agent.threadId, cwd: agent.cwd, model: type.model, effort: type.effort, sandbox: type.sandbox, mcpTools: agent.relay.mcp }
      const delivered = inbox.get(agentId) ?? []
      const answered = agent.waiting && toolResultFor(api, agent.waiting.toolUseId, delivered)
      if (agent.waiting && answered) {
        const { messages, ...result } = answered
        body.toolResult = { callId: agent.waiting.callId, ...result }
        // The bridge answers the call first, then steers this text into the running turn.
        if (messages) {
          body.prompt = messages.join('\n\n')
          const left = delivered.filter(d => !messages.some(m => m.includes(d)))
          if (left.length) inbox.set(agentId, left)
          else inbox.delete(agentId)
        }
      } else {
        inbox.delete(agentId)
        if (!prompt) throw new Error(`agent ${agentId} has neither a pending prompt nor the tool_result for ${agent.waiting?.toolUseId ?? '(none)'}`)
        if (!agent.threadId) {
          body.dynamicTools = agent.relay.tools
          body.developerInstructions = `${PREAMBLE}\n\n${inheritedContext(api)}`
        }
        body.prompt = prompt
      }
      agent.waiting = undefined
      sock ||= await socketPath($)
      bridgeReady ??= startBridge($, sock, dropFailedBridge)
      let reply = yield* keepalive(step(body), next.signal, () => { block = 1; used(0) }, (ms, fn) => $.clock.after(ms, fn))
      agent.threadId = reply.threadId

      for (;;) {
        if (!('toolCall' in reply)) break
        const { callId, tool, arguments: input } = reply.toolCall
        const name = agent.relay?.claudeName.get(tool)
        if (!name) {
          const failed: Record<string, unknown> = { key: agentId, agentType: agent.type, threadId: agent.threadId, cwd: agent.cwd, model: type.model, effort: type.effort, sandbox: type.sandbox, toolResult: { callId, contentItems: [{ type: 'inputText', text: `tool not relayed: ${tool}` }], success: false } }
          reply = yield* keepalive(step(failed), next.signal, () => { block = 1; used(0) }, (ms, fn) => $.clock.after(ms, fn))
          agent.threadId = reply.threadId
          continue
        }
        const toolUseId = `toolu_codex_${callId.replace(/[^A-Za-z0-9_-]/g, '_')}`
        agent.waiting = { toolUseId, callId }
        used(block)
        const chunks: TurnStepChunk[] = [
          { kind: 'tool', index: block, id: toolUseId, name },
          { kind: 'input', index: block, json: JSON.stringify(input ?? {}) },
          { kind: 'stop', stopReason: 'tool_use', usage: null },
        ]
        for (const c of chunks) yield c
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name, input }], stopReason: 'tool_use', usage: null } satisfies TurnStepResult
      }

      const f = 'final' in reply ? reply.final : { text: '', status: undefined, errors: ['bridge reply had neither toolCall nor final'] }
      const errors = f.errors.length ? `\n\n[codex errors] ${f.errors.join('\n')}` : ''
      const notice = rebuilt && api.some(m => m.role === 'assistant') ? '[codex-subagent: the earlier codex thread was not recoverable; this answer comes from a fresh thread]\n\n' : ''
      const text = `${notice}${f.text}${errors}\n\n[codex-subagent: model=${reply.model ?? '?'} thread=${reply.threadId}${reply.resumed ? ' (resumed)' : ''} codexPid=${reply.codexPid} bridgePid=${reply.bridgePid} status=${f.status}]`
      const toolUseId = `toolu_codex_handback_${reply.threadId.replace(/[^A-Za-z0-9_-]/g, '_')}_${e.turnId.replace(/[^A-Za-z0-9_-]/g, '_')}_${e.index}`
      agent.handback = { toolUseId, text }
      const input = { message: text }
      used(block)
      yield { kind: 'tool', index: block, id: toolUseId, name: HANDBACK }
      yield { kind: 'input', index: block, json: JSON.stringify(input) }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: HANDBACK, input }], stopReason: 'tool_use', usage: null } satisfies TurnStepResult
    } finally {
      next.signal.removeEventListener('abort', onAbort)
    }
  }).catch(async function* ($, e, next) {
    // A codex step must never reach `next`: beneath it is the Claude request.
    // The hook classifies the step before anything in it can fail, so this
    // reads that verdict without awaiting; only a step that failed before then
    // asks $.agent.list, bounded well inside the 1 s grace.
    const agentId = e.agentId
    const known = agentId !== undefined && (claimed.has(agentId) || agents.has(agentId))
    let ours = known || codexClaim(e.model, agentId ? st.subagentTypes.get(agentId) : undefined).ours
    if (!ours && agentId && !st.subagentTypes.has(agentId)) {
      let timer: Timer | undefined
      const listed = await Promise.race([
        $.agent.list().catch(() => [] as { id: string; type: string }[]),
        new Promise<{ id: string; type: string }[]>(resolve => { timer = $.clock.after(300, () => resolve([])) }),
      ]).finally(() => timer?.cancel())
      ours = codexClaim(e.model, listed.find(a => a.id === agentId)?.type).ours
    }
    if (!ours) return yield* next(e)
    const key = stepKey(e)
    const index = freeBlock.get(key) ?? 0
    freeBlock.delete(key)
    const { kind, message } = next.error
    try { diag(st, $, `turn.step ${kind} for ${e.agentId ?? '(no agent id)'}: ${message ?? '(no message)'}`) } catch {}
    return yield* endTurn(e, `[codex-subagent error] step hook ${kind}: ${message ?? '(no message)'}; send the message again`, index)
  })
}

async function* endTurn(e: { turnId: string; index: number }, text: string, block = 0): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  yield { kind: 'text', index: block, text }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
}
