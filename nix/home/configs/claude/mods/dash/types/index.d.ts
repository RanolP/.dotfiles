export type UsageSnapshot = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

export type TrackedAgent = {
  id: string
  type: string
  status: 'running' | 'done'
  startedAt: number
  startEstimated: boolean
  finishedAt?: number
  lastMessage: string
}

export type SystemGeneration = {
  storePath: string
  revision?: string
}

export type Behind = number | 'unknown'

declare module 'claude-code' {
  export type DashDashboardState = {
    now: number
    usage: UsageSnapshot | null
    agents: TrackedAgent[]
    clm: { status: Awaited<ReturnType<EngineInterface['clm']['status']>> } | { error: string } | null
    generation?: SystemGeneration
    behind?: Behind
  }

  interface PluginState {
    dash: { dashboard: DashDashboardState }
  }
}
