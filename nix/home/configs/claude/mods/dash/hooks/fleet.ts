import type { AgentInfo } from 'claude-code'
import type { TrackedAgent } from '../types'

const RUNNING_STATUSES = new Set(['running', 'pending', 'queued', 'starting', 'waiting'])

export function excerpt(text: string, limit = 112): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, Math.max(0, limit - 1))}…` : flat
}

export function recordSpawn(agents: TrackedAgent[], id: string, type: string, now: number): TrackedAgent[] {
  const existing = agents.find(agent => agent.id === id)
  const tracked: TrackedAgent = existing
    ? { ...existing, type, startedAt: now, startEstimated: false }
    : { id, type, status: 'running', startedAt: now, startEstimated: false, lastMessage: '' }
  return [...agents.filter(agent => agent.id !== id), tracked].sort((a, b) => a.startedAt - b.startedAt)
}

export function reconcileAgents(agents: TrackedAgent[], listed: readonly AgentInfo[], listedAt: number, now: number): TrackedAgent[] {
  const previous = new Map(agents.map(agent => [agent.id, agent]))
  const seen = new Set<string>()
  const merged = listed.map(info => {
    seen.add(info.id)
    const prior = previous.get(info.id)
    const completedAfterListing = prior?.status === 'done' && prior.finishedAt !== undefined && prior.finishedAt > listedAt
    const isDone = completedAfterListing || !RUNNING_STATUSES.has(info.status.toLowerCase())
    return {
      id: info.id,
      type: info.type || prior?.type || 'agent',
      status: isDone ? 'done' as const : 'running' as const,
      startedAt: prior?.startedAt ?? now,
      startEstimated: prior?.startEstimated ?? true,
      ...(isDone ? { finishedAt: prior?.finishedAt ?? now } : {}),
      lastMessage: prior?.lastMessage ?? '',
    }
  })
  for (const agent of agents) {
    if (seen.has(agent.id)) continue
    merged.push(agent.status === 'done' ? agent : { ...agent, status: 'done', finishedAt: now })
  }
  return merged.sort((a, b) => a.startedAt - b.startedAt)
}

export function recordMessage(agents: TrackedAgent[], id: string, text: string, now: number): TrackedAgent[] {
  const existing = agents.find(agent => agent.id === id)
  const tracked: TrackedAgent = existing
    ? {
      id: existing.id,
      type: existing.type,
      status: 'running',
      startedAt: existing.startedAt,
      startEstimated: existing.startEstimated,
      lastMessage: excerpt(text),
    }
    : { id, type: 'agent', status: 'running', startedAt: now, startEstimated: true, lastMessage: excerpt(text) }
  return [...agents.filter(agent => agent.id !== id), tracked].sort((a, b) => a.startedAt - b.startedAt)
}

export function recordCompletion(agents: TrackedAgent[], id: string, text: string, now: number): TrackedAgent[] {
  const existing = agents.find(agent => agent.id === id)
  const tracked: TrackedAgent = existing
    ? { ...existing, status: 'done', finishedAt: now, lastMessage: excerpt(text) }
    : { id, type: 'agent', status: 'done', startedAt: now, startEstimated: true, finishedAt: now, lastMessage: excerpt(text) }
  return [...agents.filter(agent => agent.id !== id), tracked].sort((a, b) => a.startedAt - b.startedAt)
}
