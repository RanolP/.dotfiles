export type DashTab = 'usage' | 'context' | 'fleet'

export type UsageSnapshot = {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  costUsd?: number
}

export type ContextCategory = { name: string; tokens: number; kind: string }

export type TrackedAgent = {
  id: string
  type: string
  status: 'running' | 'done'
  startedAt: number
  startEstimated: boolean
  finishedAt?: number
  lastMessage: string
}

export type DashboardState = {
  tab: DashTab
  now: number
  usage: UsageSnapshot | null
  categories: ContextCategory[] | null
  agents: TrackedAgent[]
}

declare module 'claude-code' {
  interface PluginState {
    dash: { dashboard: DashboardState }
  }
}
