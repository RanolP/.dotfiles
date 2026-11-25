import type { EngineInterface, SessionCompactInput, SessionCompactResult, SessionMessage, SessionUsage } from 'claude-code'

// Pre-compaction: "compaction 한계 전에 사전 압축한다. 이후, 실제 compaction이 올 때 사전 압축과 사전 압축 기점 이후 토큰을 단순 concat하여 압축한다."
// A turn end past `ratio` of the auto-compact limit forks a summary of the transcript; the real compaction then
// answers with that summary followed by every message after the fork's boundary, as the engine handed them over.

export type PreSettings = { ratio: number; extendRatio: number }

const fraction = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1 ? v : fallback

export function preSettings(options: Record<string, unknown>): PreSettings {
  return { ratio: fraction(options.preCompactRatio, 0.6), extendRatio: fraction(options.extendRatio, 0.3) }
}

// The boundary: the newest rows the fork read, newest last. SessionMessage carries a uuid only on a ranged read and
// none on session.compact's input, so the match is by fingerprint; a run of rows keeps a repeated prompt ("continue")
// from matching an older copy.
export type PreCompaction = { summary: string; boundary: string[]; uuid?: string; createdAt: number; tokens: number }

const BOUNDARY_ROWS = 3

function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16)
}

export const fingerprint = (m: SessionMessage): string =>
  [m.role, m.toolUses.map(u => u.tool_use_id).join(','), (m.toolResults ?? []).map(r => r.tool_use_id).join(','), m.text.length, hash(m.text)].join('|')

// The fork reads the main thread's last request, which ends on the newest user row (a prompt or a tool_result);
// the turn's final reply came back as that request's answer, so the boundary is that user row, not the reply.
export function boundaryOf(rows: readonly SessionMessage[]): { boundary: string[]; uuid?: string } | undefined {
  const at = rows.findLastIndex(m => m.role === 'user')
  if (at < 0) return undefined
  return { boundary: rows.slice(Math.max(0, at - BOUNDARY_ROWS + 1), at + 1).map(fingerprint), uuid: rows[at]!.uuid }
}

// Index of the boundary's last row in `rows`, searched from the newest; -1 when it is gone.
export function findBoundary(rows: readonly SessionMessage[], boundary: readonly string[]): number {
  if (!boundary.length) return -1
  const fps = rows.map(fingerprint)
  outer: for (let j = fps.length - 1; j >= boundary.length - 1; j--) {
    for (let k = 0; k < boundary.length; k++) if (fps[j - k] !== boundary[boundary.length - 1 - k]) continue outer
    return j
  }
  return -1
}

export const SUMMARY_HEAD = 'This session continues from an earlier part of the conversation, summarized below; every message after this one is the conversation since, unchanged.'

export const summaryMessage = (summary: string): SessionMessage => ({ role: 'user', text: `${SUMMARY_HEAD}\n\n<summary>\n${summary.trim()}\n</summary>`, toolUses: [] })

// The compaction a stored pre-compaction answers, or why it cannot: the boundary gone, or a tool_result after it whose
// tool_use was summarized away (the API refuses an unpaired tool_result).
export function concat(rows: readonly SessionMessage[], pre: PreCompaction): { messages: SessionMessage[] } | { miss: string } {
  const at = findBoundary(rows, pre.boundary)
  if (at < 0) return { miss: 'boundary not in the transcript' }
  const tail = rows.slice(at + 1)
  const used = new Set<string>()
  for (const m of tail) {
    for (const u of m.toolUses) used.add(u.tool_use_id)
    for (const r of m.toolResults ?? []) if (!used.has(r.tool_use_id)) return { miss: `tool_result ${r.tool_use_id} after the boundary has no tool_use after it` }
  }
  return { messages: [summaryMessage(pre.summary), ...tail] }
}

