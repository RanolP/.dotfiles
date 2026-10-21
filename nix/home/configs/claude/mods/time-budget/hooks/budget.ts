// The time budget's arithmetic and feedback formatting, with no `$`.
//
// WHY THE HARNESS MEASURES: a model's own time estimate runs 3-10x off, and a
// mid-task "percent done" self-report is unreliable (arXiv 2609.08589). So the
// wall clock lives here, and the estimate only seeds a budget after it is
// scaled by the p90 of actual/estimate over past units, clamped to [0.25, 10].
// A report lists verified-done and open items, never a percentage, which
// relieves the late-task pull toward closing over verifying (arXiv 2609.00823).

import type { Report, Unit } from '../types'

// The user's notation; keep exactly these five.
export const CHECKPOINTS = [
  { label: '1/3', f: 1 / 3 },
  { label: '1/2', f: 1 / 2 },
  { label: '2/3', f: 2 / 3 },
  { label: '5/6', f: 5 / 6 },
  { label: '6/6', f: 1 },
] as const
export const LAST = CHECKPOINTS.length

export const FLOOR_MIN = 15
const MIN_HISTORY = 5
export const HISTORY_WINDOW = 50
const FACTOR_MIN = 0.25
const FACTOR_MAX = 10
export const TOOL = {
  estimate: 'mcp__time-budget__estimate',
  report: 'mcp__time-budget__report',
  extend: 'mcp__time-budget__extend',
  grant: 'mcp__time-budget__grant',
} as const

/** One line of calibration.jsonl, as time-budget.py wrote it. */
export type Pair = {
  kind: 'main' | 'sub'
  agent_type: string | null
  estimate_min: number
  budget_min: number
  actual_min: number
  at: number
  extended_min?: number
  extensions?: number
}

/** One line of extensions.jsonl, recording a deliberate time-budget change or request. */
export type Extension = {
  at: number
  kind: 'main' | 'sub'
  agent_type: string | null
  task: string
  scope: string
  estimate_min: number
  budget_before: number
  budget_after: number
  minutes: number
  elapsed_min: number
  reason: string
  source: 'extend' | 'reestimate' | 'grant' | 'report'
}

export function parsePairs(text: string): Pair[] {
  const out: Pair[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const p = JSON.parse(line) as unknown
      if (p && typeof p === 'object' && !Array.isArray(p)) out.push(p as Pair)
    } catch { /* a torn line is skipped, as the python reader did */ }
  }
  return out
}

export function parseExtensions(text: string): Extension[] {
  const out: Extension[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as unknown
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Extension)
    } catch { /* a torn line is skipped, as the calibration reader does */ }
  }
  return out
}

export function extensionSummary(pairs: readonly Partial<Pair>[], extensions: readonly Partial<Extension>[]): string {
  const recentPairs = pairs.slice(-20)
  const needed = recentPairs.filter(pair => (pair.extended_min ?? 0) > 0)
  const actualExtensions = extensions.filter(extension => (extension.source === 'extend' || extension.source === 'grant') && (extension.minutes ?? 0) > 0)
  const amounts = actualExtensions.slice(-20).map(extension => extension.minutes!).sort((a, b) => a - b)
  const middle = Math.floor(amounts.length / 2)
  const median = amounts.length === 0 ? undefined : amounts.length % 2
    ? amounts[middle]
    : (amounts[middle - 1]! + amounts[middle]!) / 2
  const reasons = extensions.slice(-3).map(extension => {
    const reason = String(extension.reason ?? '').replace(/\s+/g, ' ').trim()
    return reason.length > 100 ? `${reason.slice(0, 99)}…` : reason
  }).filter(Boolean)
  const unitHistory = recentPairs.length ? `${needed.length}/${recentPairs.length} recent units needed extra time` : 'no completed units yet'
  const medianText = median === undefined ? 'no recorded extensions' : `median +${median} min per extension`
  const reasonText = reasons.length ? ` Recent reasons: ${reasons.map(reason => `“${reason}”`).join('; ')}.` : ''
  return `Extension history: ${unitHistory}; ${medianText}.${reasonText}`
}

