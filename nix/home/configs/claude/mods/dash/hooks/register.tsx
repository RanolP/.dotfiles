import { atom, read, update } from 'claude-code'
import type {
  DashDashboardState, EngineInterface, Register, SessionUsage, Timer,
} from 'claude-code'
import type { TrackedAgent, UsageSnapshot } from '../types'
import { reconcileAgents, recordCompletion, recordMessage, recordSpawn } from './fleet'

type Elements = ReturnType<EngineInterface['ui']['resolve']>
type ClmStatus = Awaited<ReturnType<EngineInterface['clm']['status']>>

const PANE = 'dash'
const TITLE = 'Dash'
const REFRESH_MS = 15_000
const dashboard = atom({ plugin: 'dash', key: 'dashboard' } as const, {
  now: 0, usage: null, agents: [], clm: null,
} satisfies DashDashboardState)

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function log($: EngineInterface, operation: string, error: unknown): Promise<void> {
  try {
    await $.ui.log(`[dash] ${operation}: ${errorText(error)}`, { to: 'debug' })
  } catch {
    // The original operation's cause is more useful than a second logging failure.
  }
}

async function now($: EngineInterface, operation: string): Promise<number | undefined> {
  try {
    return await $.clock.now()
  } catch (error) {
    await log($, operation, error)
    return undefined
  }
}

async function pass<T>($: EngineInterface, operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    await log($, operation, error)
    throw error
  }
}

async function change($: EngineInterface, operation: string, fn: (state: DashDashboardState) => DashDashboardState): Promise<void> {
  try {
    await update($, dashboard, fn)
  } catch (error) {
    await log($, operation, error)
  }
}

function snapshot(usage: Pick<SessionUsage, 'rateLimits' | 'cost'>): UsageSnapshot {
  return {
    rateLimits: usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) })),
    ...(usage.cost ? { costUsd: usage.cost.usd } : {}),
  }
}

async function initialize($: EngineInterface): Promise<void> {
  const measuredAt = await now($, 'clock.now during startup')
  if (measuredAt === undefined) return

  const usage = await $.session.usage().then(
    snapshot,
    (error: unknown) => log($, 'session.usage during startup', error).then(() => undefined),
  )
  const listedAt = (await now($, 'clock.now before startup agent.list')) ?? measuredAt
  const listed = await $.agent.list().catch(
    (error: unknown) => log($, 'agent.list during startup', error).then(() => undefined),
  )
  const reconciledAt = (await now($, 'clock.now after startup agent.list')) ?? measuredAt
  await change($, 'startup dashboard state update', state => ({
    ...state,
    now: reconciledAt,
    ...(usage ? { usage } : {}),
    ...(listed ? { agents: reconcileAgents(state.agents, listed, listedAt, reconciledAt) } : {}),
  }))
}

async function refreshClm($: EngineInterface): Promise<void> {
  try {
    const status = await $.clm.status()
    await change($, 'clm status state update', state => ({ ...state, clm: { status } }))
  } catch (error) {
    await log($, 'clm.status', error)
    await change($, 'clm status error state update', state => ({ ...state, clm: { error: errorText(error) } }))
  }
}

async function openDash($: EngineInterface, operation: string): Promise<void> {
  try {
    await $.ui.open({ id: PANE, title: TITLE })
  } catch (error) {
    await log($, operation, error)
  }
}

function startTicker($: EngineInterface, isMainSession: boolean, timer?: Timer): Timer | undefined {
  try {
    timer?.cancel()
    return $.clock.every(REFRESH_MS, () => {
      void (async () => {
        const current = await now($, 'clock.now for elapsed refresh')
        if (current !== undefined) {
          await change($, 'elapsed refresh state update', state => ({ ...state, now: current }))
        }
        await refreshClm($)
        if (isMainSession) await openDash($, 'ui.open dash during refresh')
      })().catch(error => log($, 'elapsed refresh', error))
    })
  } catch (error) {
    void log($, 'clock.every for elapsed refresh', error)
    return undefined
  }
}

function number(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function clip(text: string, columns: number): string {
  const width = Math.max(1, columns)
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
}

function resetTime(iso: string | undefined): string {
  if (!iso) return ''
  const time = iso.match(/T(\d{2}:\d{2})/)?.[1]
  return time ? ` @${time}${iso.endsWith('Z') ? 'Z' : ''}` : ` @${iso.slice(0, 10)}`
}

function kindLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  if (kind === 'spend_limit') return 'spend'
  return kind.slice(0, 8)
}

function typeLabel(type: string): string {
  return type.startsWith('codex-subagent:') ? `codex:${type.slice('codex-subagent:'.length)}` : type
}

function timeLabel(value: number, estimated: boolean): string {
  const clock = new Date(value).toISOString().slice(11, 16)
  return `${estimated ? '~' : ''}${clock}Z`
}

function elapsedLabel(agent: TrackedAgent, current: number): string {
  const elapsed = Math.max(0, (agent.finishedAt ?? current) - agent.startedAt)
  return durationLabel(elapsed)
}

function durationLabel(elapsed: number): string {
  const totalMinutes = Math.floor(elapsed / 60_000)
  return totalMinutes < 60 ? `${totalMinutes}m` : `${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`
}

