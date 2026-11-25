import type { EngineInterface, HttpInit, Register } from 'claude-code'
import { PreCompactor, preIo, preSettings } from './precompact'

export const BETA = 'context-management-2025-06-27'
export const EDIT = 'clear_tool_uses_20250919'

type Settings = { trigger: number; keep: number; clearAtLeast: number }
type Edit = { type?: unknown; [k: string]: unknown }

const whole = (v: unknown, min: number, fallback: number) =>
  typeof v === 'number' && Number.isInteger(v) && v >= min ? v : fallback

export function settings(options: Record<string, unknown>): Settings {
  return {
    trigger: whole(options.triggerTokens, 1, 100000),
    keep: whole(options.keepToolUses, 0, 3),
    clearAtLeast: whole(options.clearAtLeastTokens, 0, 20000),
  }
}

// Only a message creation takes context_management: /v1/messages/count_tokens and batches keep their own shape.
const isMessagesCreate = (url: string, method: string | undefined) =>
  (method ?? 'GET').toUpperCase() === 'POST' && new URL(url).pathname.replace(/\/+$/, '').endsWith('/v1/messages')

function withBeta(headers: Record<string, string>): Record<string, string> {
  const key = Object.keys(headers).find(k => k.toLowerCase() === 'anthropic-beta') ?? 'anthropic-beta'
  const betas = (headers[key] ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return betas.includes(BETA) ? headers : { ...headers, [key]: [...betas, BETA].join(',') }
}

export type Rewrite = { init: HttpInit; kind: 'added' | 'kept-existing' } | { init?: undefined; kind: 'skipped-thread' }

// Answers the rewritten init, or undefined for a request this mod leaves as written.
export function rewrite(url: string, init: HttpInit | undefined, s: Settings): Rewrite | undefined {
  if (!init || typeof init.body !== 'string' || !isMessagesCreate(url, init.method)) return undefined
  let body: unknown
  try { body = JSON.parse(init.body) } catch { return undefined }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray((body as { messages?: unknown }).messages)) return undefined
  const req = body as Record<string, unknown>
  // The API refuses clear_tool_uses beside a message `thread`, and Claude Code then drops the thread for the rest of the session.
  if (req.thread !== undefined) return { kind: 'skipped-thread' }
  const cm = req.context_management && typeof req.context_management === 'object' ? req.context_management as Record<string, unknown> : {}
  const edits: Edit[] = Array.isArray(cm.edits) ? cm.edits as Edit[] : []
  // An edit of this type already present (Claude Code's own tool-result clearing) wins; one copy per type is all the API takes.
  const kind = edits.some(e => e?.type === EDIT) ? 'kept-existing' : 'added'
  const edit = {
    type: EDIT,
    trigger: { type: 'input_tokens', value: s.trigger },
    keep: { type: 'tool_uses', value: s.keep },
    ...(s.clearAtLeast > 0 ? { clear_at_least: { type: 'input_tokens', value: s.clearAtLeast } } : {}),
  }
  // Appending keeps clear_thinking_20251015 first, where the API requires it.
  const nextEdits = kind === 'added' ? [...edits, edit] : edits
  const nextBody = { ...req, context_management: { ...cm, edits: nextEdits } }
  return { kind, init: { ...init, headers: withBeta(init.headers ?? {}), body: JSON.stringify(nextBody) } }
}

function log($: EngineInterface, text: string) {
  return $.ui.log(`[bg-compact] ${text}`, { to: 'debug' })
}

type FetchArgs = { url: string; init?: HttpInit }
type FetchNext<T> = ((e: FetchArgs) => Promise<T>) & { origin: { plugin: string } }

// The http.fetch hook body, exported so a test drives it as the engine would: the test kit's engine raises no http.fetch.
// `logged` holds the rewrite kinds already logged, so the debug log gets one line per kind.
export async function handle<T>($: EngineInterface, e: FetchArgs, next: FetchNext<T>, s: Settings, logged: Set<string>): Promise<T> {
  if (next.origin.plugin !== 'engine') return next(e)
  let r: Rewrite | undefined
  try {
    r = rewrite(e.url, e.init, s)
  } catch {
    return next(e)
  }
  if (!r) return next(e)
  if (!logged.has(r.kind)) {
    logged.add(r.kind)
    const what = r.kind === 'added' ? 'added' : r.kind === 'kept-existing' ? 'kept the existing' : 'left out (request carries a thread)'
    try { await log($, `${what} ${EDIT} on ${new URL(e.url).pathname} (trigger ${s.trigger}, keep ${s.keep}, clear_at_least ${s.clearAtLeast})`) } catch {}
  }
  return r.init ? next({ ...e, init: r.init }) : next(e)
}

export const register: Register = (on, options) => {
  const s = settings(options as Record<string, unknown>)
  const logged = new Set<string>()
  on('http.fetch', ($, e, next) => handle($, e, next, s, logged))

  // Any failure in the pre-compaction hooks leaves the engine's behaviour as it was, with one debug line.
  const pre = new PreCompactor(preSettings(options as Record<string, unknown>))
  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      try { await pre.turnEnd(preIo($)) }
      catch (err) { try { await log($, `pre-compaction check failed (${String(err).slice(0, 200)})`) } catch {} }
    }
    return res
  })
  on('session.compact', async ($, e, next) => {
    let handed: Promise<Awaited<ReturnType<typeof next>>> | undefined
    const once = (input: typeof e) => handed ??= next(input)
    try { return await pre.compact(preIo($), e, once) }
    catch (err) {
      try { await log($, `session.compact fell through (${String(err).slice(0, 200)})`) } catch {}
      return handed ?? next(e)
    }
  })
}
