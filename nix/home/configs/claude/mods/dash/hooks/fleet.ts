import type { AgentInfo, AgentSpawnArgs } from 'claude-code'
import type { TrackedAgent } from '../types'

const RUNNING_STATUSES = new Set(['running', 'pending', 'queued', 'starting', 'waiting'])

export function excerpt(text: string, limit = 112): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, Math.max(0, limit - 1))}…` : flat
}

export function taskDescription(args: AgentSpawnArgs): string | undefined {
  const description = args.description?.trim()
  if (description) return excerpt(description)
  const line = args.prompt.split(/\r?\n/).map(part => part.trim()).find(part => part && !part.startsWith('Budget:') && !part.startsWith('writable:'))
  return line ? excerpt(line) : undefined
}

export function recordSpawn(agents: TrackedAgent[], id: string, type: string, description: string | undefined, now: number): TrackedAgent[] {
  const existing = agents.find(agent => agent.id === id)
  const tracked: TrackedAgent = existing
    ? { ...existing, type, description: description ?? existing.description, startedAt: now, startEstimated: false }
    : { id, type, description, status: 'running', startedAt: now, startEstimated: false, lastMessage: '' }
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
      description: prior?.description,
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
      description: existing.description,
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

export function withoutStaleDone(agents: TrackedAgent[], keep: number): TrackedAgent[] {
  const stale = agents
    .filter(agent => agent.status === 'done')
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
    .slice(keep)
  const hidden = new Set(stale.map(agent => agent.id))
  return agents.filter(agent => !hidden.has(agent.id))
}
