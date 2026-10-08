// The time budget's arithmetic and its gate, with no `$`: what register.ts
// asks of a unit at each tool call, timer and report.
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
// After 6/6, a main turn that is still running gets this long to write its
// report with every tool but `report` denied, then it is aborted.
export const GRACE_MS = 2 * 60_000
// Unlimited mode auto-resumes a turn that ended with clm tasks open at most this many times in a row.
export const MAX_RESUMES = 50

export const TOOL = {
  estimate: 'mcp__time-budget__estimate',
  report: 'mcp__time-budget__report',
  grant: 'mcp__time-budget__grant',
} as const
const HANDBACK = 'SubagentHandback'
const BEFORE_ESTIMATE = new Set<string>([TOOL.estimate, 'ToolSearch', HANDBACK])
const WHILE_REPORT_DUE = new Set<string>([TOOL.report, TOOL.estimate, 'ToolSearch', HANDBACK])
const WHILE_HALTED = new Set<string>([TOOL.report, HANDBACK])

/** One line of calibration.jsonl, as time-budget.py wrote it. */
export type Pair = { kind: 'main' | 'sub'; agent_type: string | null; estimate_min: number; budget_min: number; actual_min: number; at: number }

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

/** `Budget: <N> min` as the prompt's first line: an optional spawner estimate; codex requires it because no gate reaches inside codex. */
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

const SHAPE = 'done (each item with the check that proved it), open (each item with its next action), and more_min when the open items need more time'

export function gate(unit: Unit | undefined, tool: string, now: number): { deny: string } | undefined {
  if (!unit) return undefined
  if (unit.budgetMin === undefined) {
    if (unit.kind === 'main') return undefined
    if (BEFORE_ESTIMATE.has(tool)) return undefined
    return { deny: `Call ${TOOL.estimate} first, with minutes (your estimate for the whole task), scope (one line) and steps (the plan). The user sees the calibrated budget; then call ${tool} again.` }
  }
  const elapsed = now - unit.start
  if (unit.halted) {
    if (WHILE_HALTED.has(tool)) return undefined
    return { deny: `Stop here: ${unit.halted}. Call ${TOOL.report} with ${SHAPE}, then end the turn with that report; use an extension button above the prompt to continue.` }
  }
  if (unit.reportDue && !WHILE_REPORT_DUE.has(tool)) {
    return { deny: `Checkpoint ${unit.reportDue} (${mins(elapsed)}/${Math.round(unit.budgetMin)} min): call ${TOOL.report} with ${SHAPE}, then call ${tool} again.` }
  }
  return undefined
}

/** `unlimited`: the user's unattended mode, where no budget ever stops the work. */
export function haltReason(unit: Unit, now: number, unlimited = false): string | undefined {
  if (unlimited || unit.budgetMin === undefined) return undefined
  const elapsed = now - unit.start
  if (elapsed >= unit.budgetMin * 60_000) return `the budget of ${Math.round(unit.budgetMin)} min is spent (${mins(elapsed)} min elapsed)`
  if (unit.report) {
    const p = projectedMin(unit.reportAt! - unit.start, unit.report)
    if (p > unit.budgetMin) return `the last report projects ${Math.round(p)} min against a budget of ${Math.round(unit.budgetMin)} min`
  }
  return undefined
}

/** The line the user reads: in the status line and beneath a main answer. */
export function statusText(unit: Unit, now: number): string {
  if (unit.budgetMin === undefined) return 'budget: no estimate yet'
  const elapsed = now - unit.start
  const base = `budget ${mins(elapsed)}/${Math.round(unit.budgetMin)}m`
  if (unit.halted) return `${base} · stopped: ${unit.halted}`
  if (unit.reportDue) return `${base} · checkpoint ${unit.reportDue} report due`
  const next = CHECKPOINTS[unit.fired]
  return next ? `${base} · next ${next.label} at ${mins(dueAt(unit.fired, unit.budgetMin))}m` : base
}

export function reportText(r: Report): string {
  const done = r.done.map(d => `- ${d.item} (checked: ${d.check})`).join('\n') || '- (none)'
  const open = r.open.map(o => `- ${o.item} -> ${o.next}`).join('\n') || '- (none)'
  return `Verified done:\n${done}\nOpen:\n${open}${r.more_min ? `\nAsks +${r.more_min} min` : ''}`
}

export function isReport(x: unknown): x is Report {
  const r = x as Report
  return !!r && Array.isArray(r.done) && Array.isArray(r.open)
    && r.done.every(d => d && typeof d.item === 'string' && typeof d.check === 'string')
    && r.open.every(o => o && typeof o.item === 'string' && typeof o.next === 'string')
    && (r.more_min === undefined || (typeof r.more_min === 'number' && r.more_min >= 0))
}
