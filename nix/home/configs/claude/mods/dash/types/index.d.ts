export type DashTab = 'usage' | 'context' | 'fleet' | 'clm'

export type UsageSnapshot = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  costUsd?: number
}

export type DashContextCategory = { name: string; tokens: number; kind: string }
export type ContextCategory = DashContextCategory

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
    tab: DashTab
    now: number
    usage: UsageSnapshot | null
    categories: DashContextCategory[] | null
    agents: TrackedAgent[]
    clm: { status: Awaited<ReturnType<EngineInterface['clm']['status']>> } | { error: string } | null
  }

  interface PluginState {
    dash: { dashboard: DashDashboardState }
  }
}
