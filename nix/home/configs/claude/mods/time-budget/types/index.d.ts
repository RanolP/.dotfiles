export type Report = {
  done: { item: string; check: string }[]
  open: { item: string; next: string }[]
  more_min?: number
}

/** One timed unit: the main thread's task since the user's prompt, or one subagent run. */
export type Unit = {
  kind: 'main' | 'sub'
  agentType?: string
  /** `$.clock.now()` milliseconds when the unit began. */
  start: number
  estimateMin?: number
  /** Calibrated budget; undefined until the estimate is declared, which is what the gate waits on. */
  budgetMin?: number
  scope?: string
  steps?: string[]
  /** How many of CHECKPOINTS have fired. */
  fired: number
  /** The label of the checkpoint whose report every other tool waits on. */
  reportDue?: string
  /** Why the unit stopped; every tool but the report is denied while set. */
  halted?: string
  haltedAt?: number
  report?: Report
  reportAt?: number
  /** A subagent report main has not been shown yet. */
  unread?: boolean
  /** The last time a main turn of this unit ended: the unit's actual end for calibration. */
  lastEnd?: number
}

declare module 'claude-code' {
  interface PluginState {
    'time-budget': { units: Record<string, Unit> }
  }
}
