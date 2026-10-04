import type { EngineInterface, Register, SessionMessage } from 'claude-code'

// clm replaces the engine's compaction for the main conversation. When the
// rows outgrow a token budget, a cheap model folds the turns about to go into a
// ledger (goal, user instructions, work done, work left, open questions, key
// facts), and this plugin's `session.compact` hook rewrites the transcript to
// [first request, ledger row, newest turns]. The engine summarizer never runs:
// every main-session compaction, /compact and the engine's own threshold
// included, is answered here, and the ahead-of-time `precompute` is refused.
//
// Interactive sessions fold right after the turn that crossed the budget. A
// headless (-p / SDK) session refuses a plugin-raised compaction, so there the
// plan waits in the store for the next /compact or engine compaction.

export const SECTIONS = ['목표', '사용자 지시', '한 일', '할 일', '미결 질문', '핵심 사실·경로'] as const
export const EMPTY_LEDGER = SECTIONS.map(s => `## ${s}\n- (none yet)`).join('\n\n')
const LEDGER_TAG = '[clm ledger'
const RESULT_FLOOR = 128 // tokens each kept tool result may shrink to, at least
const OVERSIZE_MARK = '출력 과다:'
const OVERSIZE_KEEP = 5
const FAILS_BEFORE_FALLBACK = 3

// --- rows ----------------------------------------------------------------

export const estTokens = (m: SessionMessage): number => {
  let chars = m.text.length
  for (const u of m.toolUses) chars += JSON.stringify(u.input ?? {}).length + u.tool.length
  for (const r of m.toolResults ?? []) chars += r.text.length
  return Math.ceil(chars / 4)
}
const sum = (rows: readonly SessionMessage[]) => rows.reduce((n, m) => n + estTokens(m), 0)

export const fingerprint = (m: SessionMessage): string =>
  [m.role, m.toolUses.map(u => u.tool_use_id).join(','), (m.toolResults ?? []).map(r => r.tool_use_id).join(','), m.text.slice(0, 160)].join('|')

// Rows the engine injects rather than the conversation. SessionMessage has no
// origin flag, so match text. "(no content)" is how the engine rebuilds an
// empty assistant row after a compaction.
const SYSTEM_ROW = {
  taskNotification: /^\s*<task-notification>/,
  remindersOnly: /^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/,
}
const isBare = (m: SessionMessage) => m.toolUses.length === 0 && (m.toolResults ?? []).length === 0
const isEmptyRow = (m: SessionMessage) => isBare(m) && (m.text.trim() === '' || (m.role === 'assistant' && m.text.trim() === '(no content)'))
export const isSystemRow = (m: SessionMessage): boolean => {
  if (!isBare(m)) return false
  if (m.role === 'assistant') return isEmptyRow(m)
  return SYSTEM_ROW.taskNotification.test(m.text) || SYSTEM_ROW.remindersOnly.test(m.text)
}
export const isLedgerRow = (m: SessionMessage) => m.role === 'user' && m.text.startsWith(LEDGER_TAG)
const isPrompt = (m: SessionMessage) =>
  m.role === 'user' && m.text.trim() !== '' && (m.toolResults ?? []).length === 0 && !isSystemRow(m) && !isLedgerRow(m)

export const protectedIndex = (msgs: readonly SessionMessage[]): number => {
  const i = msgs.findIndex(isPrompt)
  return i < 0 ? 0 : i
}
export const visibleTokens = (msgs: readonly SessionMessage[]) => msgs.reduce((n, m) => n + (isSystemRow(m) ? 0 : estTokens(m)), 0)

// `$.session.messages()` returns the stored transcript, older chains before a
// compact boundary included, and no API option scopes it. So each fold records
// the ledger row it wrote (unique: it carries a sequence number and a time) and
// its offset; the live rows start that far before its last occurrence.
export type Boundary = { fp: string; offset: number }
export function liveRows(msgs: readonly SessionMessage[], b: Boundary | undefined): readonly SessionMessage[] {
  if (!b) return msgs
  for (let j = msgs.length - 1; j >= 0; j--) if (fingerprint(msgs[j]!) === b.fp) return msgs.slice(Math.max(0, j - b.offset))
  return msgs
}

