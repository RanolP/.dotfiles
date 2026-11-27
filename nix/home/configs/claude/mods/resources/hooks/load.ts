import type { OwnedResource, ResourceIo } from './resources'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const readJson = async (io: ResourceIo, path: string): Promise<unknown> => {
  try { return JSON.parse(await io.read(path) ?? 'null') } catch { return undefined }
}
const run = async (io: ResourceIo, argv: string[]) => {
  try {
    const result = await io.run(argv, { timeoutMs: 1000 })
    if (result.exitCode === 0) return result.stdout.trim()
    io.log(`resources: ${JSON.stringify(argv)} failed: ${result.stderr}`)
  } catch (err) { io.log(`resources: ${JSON.stringify(argv)} failed: ${String(err)}`) }
  return undefined
}
export const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const startedBy = (agentId: unknown) => typeof agentId === 'string' && agentId ? `worker ${agentId}` : 'main'
// `ps -axwwE -o pid=,command=` prints each process's environment after its command line.
export const envAgentIds = (output: string) => {
  const ids = new Map<number, string>()
  for (const line of output.split('\n')) {
    const m = line.trim().match(/^(\d+)\s.*?\sCLAUDE_AGENT_ID=([A-Za-z0-9_-]+)(?:\s|$)/)
    if (m) ids.set(Number(m[1]), m[2] ?? '')
  }
  return ids
}
export const deliveredPath = (home: string, session: string) => /^[A-Za-z0-9_-]{1,128}$/.test(session) ? `${home}/.cache/claude-resource-watchdog/delivered/${session}.json` : undefined
export const ownerNotices = (entries: unknown, session: string, delivered: Set<string>) => {
  const notes: string[] = []
  const keys: string[] = []
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!record(e) || !session || e.session_id !== session || !e.id) continue
    const cmd = String(e.command).slice(0, 120)
    const stop = `${e.id}:stop`
    const resume = `${e.id}:resume`
    if (!delivered.has(stop)) {
      keys.push(stop)
      notes.push(`resource-watchdog stopped (SIGSTOP) pid ${e.pid} (${e.rss_mb} MB, ${cmd}), started from this session by ${startedBy(e.agent_id)}, at ${e.stopped_at} because memory pressure was ${e.pressure_name} (level ${e.pressure}). Resume: ${e.resume_policy}. To free the memory sooner, kill it yourself (\`kill -9 ${e.pid}\`) and rerun it smaller; tell the user what you did.`)
    }
    if (e.resumed_at && !delivered.has(resume)) {
      keys.push(resume)
      const how = e.resumed_by === 'watchdog' ? 'resource-watchdog resumed (SIGCONT)' : e.resumed_by === 'exited' ? 'resource-watchdog found exited' : e.resumed_by === 'other' ? 'resource-watchdog found running again (resumed outside the watchdog)' : 'resource-watchdog closed'
      notes.push(`${how} pid ${e.pid} (${cmd}) at ${e.resumed_at}.`)
    }
  }
  return { notes, keys }
}
export const loadReading = async (io: ResourceIo) => {
  const macLoad = await run(io, ['/usr/sbin/sysctl', '-n', 'vm.loadavg'])
  const rawLoad = macLoad ?? await io.read('/proc/loadavg')
  const one = Number(rawLoad?.replace(/[{}]/g, '').trim().split(/\s+/)[0])
  const rawCores = await run(io, ['/usr/sbin/sysctl', '-n', 'hw.ncpu']) ?? await run(io, ['nproc'])
  const cores = Math.max(1, Number(rawCores) || 1)
  return { one: Number.isFinite(one) ? one : 0, cores }
}
export const loadLine = async (io: ResourceIo) => {
  const { one, cores } = await loadReading(io)
  return `load ${one.toFixed(1)}/${cores} cores (${one / cores >= 0.8 ? 'high' : 'normal'})`
}
export const pressureNotes = (level: number, one: number, cores: number, owned: OwnedResource[]) => {
  const notes: string[] = []
  if (level !== 1) notes.push(`memory pressure level ${level} (1 is normal).`)
  if (one > cores) notes.push(`load ${one.toFixed(1)} > ${cores} cores.`)
  if (!notes.length) return notes
  const candidates = owned.filter(r => ['process', 'android-emulator', 'ios-simulator', 'metro', 'web-dev'].includes(r.kind)).sort((a, b) => (b.rss ?? 0) - (a.rss ?? 0))
  notes.push(candidates.length
    ? `${candidates.map(r => r.pid === undefined ? `${r.kind} ${r.label}` : `pid ${r.pid} ${Math.round((r.rss ?? 0) / 1024)} MB ${r.label.slice(0, 80)} (started by ${startedBy(r.agentId)})`).join('\n')}\nstop the ones you no longer need and hold off on new heavy jobs until this clears; tell the user what you stopped.`
    : 'Check the processes you started (`ps -o pid,rss,stat,command -U $USER`), stop the heavy ones that are yours, and hold off on new heavy jobs until this clears; tell the user what you stopped.')
  return notes
}
export const loadNotices = async (io: ResourceIo, pid: number | undefined, owned: OwnedResource[]) => {
  if (pid !== undefined) {
    const nice = await run(io, ['/bin/ps', '-p', String(pid), '-o', 'nice='])
    // renice -n is an increment on macOS, so set the absolute value, and only when it must rise (non-root cannot lower it back).
    if (nice !== undefined && Number(nice) < 15) await run(io, ['renice', '15', '-p', String(pid)])
  }
  const home = await io.home()
  const session = await io.sessionId()
  const path = home ? deliveredPath(home, session) : undefined
  const notes: string[] = []
  if (path) {
    const raw = await readJson(io, path)
    const delivered = new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [])
    const notices = ownerNotices(await readJson(io, `${home}/.cache/claude-resource-watchdog/stopped.json`), session, delivered)
    notes.push(...notices.notes)
    if (notices.keys.length) {
      try {
        await run(io, ['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))])
        await io.write(`${path}.tmp`, JSON.stringify([...new Set([...delivered, ...notices.keys])].sort()))
        await run(io, ['mv', `${path}.tmp`, path])
      } catch (err) { io.log(`resources: notice delivery tracking failed: ${String(err)}`) }
    }
  }
  const level = Number(await run(io, ['/usr/sbin/sysctl', '-n', 'kern.memorystatus_vm_pressure_level'])) || 1
  const { one, cores } = await loadReading(io)
  return [...notes, ...pressureNotes(level, one, cores, owned)]
}

type ProcessRow = { pid: number; ppid: number; rss: number; stat: string; command: string }
const executable = (command: string) => command.split(/\s+/)[0]?.split('/').at(-1) ?? ''
const agent = (command: string) => ['claude', 'codex', 'agy'].includes(executable(command))
const shell = (command: string) => ['bash', 'zsh', 'sh', 'dash', 'fish'].includes(executable(command).replace(/^-/, ''))
export const processRows = (output: string) => {
  const rows = new Map<number, ProcessRow>()
  for (const line of output.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    if (m) rows.set(Number(m[1]), { pid: Number(m[1]), ppid: Number(m[2]), rss: Number(m[3]), stat: m[4] ?? '', command: m[5] ?? '' })
  }
  return rows
}
export const shellJobs = (output: string, root: number): ProcessRow[] => {
  const rows = processRows(output)
  return [...rows.values()].filter(row => {
    if (agent(row.command) || shell(row.command) || row.stat.startsWith('Z')) return false
    const seen = new Set<number>()
    const walk = (pid: number, hasShell: boolean): boolean => {
      if (seen.has(pid)) return false
      seen.add(pid)
      const parent = rows.get(rows.get(pid)?.ppid ?? 0)
      if (!parent) return false
      if (agent(parent.command)) return parent.pid === root && hasShell
      return walk(parent.pid, hasShell || shell(parent.command))
    }
    return walk(row.pid, false)
  })
}
