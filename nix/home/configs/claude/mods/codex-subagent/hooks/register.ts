import type { ApiMessage, EngineInterface, Register, SessionMessage, TurnStepChunk, TurnStepResult } from 'claude-code'

// codex-subagent: pinned GPT agent types, served by codex app-server.
//
// The Agent tool spawns `codex-subagent:luna` (or `:sol`) like any agent, so
// the engine owns the agentId, the background task, the completion
// notification and SendMessage resumes. This plugin answers every `turn.step`
// of those agents without `next`, so no Claude request is ever sent.
//
// Codex keeps its own shell and apply_patch, sandboxed by the agent type. The
// Claude-side tools codex lacks (every MCP tool, Skill, WebFetch, WebSearch)
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
  luna: { model: 'gpt-5.6-luna', effort: 'xhigh', sandbox: 'workspace-write', blurb: 'implementer for well-planned code changes' },
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
  for (const t of tools) {
    if (!t.mcp && !(t.name in BUILTIN_RELAY)) continue
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
export function toolResultFor(api: readonly ApiMessage[], toolUseId: string): { contentItems: ContentItem[]; success: boolean } | undefined {
  const last = api[api.length - 1]
  if (!last || last.role !== 'user') return undefined
  const blocks = last.content as ApiBlock[]
  const i = blocks.findIndex(b => b.type === 'tool_result' && b.tool_use_id === toolUseId)
  if (i < 0) return undefined
  const r = blocks[i]
  if (!r) return undefined
  const contentItems = r.toolDenialKind === 'user-rejected'
    ? [{ type: 'inputText' as const, text: 'user rejected this tool call' }]
    : [...toItems(r.content), ...toItems(blocks.slice(i + 1).filter(b => b.type === 'text' || b.type === 'image'))]
  return { contentItems: contentItems.length ? contentItems : [{ type: 'inputText', text: '(empty result)' }], success: !r.is_error }
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
- The Claude session's other tools are relayed to you as dynamic tools: every mcp__<server>__<tool> as claude_mcp__<server>__<tool>, Skill (load a skill from the listing below by name, then follow what it returns), WebFetch and WebSearch. Call them through tools.<name> in exec. Claude Code runs them with its own permissions and returns the result.
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

type ApiBlock = { type: string; tool_use_id?: string; content?: unknown; is_error?: boolean; toolDenialKind?: string }

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

export function settlePending(reply: StepReply, wait: () => Promise<StepReply>, onRetry: (err: unknown) => void): Promise<StepResult> {
  const settle = async (current: StepReply): Promise<StepResult> => {
    if (!('pending' in current)) {
      if ('error' in current) throw new Error(`bridge: ${current.error}`)
      return current
    }
    try {
      return settle(await wait())
    } catch (err) {
      if (!/aborted: no complete answer/.test(String(err))) throw err
      onRetry(err)
      return settle(current)
    }
  }
  return settle(reply)
}

// A bridge for the session's life; resolves once it listens. A step calls this
// again when nothing listens on the socket (the bridge or codex died); the new
// bridge resumes threads from the threadId the step sends.
function startBridge($: EngineInterface, sock: string): Promise<void> {
  const { promise: ready, resolve: markReady } = Promise.withResolvers<void>()
  void (async () => {
    const bridge = $.process.spawn({ argv: ['node', `${$.plugin.root}/daemon/codex-bridge.mjs`, sock] })
    for await (const { stream, text } of bridge) {
      if (stream === 'stdout' && text.includes('"ready":true')) markReady?.()
      // $.ui.log drops any text over 4096 characters, so long bridge lines go in pieces.
      for (const line of text.trimEnd().split('\n'))
        for (let i = 0; i < line.length; i += 3900) $.ui.log(`[codex-bridge ${stream}] ${line.slice(i, i + 3900)}`, { to: 'debug' })
    }
    $.ui.log('[codex-bridge] exited', { to: 'debug' })
  })()
  return ready
}

export const register: Register = (on) => {
  const agents = new Map<string, Agent>()
  let sock = ''
  let bridgeReady: Promise<void> | undefined

  const socketPath = async ($: EngineInterface) => {
    const home = (await $.env.get('HOME')) ?? '/tmp'
    return `${home}/.claude-work/run/codex-subagent-${await $.session.id()}.sock`
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // The bridge's schema-harvest child is a `claude -p` that never reaches the
    // API; were this plugin installed there, it would start a bridge of its own.
    if ((await $.env.get('CODEX_SUBAGENT_HARVEST')) === '1') return started
    sock = await socketPath($)
    for (const [name, t] of Object.entries(TYPES)) {
      await $.agent.register({
        name,
        description: `Runs the task on OpenAI ${t.model} at ${t.effort} effort in the ${t.sandbox} sandbox through Codex (codex's own shell and edit tools, plus this session's MCP tools and skills relayed; ${t.blurb}). SendMessage continues the same codex thread.`,
        prompt: 'This agent is served by Codex; this prompt is never sent to a Claude model.',
        model: t.model, // never called: every step of this agent is answered by codex
      })
    }
    bridgeReady = startBridge($, sock)
    return started
  })

  on('agent.spawn', async ($, e, next) => {
    const type = typeOf(e.subagentType)
    const r = await next(e)
    if (type && r.agentId) agents.set(r.agentId, { type, cwd: e.cwd ?? (await $.session.cwd()) })
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const agent = e.agentId ? agents.get(e.agentId) : undefined
    if (!agent) return yield* next(e)
    const agentId = e.agentId!
    if (next.signal.aborted) return yield* endTurn(e, '[codex-subagent error] interrupted')
    const post = (route: string, payload: unknown) =>
      $.http.fetch(`http://codex-bridge${route}`, { method: 'POST', socketPath: sock, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    const onAbort = () => { void post('/interrupt', { key: agentId }).catch(() => {}) }
    next.signal.addEventListener('abort', onAbort)
    const ask = async (route: string, payload: unknown) => {
      const res = await abortable(post(route, payload), next.signal)
      if (!res.ok) throw new Error(`bridge POST ${route} ${res.status}: ${res.text.slice(0, 2000)}`)
      const r = JSON.parse(res.text) as StepReply
      if ('error' in r) throw new Error(`bridge: ${r.error}`)
      return r
    }

    const settle = (reply: StepReply): Promise<StepResult> => settlePending(
      reply,
      () => ask('/wait', { key: agentId }),
      err => $.ui.log(`[codex-subagent] /wait failed (${String(err)}); retrying`, { to: 'debug' }),
    )
    const step = async (body: Record<string, unknown>): Promise<StepResult> => {
      const roundTrip = async () => {
        await bridgeReady
        return ask('/step', body).then(settle)
      }
      try {
        return await roundTrip()
      } catch (err) {
        if (!unreachable(err)) throw err
        $.ui.log(`[codex-subagent] bridge unreachable (${String(err)}); restarting it`, { to: 'debug' })
        bridgeReady = startBridge($, sock)
        await bridgeReady
        return roundTrip()
      }
    }

    // A thrown turn.step falls through to the hook below, which would send
    // this agent's turn to a Claude model; a failure ends the turn as text instead.
    try {
      const api = await $.session.messages({ agentId, as: 'api' })
      if (!Array.isArray(api)) throw new Error(`cannot read agent ${agentId}'s messages: ${api.deny}`)
      if (agent.handback) {
        // A refused or failed handback ends as plain text, which the harness then delivers.
        const { toolUseId, text } = agent.handback
        agent.handback = undefined
        return yield* endTurn(e, toolResultFor(api, toolUseId)?.success ? `(report delivered through ${HANDBACK})` : text)
      }
      const type = TYPES[agent.type]
      const body: Record<string, unknown> = { key: agentId, threadId: agent.threadId, cwd: agent.cwd, model: type.model, effort: type.effort, sandbox: type.sandbox }
      const answered = agent.waiting && toolResultFor(api, agent.waiting.toolUseId)
      if (agent.waiting && answered) {
        body.toolResult = { callId: agent.waiting.callId, ...answered }
      } else {
        const rows = await $.session.messages({ agentId })
        const prompt = Array.isArray(rows) ? pendingPrompt(rows) : undefined
        if (!prompt) throw new Error(`agent ${agentId} has neither a pending prompt nor the tool_result for ${agent.waiting?.toolUseId ?? '(none)'}`)
        if (!agent.threadId) {
          agent.relay = relaySet(await $.tool.list())
          body.dynamicTools = agent.relay.tools
          body.mcpTools = agent.relay.mcp
          body.developerInstructions = `${PREAMBLE}\n\n${inheritedContext(api)}`
        }
        body.prompt = prompt
      }
      agent.waiting = undefined
      sock ||= await socketPath($)
      bridgeReady ??= startBridge($, sock)
      const reply = await step(body)
      agent.threadId = reply.threadId

      if ('toolCall' in reply) {
        const { callId, tool, arguments: input } = reply.toolCall
        const name = agent.relay?.claudeName.get(tool) ?? tool
        const toolUseId = `toolu_codex_${callId.replace(/[^A-Za-z0-9_-]/g, '_')}`
        agent.waiting = { toolUseId, callId }
        const chunks: TurnStepChunk[] = [
          { kind: 'tool', index: 0, id: toolUseId, name },
          { kind: 'input', index: 0, json: JSON.stringify(input ?? {}) },
          { kind: 'stop', stopReason: 'tool_use', usage: null },
        ]
        for (const c of chunks) yield c
        return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name, input }], stopReason: 'tool_use', usage: null } satisfies TurnStepResult
      }

      const f = 'final' in reply ? reply.final : { text: '', status: undefined, errors: ['bridge reply had neither toolCall nor final'] }
      const errors = f.errors.length ? `\n\n[codex errors] ${f.errors.join('\n')}` : ''
      const text = `${f.text}${errors}\n\n[codex-subagent: model=${reply.model ?? '?'} thread=${reply.threadId}${reply.resumed ? ' (resumed)' : ''} codexPid=${reply.codexPid} bridgePid=${reply.bridgePid} status=${f.status}]`
      const toolUseId = `toolu_codex_handback_${reply.threadId.replace(/[^A-Za-z0-9_-]/g, '_')}_${e.index}`
      agent.handback = { toolUseId, text }
      const input = { message: text }
      yield { kind: 'tool', index: 0, id: toolUseId, name: HANDBACK }
      yield { kind: 'input', index: 0, json: JSON.stringify(input) }
      yield { kind: 'stop', stopReason: 'tool_use', usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: HANDBACK, input }], stopReason: 'tool_use', usage: null } satisfies TurnStepResult
    } catch (err) {
      const text = `[codex-subagent error] ${err instanceof Error ? err.message : String(err)}`
      $.ui.log(text, { to: 'debug' })
      return yield* endTurn(e, text)
    } finally {
      next.signal.removeEventListener('abort', onAbort)
    }
  })
}

async function* endTurn(e: { turnId: string; index: number }, text: string): AsyncGenerator<TurnStepChunk, TurnStepResult> {
  yield { kind: 'text', index: 0, text }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null }
}