function usageRows({ Box, Text }: Elements, state: DashDashboardState, width: number) {
  const usage = state.usage
  if (!usage) return <Text dimColor>Usage figures unavailable.</Text>
  return (
    <Box flexDirection="column">
      {usage.rateLimits.length === 0
        ? <Text dimColor>No rate limits</Text>
        : usage.rateLimits.map(limit => <Text key={limit.kind}>{clip(`${kindLabel(limit.kind)} ${number(limit.percentUsed)}%${resetTime(limit.resetsAt)}`, width)}</Text>)}
      {usage.costUsd === undefined ? null : <Text>{clip(`Cost $${usage.costUsd.toFixed(2)}`, width)}</Text>}
    </Box>
  )
}

function fleetRows({ Box, Text }: Elements, state: DashDashboardState, width: number) {
  if (state.agents.length === 0) return <Text dimColor>No subagents yet.</Text>
  return (
    <Box flexDirection="column">
      {state.agents.map(agent => (
        <Box key={agent.id} flexDirection="column">
          <Text>{clip(`id ${agent.id}`, width)}</Text>
          <Text>{clip(`${typeLabel(agent.type)} · ${timeLabel(agent.startedAt, agent.startEstimated)} · ${elapsedLabel(agent, state.now)} · ${agent.status}`, width)}</Text>
          <Text dimColor>{clip(agent.lastMessage || 'No message yet', width)}</Text>
        </Box>
      ))}
    </Box>
  )
}

function clmStatusRows({ Box, Text }: Elements, status: ClmStatus, current: number) {
  return (
    <Box flexDirection="column">
      <Text>Later queue:</Text>
      {status.later.length === 0
        ? <Text dimColor>none</Text>
        : status.later.map((item, index) => <Text key={`later-${index}`}>{`${index + 1}. ${item.text}`}</Text>)}
      <Text>{`Pending resume: ${status.resumeRequest?.text ?? 'none'}`}</Text>
      <Text>{`Last fold: ${status.lastFoldAt === null ? 'never' : `${durationLabel(Math.max(0, current - status.lastFoldAt))} ago`}`}</Text>
      <Text>{`Open issues: ${status.openIssues}`}</Text>
      <Text>{`Ledger: ${status.ledgerPath}`}</Text>
    </Box>
  )
}

function clmRows(elements: Elements, state: DashDashboardState) {
  const { Text } = elements
  if (state.clm === null) return <Text dimColor>Loading clm status…</Text>
  if ('error' in state.clm) return <Text>{`clm is unavailable: ${state.clm.error.replace(/\s+/g, ' ')}`}</Text>
  return clmStatusRows(elements, state.clm.status, state.now)
}

export const register: Register = on => {
  let ticker: Timer | undefined
  let isMainSession = false

  on('session.start', async ($, e, next) => {
    const started = await pass($, 'session.start', () => next(e))
    await initialize($)
    await refreshClm($)
    isMainSession = !('agentId' in e)
    ticker = startTicker($, isMainSession, ticker)
    if (isMainSession) await openDash($, 'ui.open dash at session start')
    return started
  })

  on('ui.close', { id: PANE }, async (_$, e, next) => {
    if (e.origin.kind === 'unload') return next(e)
    return { value: undefined }
  })

  on('session.measure', async ($, e, next) => {
    const result = await pass($, 'session.measure', () => next(e))
    const measuredAt = await now($, 'clock.now after session.measure')
    if (measuredAt !== undefined) {
      await change($, 'session.measure state update', state => ({
        ...state,
        now: measuredAt,
        usage: snapshot({ rateLimits: e.rateLimits, ...(e.cost === undefined ? {} : { cost: e.cost }) }),
      }))
    }
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await pass($, 'agent.spawn', () => next(e))
    const agentId = 'agentId' in spawned ? spawned.agentId : undefined
    if (agentId) {
      const startedAt = await now($, `clock.now for agent ${agentId}`)
      if (startedAt !== undefined) {
        await change($, `track spawned agent ${agentId}`, state => ({
          ...state,
          agents: recordSpawn(state.agents, agentId, e.subagentType, startedAt),
          now: startedAt,
        }))
      }
    }
    return spawned
  })

  on('session.receive', async ($, e, next) => {
    const received = await pass($, 'session.receive', () => next(e))
    const { agentId } = e
    if (agentId) {
      const receivedAt = await now($, `clock.now for message to agent ${agentId}`)
      if (receivedAt !== undefined) {
        await change($, `track message for agent ${agentId}`, state => ({
          ...state,
          agents: recordMessage(state.agents, agentId, e.text, receivedAt),
          now: receivedAt,
        }))
      }
    }
    return received
  })

  on('turn.complete', async ($, e, next) => {
    const completed = await pass($, 'turn.complete', () => next(e))
    const { agentId } = e
    if (agentId) {
      const finishedAt = await now($, `clock.now for completed agent ${agentId}`)
      if (finishedAt !== undefined) {
        await change($, `complete agent ${agentId}`, state => ({
          ...state,
          agents: recordCompletion(state.agents, agentId, e.answer, finishedAt),
          now: finishedAt,
        }))
      }
    }
    return completed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = await pass($, 'ui.resolve for Pane', async () => $.ui.resolve(e))
    const { Box, Text } = elements
    const width = Math.max(8, e.props.bodyColumns - 1)
    const state = await read($, dashboard).catch(
      (error: unknown) => log($, 'read dashboard for ui.render', error).then(() => undefined),
    )
    if (state === undefined) return <Text dimColor>Dash state unavailable. See debug log.</Text>

    return (
      <Box flexDirection="column">
        <Text bold>Usage</Text>
        {usageRows(elements, state, width)}
        <Text bold>Fleet</Text>
        {fleetRows(elements, state, width)}
        <Text bold>Clm</Text>
        {clmRows(elements, state)}
      </Box>
    )
  })
}