export function calibrationFactor(pairs: readonly Partial<Pair>[]): number {
  const ratios = pairs.slice(-HISTORY_WINDOW)
    .filter(p => (p.estimate_min ?? 0) > 0 && (p.actual_min ?? -1) >= 0)
    .map(p => p.actual_min! / p.estimate_min!)
    .sort((a, b) => a - b)
  if (ratios.length < MIN_HISTORY) return 1
  const p90 = ratios[Math.max(0, Math.ceil(0.9 * ratios.length) - 1)]!
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, p90))
}

export const budgetFor = (estimateMin: number, factor: number) => Math.max(FLOOR_MIN, estimateMin * factor)

/** When checkpoint `i` (0-based) falls, in whole ms since the unit's start. Whole ms keep the timer and
 * `crossed` in agreement: with a fractional due time, start + due rounded to the timer's ms while
 * elapsed stayed below due, so the timer fired, found nothing crossed, and re-armed at delay 0 forever. */
export const dueAt = (i: number, budgetMin: number) => Math.ceil(CHECKPOINTS[i]!.f * budgetMin * 60_000)

/** How many checkpoints the elapsed time has passed. */
export const crossed = (elapsedMs: number, budgetMin: number) => CHECKPOINTS.filter((_, i) => elapsedMs >= dueAt(i, budgetMin)).length

/** `Budget: <N> min` as the prompt's first line: an optional estimate for a spawned subagent. */
export const budgetLine = (prompt: string): number | undefined => {
  const m = /^\s*Budget:\s*(\d+(?:\.\d+)?)\s*min\s*$/i.exec(prompt.split('\n', 1)[0] ?? '')
  const n = m ? Number(m[1]) : NaN
  return n > 0 ? n : undefined
}

/** Minutes the work will take at the pace the report shows: elapsed per done item, times the open items left. */
export function projectedMin(elapsedMs: number, report: Report): number {
  const elapsed = elapsedMs / 60_000
  const rate = elapsed / Math.max(1, report.done.length)
  return elapsed + rate * report.open.length
}

export const mins = (ms: number) => Math.round(ms / 60_000)

/** The line the user reads: in the status line and beneath a main answer. */
export function statusText(unit: Unit, now: number): string {
  if (unit.budgetMin === undefined) return 'budget: no estimate yet'
  const elapsed = now - unit.start
  const base = `budget ${mins(elapsed)}/${Math.round(unit.budgetMin)}m`
  if (elapsed > unit.budgetMin * 60_000) return `${base} · over by ${mins(elapsed - unit.budgetMin * 60_000)}m`
  if (unit.reportDue) return `${base} · checkpoint ${unit.reportDue} report due`
  const next = CHECKPOINTS[unit.fired]
  return next ? `${base} · next ${next.label} at ${mins(dueAt(unit.fired, unit.budgetMin))}m` : base
}

export function reportText(r: Report): string {
  const done = r.done.map(d => `- ${d.item} (checked: ${d.check})`).join('\n') || '- (none)'
  const open = r.open.map(o => `- ${o.item} -> ${o.next}`).join('\n') || '- (none)'
  return `Verified done:\n${done}\nOpen:\n${open}${r.more_min ? `\nRequests +${r.more_min} min` : ''}`
}

export function isReport(x: unknown): x is Report {
  const r = x as Report
  return !!r && Array.isArray(r.done) && Array.isArray(r.open)
    && r.done.every(d => d && typeof d.item === 'string' && typeof d.check === 'string')
    && r.open.every(o => o && typeof o.item === 'string' && typeof o.next === 'string')
    && (r.more_min === undefined || (typeof r.more_min === 'number' && r.more_min >= 0))
}
