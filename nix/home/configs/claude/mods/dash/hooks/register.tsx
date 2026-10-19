import { atom, read, update } from 'claude-code'
import type {
  DashDashboardState, EngineInterface, Register, SessionUsage, Timer,
} from 'claude-code'
import type { TrackedAgent, UsageSnapshot } from '../types'
import { reconcileAgents, recordCompletion, recordMessage, recordSpawn, taskDescription, withoutStaleDone } from './fleet'
import { behindFromCount, versionLabel } from './version'

type Elements = ReturnType<EngineInterface['ui']['resolve']>
type ClmStatus = Awaited<ReturnType<EngineInterface['clm']['status']>>

const PANE = 'dash'
const TITLE = 'Dash'
const REFRESH_MS = 15_000
const REFRESH_LABEL = 'refresh'
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

function snapshot(usage: Pick<SessionUsage, 'rateLimits'>): UsageSnapshot {
  return {
    rateLimits: usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, ...(resetsAt ? { resetsAt } : {}) })),
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

async function refreshUsage($: EngineInterface): Promise<void> {
  try {
    const usage = snapshot(await $.session.usage())
    await change($, 'usage state update', state => ({ ...state, usage }))
  } catch (error) {
    await log($, 'session.usage during refresh', error)
  }
}

async function dotfilesGit($: EngineInterface, args: string[]): Promise<string | undefined> {
  let home: string | undefined
  try {
    home = await $.env.get('HOME')
    if (!home) throw new Error('HOME is unset')
  } catch (error) {
    await log($, `env.get HOME for git ${args.join(' ')}`, error)
    return undefined
  }
  const argv = ['git', '-C', `${home}/.dotfiles`, ...args]
  try {
    const { exitCode, stdout, stderr } = await $.process.run(argv)
    if (exitCode !== 0) throw new Error(`exit ${exitCode}: ${stderr.trim()}`)
    return stdout
  } catch (error) {
    await log($, argv.join(' '), error)
    return undefined
  }
}

// A hot reload re-runs session.start; keeping the first baseline keeps every commit made before the reload countable.
async function recordBaseline($: EngineInterface): Promise<void> {
  const state = await read($, dashboard).catch(
    (error: unknown) => log($, 'read dashboard for dotfiles baseline', error).then(() => undefined),
  )
  if (state === undefined || state.baseline !== undefined) return
  const baseline = (await dotfilesGit($, ['rev-parse', 'HEAD']))?.trim()
  if (baseline) await change($, 'dotfiles baseline state update', current => ({ ...current, baseline }))
}

async function refreshBehind($: EngineInterface, baseline: string): Promise<void> {
  const stdout = await dotfilesGit($, ['rev-list', '--count', `${baseline}..HEAD`])
  const behind = stdout === undefined ? 'unknown' : behindFromCount(stdout)
  if (behind === 'unknown' && stdout !== undefined) await log($, `git rev-list --count ${baseline}..HEAD`, `unparsable count: ${JSON.stringify(stdout)}`)
  await change($, 'dotfiles behind state update', current => ({ ...current, behind }))
}

async function openDash($: EngineInterface, operation: string): Promise<void> {
  try {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    if (!opened.isPlaced) await log($, operation, `pane not placed: ${opened.reason}`)
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
        await refreshUsage($)
        await refreshClm($)
        if (isMainSession) await openDash($, 'ui.open dash during refresh')
      })().catch(error => log($, 'elapsed refresh', error))
    })
  } catch (error) {
    void log($, 'clock.every for elapsed refresh', error)
    return undefined
  }
}

const RESET_ICON = '\u{F0450}'
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

type Span = [text: string, tone: 'label' | 'value']

