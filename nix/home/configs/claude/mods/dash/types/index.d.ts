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

declare module 'claude-code' {
  export type DashDashboardState = {
    now: number
    usage: UsageSnapshot | null
    agents: TrackedAgent[]
    clm: { status: Awaited<ReturnType<EngineInterface['clm']['status']>> } | { error: string } | null
    baseline?: string
    behind?: Behind
  }

  interface PluginState {
    dash: { dashboard: DashDashboardState }
  }
}