export function summaryPrompt(previous?: string): string {
  return [
    'Stop the task. You have no tools in this reply: answer straight away with text only.',
    'Write a continuation summary of this conversation for yourself: the same agent will carry on the work from it, with the summary in place of the turns it covers.',
    'Read the whole transcript, tool results included, and keep exact file paths, commands, commit SHAs, identifiers and numbers as they appear there.',
    'Cover, under these headings:',
    '1. Goal: what the user wants, and every instruction they gave, quoted in their own words.',
    '2. Decisions: what was decided and why.',
    '3. Done: what was done, with the files, commands and commits involved and their outcome.',
    '4. Left: what remains, in order.',
    '5. Open questions: what is unresolved or waiting on the user.',
    ...(previous ? [
      'An earlier summary of this conversation follows. Extend it into one complete summary covering everything up to now: keep what still holds, update what changed, and add what came after it.',
      '<earlier-summary>', previous.trim(), '</earlier-summary>',
    ] : []),
    'Reply with the summary alone.',
  ].join('\n')
}

// What the turn end does: fork a first summary, extend the stored one, or nothing.
export function plan(tokens: number | undefined, limit: number | undefined, pre: PreCompaction | undefined, s: PreSettings): 'first' | 'extend' | undefined {
  if (tokens === undefined || limit === undefined || !(limit > 0)) return undefined
  // A record above the current tokens belongs to a transcript that has since shrunk.
  if (!pre || tokens < pre.tokens) return tokens >= s.ratio * limit ? 'first' : undefined
  return tokens - pre.tokens > s.extendRatio * limit ? 'extend' : undefined
}

// The auto-compact limit; the compaction window when auto-compaction is off, so /compact still finds a summary.
export function limitOf(usage: SessionUsage): number | undefined {
  const b = usage.context.breakdown
  return b?.autoCompactThreshold ?? b?.rawMaxTokens ?? usage.context.window
}

export type PreIo = {
  sessionId(): Promise<string>
  usage(): Promise<{ tokens?: number; limit?: number }>
  rows(): Promise<readonly SessionMessage[]>
  fork(prompt: string): Promise<{ text?: string; why?: string }>
  read(session: string): Promise<PreCompaction | undefined>
  // Every stored pre-compaction, newest first: a resume that opens a new session id finds its own by boundary.
  readAll(): Promise<PreCompaction[]>
  write(session: string, pre: PreCompaction | undefined): Promise<void>
  now(): Promise<number>
  log(text: string): Promise<void>
}

const isPre = (v: unknown): v is PreCompaction => {
  const p = v as PreCompaction
  return !!p && typeof p === 'object' && typeof p.summary === 'string' && Array.isArray(p.boundary) && p.boundary.every(f => typeof f === 'string')
    && typeof p.createdAt === 'number' && typeof p.tokens === 'number'
}
export const parsePre = (text: string | undefined): PreCompaction | undefined => {
  if (!text) return undefined
  try { const v = JSON.parse(text); return isPre(v) ? v : undefined } catch { return undefined }
}

// One pre-compaction job per session at a time; `generation` moves on at each compaction, so a fork that finishes
// after one stores nothing for a transcript that is gone.
export class PreCompactor {
  private running = new Set<string>()
  private generation = new Map<string, number>()
  constructor(private s: PreSettings) {}

  isRunning(session: string) { return this.running.has(session) }

  // At a main-thread turn end: decides, and starts the fork unawaited; resolves the job for a caller that waits (tests).
  async turnEnd(io: PreIo): Promise<{ started?: Promise<void> }> {
    const session = await io.sessionId()
    if (this.running.has(session)) return {}
    const [pre, { tokens, limit }] = await Promise.all([io.read(session), io.usage()])
    const step = plan(tokens, limit, pre, this.s)
    if (!step) return {}
    this.running.add(session)
    const gen = this.generation.get(session) ?? 0
    const started = this.run(io, session, gen, tokens!, step === 'extend' ? pre : undefined)
      .catch(err => io.log(`pre-compaction failed (${String(err).slice(0, 200)})`).catch(() => {}))
      .finally(() => this.running.delete(session))
    return { started }
  }