// Rebuilt WITHOUT the handle: a handled row keeps its old parent and message id,
// and on --resume the loader pulls the pre-fold chain back in.
const strip = (m: SessionMessage): SessionMessage =>
  ({ role: m.role, text: m.text, toolUses: m.toolUses, ...(m.toolResults ? { toolResults: m.toolResults } : {}) })

// --- planning a fold -----------------------------------------------------

export type ClearPlan = {
  head: readonly SessionMessage[]
  dropped: readonly SessionMessage[]
  tail: readonly SessionMessage[]
  keptTurns: number
  /** tool_use_id -> token share its result is cut to */
  cuts: Record<string, number>
}

// Turns open on a real user prompt, so whole turns never split a tool_use
// from its tool_result. The tail is the newest turns that fit `target`
// alongside the head and the ledger, and always holds the newest one.
export function planClear(msgs: readonly SessionMessage[], target: number, ledgerTokens: number): ClearPlan | undefined {
  const first = protectedIndex(msgs)
  const starts = msgs.flatMap((m, i) => (i > first && isPrompt(m) ? [i] : []))
  const head = msgs.slice(0, first + 1)
  const fixed = sum(head) + ledgerTokens
  let keepFrom = starts.length ? starts[starts.length - 1]! : first + 1
  let keptTurns = starts.length ? 1 : 0
  for (let t = starts.length - 2; t >= 0; t--) {
    if (fixed + sum(msgs.slice(starts[t]!)) > target) break
    keepFrom = starts[t]!
    keptTurns++
  }
  const tail = msgs.slice(keepFrom)
  const dropped = msgs.slice(first + 1, keepFrom).filter(m => !isLedgerRow(m) && !isSystemRow(m))
  const cuts = fixed + sum(tail) > target ? shareResults(tail, target - fixed) : {}
  if (dropped.length === 0 && Object.keys(cuts).length === 0) return undefined
  return { head, dropped, tail, keptTurns, cuts }
}

// Each tool result in the tail gets an equal slice of the room left after the
// tail's other text; only results bigger than their slice are cut.
function shareResults(tail: readonly SessionMessage[], room: number): Record<string, number> {
  const results = tail.flatMap(m => m.toolResults ?? [])
  if (results.length === 0) return {}
  const other = sum(tail) - results.reduce((n, r) => n + Math.ceil(r.text.length / 4), 0)
  const share = Math.max(RESULT_FLOOR, Math.floor((room - other) / results.length))
  const cuts: Record<string, number> = {}
  for (const r of results) if (Math.ceil(r.text.length / 4) > share) cuts[r.tool_use_id] = share
  return cuts
}

export function cutText(text: string, share: number): string {
  const keep = share * 4
  const headChars = Math.floor(keep * 0.6)
  return `${text.slice(0, headChars)}\n…[clm: ${text.length - keep} of ${text.length} chars cut at fold time]…\n${text.slice(text.length - (keep - headChars))}`
}
const applyCuts = (m: SessionMessage, cuts: Record<string, number>): SessionMessage =>
  !m.toolResults?.some(r => cuts[r.tool_use_id] !== undefined)
    ? m
    : { ...m, toolResults: m.toolResults.map(r => (cuts[r.tool_use_id] === undefined ? r : { ...r, text: cutText(r.text, cuts[r.tool_use_id]!) })) }

export function buildCleared(plan: Pick<ClearPlan, 'head' | 'tail' | 'cuts'>, ledgerRow: SessionMessage): SessionMessage[] {
  return [...plan.head, ledgerRow, ...plan.tail].filter(m => !isEmptyRow(m)).map(m => strip(applyCuts(m, plan.cuts)))
}

export const ledgerRowText = (seq: number, at: string, path: string, ledger: string) =>
  `${LEDGER_TAG} #${seq} · ${at}] Earlier turns of this session were folded into these notes by the harness (file: ${path}). They are your memory of that work.\n\n${ledger}`

// --- ledger text ---------------------------------------------------------