function number(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—'
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function clip(text: string, columns: number): string {
  const width = Math.max(1, columns)
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text
}

function clipSpans(spans: Span[], columns: number): Span[] {
  const whole = spans.map(([text]) => text).join('')
  const kept = clip(whole, columns)
  if (kept === whole) return spans
  let left = kept.length - 1
  const clipped: Span[] = []
  for (const [text, tone] of spans) {
    if (left <= 0) break
    clipped.push([text.slice(0, left), tone])
    left -= text.length
  }
  return [...clipped, ['…', 'value']]
}

function spanRow({ Text }: Elements, key: string, spans: Span[], width: number) {
  return (
    <Text key={key}>
      {clipSpans(spans, width).map(([text, tone], index) => (
        <Text key={index} color={tone === 'label' ? 'gray' : 'whiteBright'}>{text}</Text>
      ))}
    </Text>
  )
}

function untilLabel(iso: string | undefined, current: number): string | undefined {
  const at = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(at)) return undefined
  const seconds = Math.floor((at - current) / 1000)
  if (seconds <= 0) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${Math.floor(seconds / 3600)}h${minutes > 0 ? `${minutes}m` : ''}`
}

function resetTime(iso: string | undefined): string | undefined {
  const at = iso ? new Date(iso) : undefined
  if (!at || !Number.isFinite(at.getTime())) return undefined
  return `${WEEKDAYS[at.getDay()]} ${at.getHours()}:${String(at.getMinutes()).padStart(2, '0')}`
}

function kindLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return 'weekly'
  if (kind === 'spend_limit') return 'spend'
  return kind.slice(0, 8)
}

function rateLimitSpans(kind: string, limit: UsageSnapshot['rateLimits'][number] | undefined, current: number): Span[] {
  const label: Span = [`${kindLabel(kind)} `, 'label']
  if (!limit || !Number.isFinite(limit.percentUsed)) return [label, ['unknown', 'value']]
  if (kind !== 'five_hour' && kind !== 'seven_day') return [label, [`${number(limit.percentUsed)}%`, 'value']]
  const [word, reset] = kind === 'five_hour' ? ['in', untilLabel(limit.resetsAt, current)] : ['at', resetTime(limit.resetsAt)]
  return [
    label, [`${Math.round(limit.percentUsed)}%`, 'value'], [` ${RESET_ICON}`, 'label'],
    ...(reset ? [[` ${word} `, 'label'], [reset, 'value']] satisfies Span[] : []),
  ]
}

function statusGlyph(status: string): string {
  if (status === 'running') return '●'
  if (status === 'done' || status === 'completed') return '✓'
  if (status === 'failed' || status === 'error') return '✗'
  return '·'
}

function elapsedLabel(agent: TrackedAgent, current: number): string {
  const elapsed = Math.max(0, (agent.finishedAt ?? current) - agent.startedAt)
  return durationLabel(elapsed)
}

function durationLabel(elapsed: number): string {
  const totalMinutes = Math.floor(elapsed / 60_000)
  return totalMinutes < 60 ? `${totalMinutes}m` : `${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`
}

function usageRows(elements: Elements, state: DashDashboardState, width: number) {
  const { Box, Text } = elements
  const usage = state.usage
  if (!usage) return <Text dimColor>Usage figures unavailable.</Text>
  const limitOf = (kind: string) => usage.rateLimits.find(limit => limit.kind === kind)
  const others = usage.rateLimits.filter(limit => limit.kind !== 'five_hour' && limit.kind !== 'seven_day')
  const windows = ['five_hour', 'seven_day'].flatMap((kind, index): Span[] => {
    const limit = limitOf(kind)
    if (!limit) return []
    return [...(index > 0 && limitOf('five_hour') ? [[' / ', 'label'] satisfies Span] : []), ...rateLimitSpans(kind, limit, state.now)]
  })
  return (
    <Box flexDirection="column">
      {windows.length === 0 ? null : spanRow(elements, 'windows', windows, width)}
      {others.map(limit => spanRow(elements, limit.kind, rateLimitSpans(limit.kind, limit, state.now), width))}
    </Box>
  )
}

function clmHead(state: DashDashboardState): { text: string, dim: boolean, status?: ClmStatus } {
  if (state.clm === null) return { text: '▸ Loading clm status…', dim: true }
  if ('error' in state.clm) return { text: `▸ clm is unavailable: ${state.clm.error.replace(/\s+/g, ' ')}`, dim: false }
  const { status } = state.clm
  const focus = status.focus ? `${status.focus.title}${status.focus.status === 'doing' ? '' : ` (${status.focus.status})`}` : 'no focus'
  const depth = status.focus && status.stackDepth > 1 ? ` · depth ${status.stackDepth}` : ''
  return { text: `▸ ${focus}${depth} · later ${status.later.length} · issues ${status.openIssues}`, dim: false, status }
}

function headRow({ Box, Text, Button }: Elements, state: DashDashboardState, width: number, onRefresh: (baseline: string) => void) {
  const head = clmHead(state)
  const { baseline } = state
  if (baseline === undefined) return <Text dimColor={head.dim}>{clip(head.text, width)}</Text>
  // The version is the reason to look at this row, so the clm head gives way first; the terminal draws a Button as `[ label ]` after one space.
  const version = versionLabel(baseline, state.behind)
  const buttonWidth = REFRESH_LABEL.length + 5
  return (
    <Box flexDirection="row">
      <Text dimColor={head.dim}>{`${clip(head.text, width - buttonWidth - version.length)}${version}`}</Text>
      <Text> </Text>
      <Button key="refresh" label={REFRESH_LABEL} dimColor onPress={() => onRefresh(baseline)} />
    </Box>
  )
}

function workRows(elements: Elements, state: DashDashboardState, width: number, onRefresh: (baseline: string) => void) {
  const { Box, Text } = elements
  const head = clmHead(state)
  const titles = new Map((head.status?.agents ?? []).map(agent => [agent.agentId, agent.title]))
  // Running first, finished last; spawn order within each group.
  const rank = (status: string) => status === 'running' ? 0 : status === 'done' || status === 'completed' ? 2 : 1
  const agents = withoutStaleDone(state.agents, 2).sort((a, b) => rank(a.status) - rank(b.status) || a.startedAt - b.startedAt)
  const known = new Set(state.agents.map(agent => agent.id))
  const orphans = (head.status?.agents ?? []).filter(agent => !known.has(agent.agentId))
  const elapsedWidth = Math.max(0, ...agents.map(agent => elapsedLabel(agent, state.now).length))
  const status = head.status
  return (
    <Box flexDirection="column">
      {headRow(elements, state, width, onRefresh)}
      {status?.pending.length ? <Text>{clip(`  Pending  ${status.pending.map(item => item.title).join(', ')}`, width)}</Text> : null}
      {status?.resumeRequest ? <Text>{clip(`  Resume  ${status.resumeRequest.text}`, width)}</Text> : null}
      {agents.map(agent => (
        <Box key={agent.id} flexDirection="column">
          <Text>{clip(`  ${statusGlyph(agent.status)} ${elapsedLabel(agent, state.now).padEnd(elapsedWidth)}  ${titles.get(agent.id) ?? agent.description ?? agent.status}`, width)}</Text>
          {agent.lastMessage ? <Text dimColor>{clip(`    └ ${agent.lastMessage}`, width)}</Text> : null}
        </Box>
      ))}
      {orphans.map(agent => <Text key={agent.agentId} dimColor>{clip(`  · ${agent.agentId.slice(0, 8)} ${agent.title} (${agent.status})`, width)}</Text>)}
    </Box>
  )
}

export const register: Register = on => {
  let ticker: Timer | undefined
  let isMainSession = false

  on('session.start', async ($, e, next) => {
    const started = await pass($, 'session.start', () => next(e))
    await initialize($)
    await refreshClm($)
    isMainSession = !('agentId' in e)
    if (isMainSession) await recordBaseline($)
    ticker = startTicker($, isMainSession, ticker)
    if (isMainSession) await openDash($, 'ui.open dash at session start')
    return started
  })

  // Opened inside the hook of a prompt the person entered, so the engine counts it as asked and places it at any width.
  on('prompt.submit', async ($, e, next) => {
    if (isMainSession && e.origin.kind === 'composer') await openDash($, 'ui.open dash at prompt submit')
    return next(e)
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
        usage: snapshot({ rateLimits: e.rateLimits }),
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
          agents: recordSpawn(state.agents, agentId, e.subagentType, taskDescription(e), startedAt),
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
        {usageRows(elements, state, width)}
        {workRows(elements, state, width, baseline => {
          void refreshBehind($, baseline).catch(error => log($, 'dotfiles behind refresh', error))
        })}
      </Box>
    )
  })
}
