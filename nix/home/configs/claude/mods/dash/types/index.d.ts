export type UsageSnapshot = {
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  costUsd?: number
  context?: { window: number; tokens?: number; percent?: number }
  startedAt?: number
}

export type LineChanges = { added: number; removed: number }

export type TrackedAgent = {
  id: string
  type: string
  status: 'running' | 'done'
  startedAt: number
  startEstimated: boolean
  finishedAt?: number
  lastMessage: string
}

declare module 'claude-code' {
  export type DashDashboardState = {
    now: number
    usage: UsageSnapshot | null
    lines: LineChanges
    agents: TrackedAgent[]
    clm: { status: Awaited<ReturnType<EngineInterface['clm']['status']>> } | { error: string } | null
  }

  interface PluginState {
    dash: { dashboard: DashDashboardState }
  }
}