const sectionsOf = (ledger: string) => ledger.split(/^(?=## )/m)
const isSection = (part: string, name: string) => part.trimEnd() === `## ${name}` || part.startsWith(`## ${name}\n`)

/** Adds lines at the end of one section, replacing its "(none yet)" placeholder. */
export function appendToSection(ledger: string, section: string, lines: readonly string[]): string {
  if (lines.length === 0) return ledger
  return sectionsOf(ledger)
    .map(p => (isSection(p, section) ? `${[...p.trimEnd().split('\n').filter(l => l.trim() !== '- (none yet)'), ...lines].join('\n')}\n\n` : p))
    .join('')
    .trimEnd()
}

/** Records commands whose output had to be cut, newest five only. */
export function rememberOversize(ledger: string, lines: readonly string[]): string {
  if (lines.length === 0) return ledger
  return sectionsOf(ledger)
    .map(p => {
      if (!isSection(p, '핵심 사실·경로')) return p
      const body = p.trimEnd().split('\n')
      const keep = [...body.filter(l => l.includes(OVERSIZE_MARK)), ...lines].slice(-OVERSIZE_KEEP)
      return `${[...body.filter(l => !l.includes(OVERSIZE_MARK) && l.trim() !== '- (none yet)'), ...keep].join('\n')}\n\n`
    })
    .join('')
    .trimEnd()
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ')
const oversizeLines = (tail: readonly SessionMessage[], cuts: Record<string, number>) =>
  tail.flatMap(m => m.toolUses).filter(u => cuts[u.tool_use_id] !== undefined)
    .map(u => `- ${OVERSIZE_MARK} ${clip(oneLine(`${u.tool} ${JSON.stringify(u.input ?? {})}`), 70)}`)

// Deterministic stand-in when the merge model keeps failing: the dropped
// prompts verbatim, and one line per dropped turn naming the tools it used.
export function fallbackLedger(prev: string, dropped: readonly SessionMessage[]): string {
  const turns: { prompt?: string; tools: string[] }[] = []
  for (const m of dropped) {
    if (isPrompt(m) || turns.length === 0) turns.push({ prompt: isPrompt(m) ? m.text : undefined, tools: [] })
    turns[turns.length - 1]!.tools.push(...m.toolUses.map(u => u.tool))
  }
  const asks = turns.flatMap(t => (t.prompt ? [`- "${oneLine(t.prompt)}"`] : []))
  const done = turns.map(t => `- turn ${t.prompt ? `"${clip(oneLine(t.prompt), 60)}"` : '(first request, continued)'}: tools ${t.tools.length ? [...new Set(t.tools)].join(', ') : 'none'}`)
  return appendToSection(appendToSection(prev, '사용자 지시', asks), '한 일', done)
}

const MERGE_SYSTEM = [
  'You keep the working ledger of a coding session whose oldest turns are about to be deleted.',
  'You receive the current ledger and the turns being removed. Reply with the updated ledger only: no preamble, no code fence.',
  `Use exactly these six level-2 headings, each once, in this order: ${SECTIONS.map(s => `"## ${s}"`).join(', ')}.`,
  '- 목표: what the session is trying to achieve, updated if the turns changed it.',
  '- 사용자 지시: every instruction the user gave, copied word for word inside quotes. Never paraphrase. Keep earlier ones unless the user withdrew them.',
  '- 한 일: one bullet per finished step, with the command or check that showed it worked and what it printed.',
  '- 할 일: steps still ahead; move an item to 한 일 once the turns show it finished.',
  '- 미결 질문: questions still waiting for an answer, and who must answer them.',
  `- 핵심 사실·경로: file paths with line numbers, ids, versions, numbers and decisions a later step will need. Keep lines starting with "${OVERSIZE_MARK}" as they are.`,
  'Drop small talk and anything later turns replaced. Write bullets. Keep the whole ledger under 900 words.',
].join('\n')

export function renderTurns(rows: readonly SessionMessage[], cap = 120_000): string {
  const out = rows.map(m => {
    const parts = [m.text ? `[${m.role}] ${clip(m.text, 4000)}` : `[${m.role}]`]
    for (const u of m.toolUses) parts.push(`  -> ${u.tool} ${clip(JSON.stringify(u.input ?? {}), 600)}`)
    for (const r of m.toolResults ?? []) parts.push(`  <- ${r.isError ? 'error ' : ''}${clip(r.text, 1500)}`)
    return parts.join('\n')
  }).join('\n')
  return out.length > cap ? `…[older part cut]\n${out.slice(out.length - cap)}` : out
}

export const normalizeLedger = (text: string) => text.trim().replace(/^```[a-z]*\n([\s\S]*?)\n```$/, '$1').trim()
/** Why a merged ledger is unusable, or undefined when it is fine. */
export function ledgerProblem(ledger: string, maxTokens: number): string | undefined {
  const heads = [...ledger.matchAll(/^##\s+(.+?)\s*$/gm)].map(m => m[1]!)
  if (heads.join('|') !== SECTIONS.join('|')) return `headers were [${heads.join(', ')}], expected the six sections in order`
  if (Math.ceil(ledger.length / 4) > maxTokens) return `ledger is ~${Math.ceil(ledger.length / 4)}t, over the ${maxTokens}t cap`
  return undefined
}

// --- options -------------------------------------------------------------

export type Opts = { budget: number; tailTarget: number; reserve: number }
/** Reads userConfig, naming every value it could not use and the value used instead. */
export function readOpts(o: Record<string, unknown>): { opts: Opts; problems: string[] } {
  const problems: string[] = []
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
  let budget = 32000
  if (o.budget !== undefined) {
    if (isInt(o.budget) && o.budget >= 2000) budget = o.budget
    else {
      budget = typeof o.budget === 'number' && Number.isFinite(o.budget) && o.budget > 0 ? Math.max(2000, Math.round(o.budget)) : 32000
      problems.push(`budget=${JSON.stringify(o.budget)} must be an integer of at least 2000; using ${budget}`)
    }
  }
  const half = Math.floor(budget / 2)
  let tailTarget = half
  if (o.tailTarget !== undefined && o.tailTarget !== 0) {
    if (isInt(o.tailTarget) && o.tailTarget > 0 && o.tailTarget < budget) tailTarget = o.tailTarget
    else problems.push(`tailTarget=${JSON.stringify(o.tailTarget)} must be a positive integer under the budget (${budget}); using ${half}`)
  }
  const defReserve = Math.min(2048, Math.floor(budget / 4))
  let reserve = defReserve
  if (o.reserve !== undefined && o.reserve !== 0) {
    if (isInt(o.reserve) && o.reserve > 0 && o.reserve < budget) reserve = o.reserve
    else problems.push(`reserve=${JSON.stringify(o.reserve)} must be a positive integer under the budget (${budget}); using ${defReserve}`)
  }
  return { opts: { budget, tailTarget, reserve }, problems }
}

// --- session state -------------------------------------------------------

type Pending = { text: string; ledger: string; seq: number; keepFp?: string; cuts: Record<string, number>; keptTurns: number; fallback: boolean }
type Meta = { seq: number; lastClear?: string; boundary?: Boundary; lastSkip?: string; fails: number; ratio?: number; probe?: { est: number; real: number } }
const sid = ($: EngineInterface) => $.session.id()
const metaKey = async ($: EngineInterface) => `ledger:${await sid($)}`
const pendingKey = async ($: EngineInterface) => `pending:${await sid($)}`
const readMeta = async ($: EngineInterface): Promise<Meta> => ({ seq: 0, fails: 0, ...((await $.store.get(await metaKey($))) as Partial<Meta> | undefined) })
const writeMeta = async ($: EngineInterface, m: Meta) => $.store.set(await metaKey($), m)

async function basePath($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  return `${home ?? '.'}/.claude-work/plans/clm-${await sid($)}`
}
const ledgerPath = async ($: EngineInterface) => `${await basePath($)}.md`
const logPath = async ($: EngineInterface) => `${await basePath($)}.log.jsonl`
async function readText($: EngineInterface, p: string): Promise<string | undefined> {
  return (await $.fs.exists(p)) ? ((await $.fs.read(p)) as string) : undefined
}

export type LogEvent = 'clear' | 'skip-not-shrinking' | 'merge-invalid' | 'merge-timeout' | 'fallback' | 'truncation' | 'calibration'
type LogFields = { tokensBefore?: number; tokensAfter?: number; keptTurns?: number; ratio?: number; reason?: string }
const LOG_KEEP = 200
async function logEvent($: EngineInterface, event: LogEvent, f: LogFields) {
  try {
    const p = await logPath($)
    const lines = ((await readText($, p)) ?? '').split('\n').filter(Boolean)
    lines.push(JSON.stringify({ ts: new Date().toISOString(), event, ...f }))
    await $.fs.write(p, `${lines.slice(-LOG_KEEP).join('\n')}\n`)
  } catch { /* the log must never stop a fold */ }
}

// chars/4 undercounts Korean and code; the ratio corrects every estimate. It is
// measured on growth between two turns: SessionUsage.context.tokens also holds
// the system prompt, tools and the context the engine attaches to rows that
// `$.session.messages()` never shows, so a plain quotient reads several times
// too high (live: 11301 real against 413 estimated). Growth cancels that part.
const RATIO_MIN = 0.5, RATIO_MAX = 3
const MIN_GROWTH = 200 // estimated tokens of growth a sample needs
async function calibrate($: EngineInterface, rows: readonly SessionMessage[], meta: Meta): Promise<number> {
  const ratio = meta.ratio ?? 1
  try {
    const real = (await $.session.usage()).context.tokens
    if (real === undefined) return ratio
    const est = sum(rows)
    const prev = meta.probe
    meta.probe = { est, real }
    const grewEst = prev ? est - prev.est : 0
    const grewReal = prev ? real - prev.real : 0
    if (grewEst < MIN_GROWTH || grewReal <= 0) {
      await writeMeta($, meta)
      return ratio
    }
    const sample = Math.min(RATIO_MAX, Math.max(RATIO_MIN, grewReal / grewEst))
    const next = meta.ratio === undefined ? sample : 0.7 * meta.ratio + 0.3 * sample
    meta.ratio = Math.round(Math.min(RATIO_MAX, Math.max(RATIO_MIN, next)) * 1000) / 1000
    await writeMeta($, meta)
    await logEvent($, 'calibration', { tokensBefore: grewEst, tokensAfter: grewReal, ratio: meta.ratio, reason: `growth sample ${sample.toFixed(3)}` })
    return meta.ratio
  } catch {
    return ratio
  }
}

async function skip($: EngineInterface, why: string) {
  $.ui.log(`clm: fold skipped, ${why}`, { to: 'debug' })
  await writeMeta($, { ...(await readMeta($)), lastSkip: why })
}

// --- folding -------------------------------------------------------------

type Fold = { plan: ClearPlan; ledger: string; text: string; seq: number; fallback: boolean }

/**
 * Plans a fold of `rows` and merges the dropped turns into the ledger. Returns
 * the reason instead when there is nothing to fold, the merge failed and
 * `mustFold` is off, or the result would not be smaller. Updates `meta.fails`;
 * the caller writes `meta`.
 */
async function fold($: EngineInterface, opts: Opts, rows: readonly SessionMessage[], meta: Meta, mustFold: boolean): Promise<Fold | string> {
  const ratio = meta.ratio ?? 1
  const prev = (await readText($, await ledgerPath($))) ?? EMPTY_LEDGER
  // Estimates are raw chars/4 and limits real tokens, so limits are divided by the ratio.
  const plan = planClear(rows, opts.tailTarget / ratio, Math.ceil(prev.length / 4) + 60)
  if (!plan) return 'nothing left to fold'

  let ledger = prev
  let fallback = false
  if (plan.dropped.length > 0) {
    const r = await $.model.complete({
      model: 'haiku',
      system: MERGE_SYSTEM,
      prompt: `<ledger>\n${prev}\n</ledger>\n\n<removed_turns>\n${renderTurns(plan.dropped)}\n</removed_turns>`,
      maxTokens: 4096,
      timeoutMs: 120_000,
    })
    const merged = r.isAnswered ? normalizeLedger(r.text) : ''
    const bad = r.isAnswered ? ledgerProblem(merged, Math.max(500, Math.floor(opts.budget / 4))) : `merge model gave no text (${r.reason})`
    if (bad === undefined) {
      ledger = merged
      meta.fails = 0
    } else {
      meta.fails += 1
      await logEvent($, !r.isAnswered && r.reason === 'aborted' ? 'merge-timeout' : 'merge-invalid', { ratio, reason: `${bad} (failure ${meta.fails} in a row)` })
      if (!mustFold && meta.fails < FAILS_BEFORE_FALLBACK) return `merged ledger rejected: ${bad}`
      // A merge that never succeeds must not block folding forever.
      ledger = fallbackLedger(prev, plan.dropped)
      fallback = true
      meta.fails = 0
      $.ui.log(`clm: merge failed (${bad}); folded with a mechanical ledger instead`, { to: 'debug' })
      await logEvent($, 'fallback', { ratio, reason: bad })
    }
  }
  ledger = rememberOversize(ledger, oversizeLines(plan.tail, plan.cuts))

  const seq = meta.seq + 1
  const text = ledgerRowText(seq, new Date().toISOString(), await ledgerPath($), ledger)
  const tokensBefore = sum(rows)
  const tokensAfter = sum(buildCleared(plan, { role: 'user', text, toolUses: [] }))
  if (tokensAfter >= tokensBefore) {
    const why = `the fold would not shrink the context (${tokensBefore} -> ${tokensAfter} est. tokens)`
    $.ui.log(`clm: ${why}`)
    await logEvent($, 'skip-not-shrinking', { tokensBefore, tokensAfter, keptTurns: plan.keptTurns, ratio, reason: why })
    return why
  }
  if (Object.keys(plan.cuts).length)
    await logEvent($, 'truncation', { keptTurns: plan.keptTurns, ratio, reason: `cut ${Object.keys(plan.cuts).length} tool result(s) to ~${Object.values(plan.cuts)[0]}t each` })
  return { plan, ledger, text, seq, fallback }
}

async function maybeClear($: EngineInterface, opts: Opts) {
  const meta = await readMeta($)
  const rows = liveRows(await $.session.messages(), meta.boundary)
  const ratio = await calibrate($, rows, meta)
  if (visibleTokens(rows) * ratio <= opts.budget - opts.reserve) return
  const f = await fold($, opts, rows, meta, false)
  await writeMeta($, meta)
  if (typeof f === 'string') return skip($, f)
  const pending: Pending = {
    text: f.text, ledger: f.ledger, seq: f.seq, keepFp: f.plan.tail[0] && fingerprint(f.plan.tail[0]),
    cuts: f.plan.cuts, keptTurns: f.plan.keptTurns, fallback: f.fallback,
  }
  await $.store.set(await pendingKey($), pending)
  try {
    // Answered by this plugin's own session.compact hook below, which applies
    // the pending plan; the engine summarizer is never reached.
    await $.session.compact({})
  } catch (err) {
    $.ui.log(`clm: fold deferred to the next compaction (${String(err).slice(0, 160)})`, { to: 'debug' })
  }
}

export function report(ledger: string | undefined, rows: readonly SessionMessage[], opts: Opts, meta: Meta, logTail: readonly string[]): string {
  const used = Math.round(visibleTokens(rows) * (meta.ratio ?? 1))
  return [
    `clm budget: ${used}/${opts.budget} tokens (${Math.round((used / opts.budget) * 100)}%); folds above ${opts.budget - opts.reserve}, tail target ${opts.tailTarget}, ratio ${meta.ratio ?? 1}`,
    `rows: ${rows.filter(m => !isSystemRow(m)).length} kept, ${rows.filter(isSystemRow).length} hidden system rows`,
    `last fold: ${meta.lastClear ?? 'never'} (ledger #${meta.seq})${meta.lastSkip ? `; last skip: ${meta.lastSkip}` : ''}`,
    '',
    ledger ?? '(no ledger yet)',
    '',
    'recent decisions:',
    ...(logTail.length ? logTail : ['(none)']),
  ].join('\n')
}

const GUIDE = [
  'Memory ledger (clm): when this conversation outgrows its budget, the harness folds the older turns into one row that starts with "[clm ledger".',
  'That row records the goal, the user\'s instructions verbatim, what was done with its evidence, what is left, open questions and key facts; the turns it replaced are gone.',
  'Rely on it as your own memory of that work. When something matters later, say it plainly in a reply so the next fold keeps it.',
].join('\n')

export const register: Register = (on, options) => {
  const { opts, problems } = readOpts(options as Record<string, unknown>)

  on('session.start', async ($, e, next) => {
    for (const p of problems) $.ui.log(`clm: option ${p}`)
    await $.command.register({ name: 'clm', description: 'Show the clm ledger, budget use and recent decisions (shown to you only).', immediate: true })
    return next(e)
  })

  // Printed through ui.log, which the engine draws as a notice and never sends
  // to the model; a command's `text` is a transcript row and may be.
  on('command.run', { command: 'clm' }, async $ => {
    const meta = await readMeta($)
    const rows = liveRows(await $.session.messages(), meta.boundary)
    const log = ((await readText($, await logPath($))) ?? '').split('\n').filter(Boolean).slice(-5)
    $.ui.log(report(await readText($, await ledgerPath($)), rows, opts, meta, log))
    return {}
  })

  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId !== undefined) return res
    try {
      await maybeClear($, opts)
    } catch (err) {
      $.ui.log(`clm: fold failed, ${String(err).slice(0, 200)}`, { to: 'debug' })
    }
    return res
  })

  // The main conversation's every compaction ends here and never reaches
  // next(e), the engine summarizer: a pending plan is applied, otherwise the
  // fold is planned and merged on the spot. Subagents keep the engine's.
  on('session.compact', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    if (e.trigger === 'precompute') return { skip: 'clm replaces compaction' }
    // Without a transcript there is nothing to rewrite; a pending plan waits.
    if (!Array.isArray(e.messages)) return { skip: 'clm: the compaction carried no transcript' }
    const all = e.messages
    const meta = await readMeta($)
    const rows = liveRows(all, meta.boundary)
    const first = protectedIndex(rows)
    const key = await pendingKey($)
    const pending = (await $.store.get(key)) as Pending | undefined
    if (pending) await $.store.delete(key)

    let use: (Omit<Pending, 'keepFp'> & { keepFrom: number }) | undefined
    if (pending) {
      let keepFrom = pending.keepFp === undefined ? rows.length : -1
      for (let i = rows.length - 1; i > first && keepFrom < 0; i--) if (fingerprint(rows[i]!) === pending.keepFp) keepFrom = i
      if (keepFrom >= 0) use = { ...pending, keepFrom }
    }
    if (!use) {
      const f = await fold($, opts, rows, meta, true)
      await writeMeta($, meta)
      if (typeof f === 'string') {
        $.ui.log(`clm: ${e.trigger} compaction left the conversation as it is: ${f}`)
        return { messages: all }
      }
      use = { text: f.text, ledger: f.ledger, seq: f.seq, cuts: f.plan.cuts, keptTurns: f.plan.keptTurns, fallback: f.fallback, keepFrom: rows.length - f.plan.tail.length }
    }

    const ledgerRow: SessionMessage = { role: 'user', text: use.text, toolUses: [] }
    const messages = buildCleared({ head: rows.slice(0, first + 1), tail: rows.slice(use.keepFrom), cuts: use.cuts }, ledgerRow)
    const tokensBefore = sum(rows)
    const tokensAfter = sum(messages)
    await $.fs.write(await ledgerPath($), `${use.ledger}\n`)
    const offset = messages.findIndex(m => m.text === use.text)
    await writeMeta($, { ...meta, seq: use.seq, lastClear: new Date().toISOString(), lastSkip: undefined, boundary: { fp: fingerprint(ledgerRow), offset } })
    await logEvent($, 'clear', { tokensBefore, tokensAfter, keptTurns: use.keptTurns, ratio: meta.ratio ?? 1, reason: `${e.trigger}${use.fallback ? ', fallback ledger' : ''}` })
    return { messages, tokensBefore, tokensAfter }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (e.traits.includes('bare')) return r
    return { ...r, sections: [...r.sections, { id: 'clm:guide', text: GUIDE, scope: 'session' as const }] }
  })
}