  private async run(io: PreIo, session: string, gen: number, tokens: number, previous: PreCompaction | undefined) {
    const rows = await io.rows()
    const at = boundaryOf(rows)
    if (!at) { await io.log('pre-compaction skipped: no user row to anchor a boundary'); return }
    const reply = await io.fork(summaryPrompt(previous?.summary))
    if (!reply.text?.trim()) { await io.log(`pre-compaction fork gave no summary (${reply.why ?? 'empty'})`); return }
    const createdAt = await io.now()
    if ((this.generation.get(session) ?? 0) !== gen) { await io.log('pre-compaction dropped: the conversation compacted while it ran'); return }
    await io.write(session, { summary: reply.text.trim(), ...at, createdAt, tokens })
    await io.log(`pre-compaction ${previous ? 'extended' : 'stored'} at ${tokens} tokens`)
  }

  // The session.compact hook body for the main thread.
  async compact(io: PreIo, e: SessionCompactInput, next: (e: SessionCompactInput) => Promise<SessionCompactResult>): Promise<SessionCompactResult> {
    if (e.agentId !== undefined || !Array.isArray(e.messages)) return next(e)
    const session = await io.sessionId()
    let pre = await io.read(session)
    if (!pre || findBoundary(e.messages, pre.boundary) < 0) {
      for (const other of await io.readAll()) if (findBoundary(e.messages, other.boundary) >= 0) { pre = other; break }
    }
    // Any compaction but the precompute probe makes a new transcript: the stored record has served or no longer applies,
    // even when instructions send the compaction to the engine.
    if (e.trigger !== 'precompute') {
      this.generation.set(session, (this.generation.get(session) ?? 0) + 1)
      await io.write(session, undefined)
    }
    // Instructions typed after /compact ask for a summary the stored one was not written to.
    if (e.instructions?.trim()) return next(e)
    if (e.trigger === 'precompute') return pre && findBoundary(e.messages, pre.boundary) >= 0 ? { skip: 'bg-compact holds a pre-compaction' } : next(e)
    const done = pre ? concat(e.messages, pre) : { miss: 'no pre-compaction stored' }
    if ('miss' in done) { await io.log(`compaction handed to the engine: ${done.miss}`); return next(e) }
    await io.log(`compaction answered from the pre-compaction: summary + ${done.messages.length - 1} messages`)
    return { messages: done.messages }
  }
}

// The limit by context window: the breakdown that names it is estimated locally but walks every category, so it is read
// once per window size rather than at every turn end.
const limits = new Map<number, number | undefined>()

export function preIo($: EngineInterface): PreIo {
  let dir: Promise<string> | undefined
  const data = () => dir ??= $.process.hookEnv().then(env => {
    const d = env.CLAUDE_PLUGIN_DATA
    if (!d) throw new Error('CLAUDE_PLUGIN_DATA is unset')
    return d
  })
  const pathOf = async (session: string) => `${await data()}/precompact-${session.replace(/[^\w.-]/g, '_')}.json`
  const readText = async (path: string) => (await $.fs.exists(path)) ? await $.fs.read(path) : undefined
  return {
    sessionId: () => $.session.id(),
    usage: async () => {
      const { context } = await $.session.usage()
      if (!limits.has(context.window)) limits.set(context.window, limitOf(await $.session.usage({ breakdown: 'summary' })))
      return { tokens: context.tokens, limit: limits.get(context.window) }
    },
    rows: () => $.session.messages({ last: 64 }).then(r => 'deny' in r ? [] : r),
    fork: async prompt => {
      const r = await $.model.fork({ prompt })
      return r.isAnswered ? { text: r.text } : { why: r.reason }
    },
    read: async session => parsePre(await readText(await pathOf(session))),
    readAll: async () => {
      const d = await data()
      const found: PreCompaction[] = []
      for (const f of await $.fs.list(d)) {
        if (!/^precompact-.*\.json$/.test(f.name)) continue
        const pre = parsePre(await readText(`${d}/${f.name}`))
        if (pre) found.push(pre)
      }
      return found.sort((a, b) => b.createdAt - a.createdAt)
    },
    // The fs noun has no delete: a cleared record is the literal null.
    write: async (session, pre) => { await $.fs.write(await pathOf(session), JSON.stringify(pre ?? null)) },
    now: () => $.clock.now(),
    log: async text => { $.ui.log(`[bg-compact] ${text}`, { to: 'debug' }) },
  }
}
