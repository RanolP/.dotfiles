export type Report = {
  done: { item: string; check: string }[]
  open: { item: string; next: string }[]
  more_min?: number
}

/** One timed unit: a main-thread clm task, or one subagent run. */
export type Unit = {
  kind: 'main' | 'sub'
  agentType?: string
  /** `$.clock.now()` milliseconds when the unit began. */
  start: number
  estimateMin?: number
  /** Calibrated budget; undefined until the estimate is declared. */
  budgetMin?: number
  scope?: string
  steps?: string[]
  /** How many of CHECKPOINTS have fired. */
  fired: number
  /** The latest checkpoint label, shown as a report reminder. */
  reportDue?: string
  /** Highest checkpoint index whose reminder has reached the model. */
  lastNudge?: number
  /** Time of the last overrun reminder, used to space reminders by one sixth of the budget. */
  lastOverrunNudgeAt?: number
  report?: Report
  reportAt?: number
  extendedMin?: number
  extensions?: number
  /** A subagent report main has not been shown yet. */
  unread?: boolean
  /** The last time a main turn of this unit ended: the unit's actual end for calibration. */
  lastEnd?: number
  /** The unit's calibration pair is already logged; a resumed main task logs none again. */
  calibrated?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    /** `parked`: closed main units whose clm task can still be resumed, keyed by issue id. */
    'time-budget': { units: Record<string, Unit>; parked: Record<string, Unit>; goal: string | null }
  }
}
