export type UsageSnapshot = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

export type TrackedAgent = {
  id: string
  type: string
  description?: string
  status: 'running' | 'done'
  startedAt: number
  startEstimated: boolean
  finishedAt?: number
  lastMessage: string
}

export type Behind = number | 'unknown'

export type ClmIssueRow = { id: string; title: string; status: string }
/** One file-backed section's parsed rows, or the one-line reason it could not be read. */
export type Section<T> = { rows: T } | { error: string }
export type ClmRows = { focus: ClmIssueRow | null; stackDepth: number; pending: ClmIssueRow[]; open: ClmIssueRow[] }
export type WayseekerRows = { want: string[]; ask: string[] }

declare module 'claude-code' {
  export type SummationDashboardState = {
    now: number
    usage: UsageSnapshot | null
    agents: TrackedAgent[]
    clm: Section<ClmRows> | null
    wayseeker: Section<WayseekerRows> | null
    baseline?: string
    behind?: Behind
  }

  interface PluginState {
    'summation-panel': { dashboard: SummationDashboardState }
  }
}