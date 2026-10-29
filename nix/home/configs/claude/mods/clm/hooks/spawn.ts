import { isRecord } from './tracker'

export type Mux = 'herdr' | 'zellij' | 'tmux' | 'none'
// CLAUDE_CONFIG_DIR matches main's so `$.session.send` and SendMessage between the two sessions find each other.
export type CoworkerEnvironment = { CLM_COWORKER: '1'; CLM_MAIN_SESSION: string; CLM_COWORKER_NAME: string; CLAUDE_CONFIG_DIR?: string }
export type ProcessResult = { exitCode: number; stdout: string; stderr: string }
export type SpawnIo = {
  run: (argv: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<ProcessResult>
  read: (path: string) => Promise<string | undefined>
}
export type LaunchStep = {
  argv?: readonly string[]
  argvFromPrevious?: (stdout: string) => readonly string[]
}
export type LaunchPlan = { steps: readonly LaunchStep[] } | { manual: string }

export function detectMux(env: Record<string, string | undefined>): Mux {
  if (env.HERDR_SOCKET_PATH || env.HERDR_ENV) return 'herdr'
  if (env.ZELLIJ) return 'zellij'
  if (env.TMUX) return 'tmux'
  return 'none'
}

const environmentArgs = (env: CoworkerEnvironment) => Object.entries(env).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${value}`)
const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

export function parseHerdrPaneId(stdout: string): string {
  const value: unknown = (() => {
    try { return JSON.parse(stdout) }
    catch { throw new Error('Herdr tab creation did not return JSON') }
  })()
  if (!isRecord(value)) throw new Error('Herdr tab creation returned an invalid response')
  const result = isRecord(value.result) ? value.result : value
  const rootPane = result.root_pane
  const paneId = isRecord(rootPane) ? rootPane.pane_id : undefined
  if (typeof paneId !== 'string' || !paneId) throw new Error('Herdr tab creation response has no root_pane.pane_id')
  return paneId
}

export function launchPlan(input: { mux: Mux; cwd: string; name: string; env: CoworkerEnvironment; brief: string; herdrWorkspaceId?: string }): LaunchPlan {
  const envArgs = environmentArgs(input.env)
  if (input.mux === 'herdr') return { steps: [
    { argv: ['herdr', 'tab', 'create', ...(input.herdrWorkspaceId ? ['--workspace', input.herdrWorkspaceId] : []), '--cwd', input.cwd, '--label', input.name, ...envArgs.flatMap(value => ['--env', value]), '--no-focus'] },
    { argvFromPrevious: stdout => ['herdr', 'agent', 'start', input.name, '--kind', 'claude', '--pane', parseHerdrPaneId(stdout), '--', input.brief] },
  ] }
  if (input.mux === 'zellij') return { steps: [
    { argv: ['zellij', 'run', '--name', input.name, '--cwd', input.cwd, '--no-focus', '--', 'env', ...envArgs, 'claude', input.brief] },
  ] }
  if (input.mux === 'tmux') return { steps: [
    { argv: ['tmux', 'new-window', '-d', '-c', input.cwd, ...envArgs.flatMap(value => ['-e', value]), '-n', input.name, 'claude', input.brief] },
  ] }
  return { manual: `sh -c 'cd "$1" && shift && exec "$@"' sh ${shellQuote(input.cwd)} env ${envArgs.map(shellQuote).join(' ')} claude ${shellQuote(input.brief)}` }
}

export function parseDarwinLoad(stdout: string): number {
  const match = stdout.match(/\{?\s*([0-9]+(?:\.[0-9]+)?)/)
  const value = match ? Number(match[1]) : Number.NaN
  if (!Number.isFinite(value)) throw new Error(`invalid Darwin load average: ${JSON.stringify(stdout)}`)
  return value
}

export function parseLinuxLoad(contents: string): number {
  const value = Number(contents.trim().split(/\s+/)[0])
  if (!Number.isFinite(value)) throw new Error(`invalid Linux load average: ${JSON.stringify(contents)}`)
  return value
}

export function parseCoreCount(stdout: string): number {
  const value = Number(stdout.trim())
  if (!Number.isInteger(value) || value < 1) throw new Error(`invalid CPU core count: ${JSON.stringify(stdout)}`)
  return value
}

const checked = async (io: SpawnIo, argv: readonly string[]) => {
  const result = await io.run(argv, { timeoutMs: 1_000 })
  if (result.exitCode !== 0) throw new Error(`${argv.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout
}

export async function readLoad(io: SpawnIo): Promise<{ load1: number; cores: number }> {
  const load = await io.read('/proc/loadavg')
  return load !== undefined
    ? { load1: parseLinuxLoad(load), cores: parseCoreCount(await checked(io, ['nproc'])) }
    : { load1: parseDarwinLoad(await checked(io, ['sysctl', '-n', 'vm.loadavg'])), cores: parseCoreCount(await checked(io, ['sysctl', '-n', 'hw.ncpu'])) }
}

export function coworkerBrief(input: { main: string; repo: string }): string {
  return `You are a clm co-worker for main session ${input.main} in ${input.repo}. Call the clm_coworker tool with action claim, work only inside the returned worktree, checkpoint your completed work, then call clm_coworker with action ready; clm tells the main session. To discuss the work, reply with SendMessage to the sender of a main-session message.`
}
