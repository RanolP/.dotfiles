import type { EngineInterface, Register } from 'claude-code'
import type { ClmResourceInput } from '../types'

export const RESOURCE_TOOL = 'mcp__clm__clm_resource'
export const RESOURCE_DESCRIPTION = 'Track resources this session owns and shared exclusive resources. Call `register` with kind `mutex` when a device or service may be used by only one session at a time; call `who` before using one; call `release` the moment you finish with it. Bash commands that start an emulator, simulator, Metro, a web dev server, or a PR are recorded automatically; `register` with kind `owned` covers anything they miss.'
const HEARTBEAT_TTL_MS = 60 * 60 * 1000
const RESOURCE_STATE = '.local/state/clm/resources'

export type OwnedKind = 'android-emulator' | 'ios-simulator' | 'metro' | 'web-dev' | 'pr' | 'custom'
export type OwnedResource = {
  kind: OwnedKind
  id: string
  label: string
  profile: string
  cwd: string
  startedAt: string
  backgroundTaskId?: string
}
export type MutexRecord = { name: string; aliases: string[]; description: string; registeredBy: string }
export type MutexOwner = { session: string; profile: string; pid?: number; processCommand?: string; cwd: string; repo: string; since: string; heartbeat: number }
export type ResourceIdentity = { processPid?: number; pid?: number; processCommand?: string; profile: string; cwd: string; repo: string; heartbeat: number }
type StoredIdentity = Pick<ResourceIdentity, 'cwd' | 'repo' | 'heartbeat' | 'pid' | 'processCommand'>
export type ResourceSession = {
  profile: string
  owned: OwnedResource[]
  mutexes: string[]
  changes: string[]
  transferredFrom?: string[]
  notice?: string
  pendingTransfer?: boolean
  identity?: StoredIdentity
}
export type ProcessResult = { exitCode: number; stdout: string; stderr: string }
export type ResourceIo = {
  sessionId: () => Promise<string>
  home: () => Promise<string | undefined>
  configDir: () => Promise<string | undefined>
  cwd: () => Promise<string>
  repo: () => Promise<string>
  now: () => Promise<number>
  exists: (path: string) => Promise<boolean>
  list: (path: string) => Promise<{ name: string; kind: string; mtimeMs?: number; isLink?: boolean }[]>
  read: (path: string) => Promise<string | undefined>
  write: (path: string, value: string) => Promise<void>
  run: (argv: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<ProcessResult>
  log: (text: string) => void
  budgetRemaining?: () => number
}

const queues = new Map<string, Promise<void>>()
const processIdentities = new Map<string, ResourceIdentity>()
const ownedDirCreations = new Map<string, Promise<void>>()
const resourceTouches = new Map<string, number>()
const pendingNoticesShown = new Set<string>()
let activeResourceIo: ResourceIo | undefined
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isOwnedResource = (value: unknown): value is OwnedResource => isRecord(value)
  && typeof value.kind === 'string' && ['android-emulator', 'ios-simulator', 'metro', 'web-dev', 'pr', 'custom'].includes(value.kind)
  && typeof value.id === 'string' && typeof value.label === 'string' && typeof value.profile === 'string' && typeof value.cwd === 'string' && typeof value.startedAt === 'string'
  && (value.backgroundTaskId === undefined || typeof value.backgroundTaskId === 'string')
const isIdentity = (value: unknown): value is StoredIdentity => isRecord(value)
  && typeof value.cwd === 'string' && typeof value.repo === 'string' && typeof value.heartbeat === 'number'
  && (value.pid === undefined || typeof value.pid === 'number') && (value.processCommand === undefined || typeof value.processCommand === 'string')
export const isMutexRecord = (value: unknown): value is MutexRecord => isRecord(value)
  && typeof value.name === 'string' && Array.isArray(value.aliases) && value.aliases.every(alias => typeof alias === 'string')
  && typeof value.description === 'string' && typeof value.registeredBy === 'string'
export const isMutexOwner = (value: unknown): value is MutexOwner => isRecord(value)
  && typeof value.session === 'string' && typeof value.profile === 'string' && (value.pid === undefined || typeof value.pid === 'number')
  && (value.processCommand === undefined || typeof value.processCommand === 'string')
  && typeof value.cwd === 'string' && typeof value.repo === 'string' && typeof value.since === 'string' && typeof value.heartbeat === 'number'
export const asSession = (value: unknown, profile = 'default'): ResourceSession => {
  if (!isRecord(value)) return { profile, owned: [], mutexes: [], changes: [] }
  return {
    profile: typeof value.profile === 'string' ? value.profile : profile,
    owned: Array.isArray(value.owned) ? value.owned.filter(isOwnedResource) : [],
    mutexes: Array.isArray(value.mutexes) ? value.mutexes.filter((name): name is string => typeof name === 'string') : [],
    changes: Array.isArray(value.changes) ? value.changes.filter((change): change is string => typeof change === 'string') : [],
    ...(Array.isArray(value.transferredFrom) ? { transferredFrom: value.transferredFrom.filter((session): session is string => typeof session === 'string') } : {}),
    ...(typeof value.notice === 'string' ? { notice: value.notice } : {}),
    ...(value.pendingTransfer === true ? { pendingTransfer: true } : {}),
    ...(isIdentity(value.identity) ? { identity: value.identity } : {}),
  }
}
export const resourceKey = (root: string, session: string) => `${root.replace(/\/$/, '')}/owned/${session}.json`
export const profileName = (configDir: string | undefined): string => {
  if (!configDir) return 'default'
  const basename = configDir.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? ''
  if (basename === '.claude') return 'default'
  return basename.replace(/^\.claude-/, '') || 'default'
}
const iso = (ms: number) => new Date(ms).toISOString()
const normalized = (value: string) => value.trim().toLocaleLowerCase()
export const resourceLedgerLines = (value: unknown): string[] => {
  const state = asSession(value)
  return [
    ...state.owned.map(resource => `- ${resource.kind} ${resource.label}${normalized(resource.label.replace(/^:/, '')) === normalized(resource.id) ? '' : ` (${resource.id})`}`),
    ...state.mutexes.map(name => `- mutex ${name} held`),
  ]
}
const mutexSlug = (name: string) => {
  const value = normalized(name)
  let hash = 2166136261
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  const base = value.normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'resource'
  return `${base}-${(hash >>> 0).toString(16)}`
}
const resourcesRoot = async (io: ResourceIo) => {
  const home = await io.home()
  if (!home) throw new Error('HOME is unset; resource records need a shared host directory')
  return `${home.replace(/\/$/, '')}/${RESOURCE_STATE}`
}
const ownedDir = async (io: ResourceIo) => `${await resourcesRoot(io)}/owned`
const keyFor = async (io: ResourceIo, session: string) => resourceKey(await resourcesRoot(io), session)
const mutexRoot = async (io: ResourceIo) => `${await resourcesRoot(io)}/mutex`
const mutexPath = async (io: ResourceIo, name: string) => `${await mutexRoot(io)}/${mutexSlug(name)}`
const ownerPath = (path: string) => `${path}/owner`
const ownerFile = (path: string) => `${path}/owner/owner.json`
const resourceFile = (path: string) => `${path}/resource.json`
const now = (io: ResourceIo) => io.now()
const profileFor = async (io: ResourceIo) => {
  try { return profileName(await io.configDir()) }
  catch { return 'default' }
}
const hasResourceHome = async (io: ResourceIo) => {
  try { return Boolean(await io.home()) }
  catch { return false }
}

const serialized = async <T>(session: string, body: () => Promise<T>): Promise<T> => {
  const previous = queues.get(session) ?? Promise.resolve()
  const gate = Promise.withResolvers<void>()
  const tail = previous.then(() => gate.promise)
  queues.set(session, tail)
  await previous
  try { return await body() }
  finally {
    gate.resolve()
    if (queues.get(session) === tail) queues.delete(session)
  }
}

const logRunFailure = (io: ResourceIo, argv: readonly string[], exitCode: number | string, stderr: string) => {
  io.log(`clm resources: process.run failed command=${JSON.stringify(argv)} exitCode=${exitCode} stderr=${JSON.stringify(stderr)}`)
}

const run = async (io: ResourceIo, argv: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<ProcessResult | undefined> => {
  const remaining = io.budgetRemaining?.()
  if (remaining !== undefined && Number.isFinite(remaining) && remaining < 80) {
    logRunFailure(io, argv, 'budget-exhausted', 'process.run skipped before the session.end budget expired')
    return undefined
  }
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5000, remaining === undefined || !Number.isFinite(remaining) ? Infinity : remaining - 50))
  try {
    const result = await io.run(argv, { ...options, timeoutMs })
    if (result.exitCode !== 0) logRunFailure(io, argv, result.exitCode, result.stderr)
    return result
  } catch (err) {
    logRunFailure(io, argv, 'unavailable', String(err))
    return undefined
  }
}

const readJson = async <T>(io: ResourceIo, path: string, guard: (value: unknown) => value is T): Promise<T | undefined> => {
  try {
    const text = await io.read(path)
    if (!text) return undefined
    const value: unknown = JSON.parse(text)
    return guard(value) ? value : undefined
  } catch { return undefined }
}

const ensureOwnedDirectory = async (io: ResourceIo) => {
  const dir = await ownedDir(io)
  const existing = ownedDirCreations.get(dir)
  if (existing) {
    await existing
    if (await io.exists(dir)) return
    ownedDirCreations.delete(dir)
  }
  const creation = (async () => {
    const made = await run(io, ['mkdir', '-p', dir], { timeoutMs: 1000 })
    if (made?.exitCode !== 0) throw new Error(`could not create owned resource directory ${dir}`)
  })()
  ownedDirCreations.set(dir, creation)
  try { await creation }
  catch (err) { if (ownedDirCreations.get(dir) === creation) ownedDirCreations.delete(dir); throw err }
}

const writeSession = async (io: ResourceIo, session: string, value: ResourceSession) => {
  const profile = await profileFor(io)
  const owned = value.owned.map(resource => ({ ...resource, profile }))
  await ensureOwnedDirectory(io)
  const identity = value.identity && { cwd: value.identity.cwd, repo: value.identity.repo, heartbeat: value.identity.heartbeat, ...(value.identity.pid !== undefined ? { pid: value.identity.pid } : {}), ...(value.identity.processCommand ? { processCommand: value.identity.processCommand } : {}) }
  await io.write(await keyFor(io, session), JSON.stringify({ ...value, profile, owned, ...(identity ? { identity } : {}) }))
}

const readSession = async (io: ResourceIo, session: string): Promise<ResourceSession> => {
  const profile = await profileFor(io)
  return asSession(await readJson(io, await keyFor(io, session), isRecord), profile)
}

const listOwnedRecords = async (io: ResourceIo): Promise<{ session: string; path: string; state: ResourceSession }[]> => {
  const dir = await ownedDir(io)
  if (!(await io.exists(dir))) return []
  const entries = await io.list(dir)
  const records: { session: string; path: string; state: ResourceSession }[] = []
  for (const entry of entries.filter(item => item.kind === 'file' && !item.isLink && item.name.endsWith('.json'))) {
    const session = entry.name.slice(0, -5)
    const path = `${dir}/${entry.name}`
    const state = asSession(await readJson(io, path, isRecord), await profileFor(io))
    records.push({ session, path, state })
  }
  return records
}

const mutateSession = async <T>(io: ResourceIo, session: string, change: (current: ResourceSession) => { next: ResourceSession; result: T } | Promise<{ next: ResourceSession; result: T }>): Promise<T> => {
  return serialized(`${await profileFor(io)}/${session}`, async () => {
    const current = await readSession(io, session)
    const outcome = await change(current)
    await writeSession(io, session, outcome.next)
    return outcome.result
  })
}

const confirmedClaudePid = async (io: ResourceIo, cwd: string): Promise<{ candidate?: number; pid?: number; processCommand?: string }> => {
  const parent = await run(io, ['sh', '-c', 'echo $PPID'], { cwd, timeoutMs: 1000 })
  const parsedPid = parent?.exitCode === 0 ? Number(parent.stdout.trim()) : NaN
  const candidate = Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : undefined
  if (!candidate) return {}
  const ps = await run(io, ['/bin/ps', '-p', String(candidate), '-o', 'command='], { cwd, timeoutMs: 1000 })
  const processCommand = ps?.exitCode === 0 ? ps.stdout.trim() : undefined
  return { candidate, ...(processCommand && /(?:^|[\/\s])claude(?:-code)?(?:\s|$)/i.test(processCommand) ? { pid: candidate, processCommand } : {}) }
}

const runtimeIdentity = async (io: ResourceIo): Promise<ResourceIdentity> => {
  const [cwd, repo, heartbeat, profile] = await Promise.all([io.cwd(), io.repo(), now(io), profileFor(io)])
  const { candidate, pid, processCommand } = await confirmedClaudePid(io, cwd)
  return {
    ...(candidate ? { processPid: candidate } : {}), ...(pid ? { pid, processCommand } : {}), profile, cwd, repo, heartbeat,
  }
}

const identityFor = async (io: ResourceIo, session: string): Promise<ResourceIdentity> => {
  const key = `${await profileFor(io)}/${session}`
  const existing = processIdentities.get(key)
  if (existing) return existing
  const identity = await runtimeIdentity(io)
  processIdentities.set(key, identity)
  return identity
}

const listMutexRecords = async (io: ResourceIo): Promise<{ record: MutexRecord; path: string }[]> => {
  const root = await mutexRoot(io)
  try {
    if (!(await io.exists(root))) return []
    const entries = await io.list(root)
    const out: { record: MutexRecord; path: string }[] = []
    for (const entry of entries.filter(item => item.kind === 'dir')) {
      const path = `${root}/${entry.name}`
      const record = await readJson(io, resourceFile(path), isMutexRecord)
      if (record) out.push({ record, path })
    }
    return out
  } catch (err) {
    io.log(`clm resources: could not list mutexes at ${root}: ${String(err).slice(0, 160)}`)
    throw err
  }
}

const ownerFor = async (io: ResourceIo, path: string) => {
  return readJson(io, ownerFile(path), isMutexOwner)
}

const processAlive = async (io: ResourceIo, pid: number, cwd: string, expectedCommand?: string): Promise<boolean | undefined> => {
  const alive = await run(io, ['/bin/kill', '-0', String(pid)], { cwd, timeoutMs: 1000 })
  if (!alive) return undefined
  if (alive.exitCode !== 0) return false
  const command = await run(io, ['/bin/ps', '-p', String(pid), '-o', 'command='], { cwd, timeoutMs: 1000 })
  if (!command) return undefined
  const actual = command.stdout.trim()
  return command.exitCode === 0 && /(?:^|[\/\s])claude(?:-code)?(?:\s|$)/i.test(actual) && (!expectedCommand || actual === expectedCommand)
}

const heartbeatAlive = async (io: ResourceIo, heartbeat: number): Promise<boolean> => {
  return heartbeat > 0 && (await now(io)) - heartbeat < HEARTBEAT_TTL_MS
}

const ownerAlive = async (io: ResourceIo, owner: MutexOwner): Promise<boolean> => {
  if (owner.pid !== undefined) {
    const alive = await processAlive(io, owner.pid, owner.cwd, owner.processCommand)
    if (alive !== undefined) return alive
  }
  return heartbeatAlive(io, owner.heartbeat)
}

const lockMtime = async (io: ResourceIo, path: string, name: string) => (await io.list(path)).find(entry => entry.name === name && entry.kind === 'dir')?.mtimeMs
const lockIsOccupied = async (io: ResourceIo, path: string) => io.exists(ownerPath(path))
const lockIsStale = async (io: ResourceIo, path: string, name: string) => {
  const mtime = await lockMtime(io, path, name)
  return mtime !== undefined && (await now(io)) - mtime > 30_000 ? mtime : undefined
}

const takeReclaimLock = async (io: ResourceIo, path: string, cwd: string): Promise<boolean> => {
  const reclaimPath = `${path}/reclaim`
  const created = await run(io, ['mkdir', reclaimPath], { cwd, timeoutMs: 1000 })
  if (created?.exitCode === 0) return true
  const observed = await lockIsStale(io, path, 'reclaim')
  if (observed === undefined) return false
  const maintenance = `${path}/reclaim-maintenance`
  const held = await run(io, ['mkdir', maintenance], { cwd, timeoutMs: 1000 })
  if (held?.exitCode !== 0) return false
  try {
    if (await lockIsStale(io, path, 'reclaim') !== observed) return false
    const stamp = `${(await now(io)).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const stale = `${path}/reclaim-stale-${stamp}`
    const moved = await run(io, ['mv', reclaimPath, stale], { cwd, timeoutMs: 1000 })
    if (moved?.exitCode !== 0) return false
  const removed = await run(io, ['rm', '-rf', stale], { cwd, timeoutMs: 1000 })
  if (removed?.exitCode !== 0) return false
  return (await run(io, ['mkdir', reclaimPath], { cwd, timeoutMs: 1000 }))?.exitCode === 0
  } finally {
    await run(io, ['rmdir', maintenance], { cwd, timeoutMs: 1000 })
  }
}

const reclaimUnreadableOwner = async (io: ResourceIo, path: string, cwd: string): Promise<boolean> => {
  const observed = await lockIsStale(io, path, 'owner')
  if (observed === undefined) return false
  if (!(await takeReclaimLock(io, path, cwd))) return false
  const reclaimPath = `${path}/reclaim`
  try {
    if (await ownerFor(io, path) || await lockIsStale(io, path, 'owner') !== observed) return false
    const stamp = `${(await now(io)).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const stale = `${path}/owner-stale-${stamp}`
    const moved = await run(io, ['mv', ownerPath(path), stale], { cwd, timeoutMs: 1000 })
    if (moved?.exitCode !== 0) return false
    return (await run(io, ['rm', '-rf', stale], { cwd, timeoutMs: 1000 }))?.exitCode === 0
  } finally {
    await run(io, ['rmdir', reclaimPath], { cwd, timeoutMs: 1000 })
  }
}

const reclaimDeadOwner = async (io: ResourceIo, record: MutexRecord, path: string, owner: MutexOwner): Promise<boolean> => {
  if (await ownerAlive(io, owner)) return false
  const reclaimPath = `${path}/reclaim`
  if (!(await takeReclaimLock(io, path, owner.cwd))) return false
  const stamp = `${(await now(io)).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const stale = `${path}/owner-stale-${stamp}`
  try {
    const current = await ownerFor(io, path)
    if (!current || current.session !== owner.session || current.profile !== owner.profile || current.since !== owner.since || await ownerAlive(io, current)) return false
    const moved = await run(io, ['mv', ownerPath(path), stale], { cwd: owner.cwd, timeoutMs: 1000 })
    if (moved?.exitCode !== 0) return false
    const removed = await run(io, ['rm', '-rf', stale], { cwd: owner.cwd, timeoutMs: 1000 })
    if (removed?.exitCode !== 0) return false
    io.log(`clm resources: reclaimed ${record.name} from dead session ${owner.session}`)
    return true
  } finally {
    await run(io, ['rmdir', reclaimPath], { cwd: owner.cwd, timeoutMs: 1000 })
  }
}

const liveOwner = async (io: ResourceIo, record: MutexRecord, path: string): Promise<MutexOwner | undefined> => {
  const owner = await ownerFor(io, path)
  if (owner) {
    if (await ownerAlive(io, owner)) return owner
    await reclaimDeadOwner(io, record, path, owner)
    return ownerFor(io, path)
  }
  const cwd = (await identityFor(io, await io.sessionId())).cwd
  if (await lockIsOccupied(io, path)) await reclaimUnreadableOwner(io, path, cwd)
  return ownerFor(io, path)
}


const findMutex = async (io: ResourceIo, name: string) => {
  const target = normalized(name)
  return (await listMutexRecords(io)).find(({ record }) => [record.name, ...record.aliases].some(alias => normalized(alias) === target))
}

const denial = (owner: MutexOwner) => {
  return `clm_resource: held by ${owner.profile}/${owner.session} (${owner.cwd}, since ${owner.since}; repo ${owner.repo}).`
}
const ownerLabel = (owner: MutexOwner) => `${owner.profile}/${owner.session} (${owner.cwd}, since ${owner.since})`

const addMutexToSession = async (io: ResourceIo, session: string, record: MutexRecord, changed: boolean) => {
  await mutateSession(io, session, current => {
    const mutexes = current.mutexes.includes(record.name) ? current.mutexes : [...current.mutexes, record.name]
    return { next: { ...current, mutexes, changes: changed ? [...current.changes, `mutex ${record.name} held`] : current.changes }, result: undefined }
  })
}

const removeMutexFromSession = async (io: ResourceIo, session: string, record: MutexRecord, changed: boolean) => {
  await mutateSession(io, session, current => ({
    next: { ...current, mutexes: current.mutexes.filter(name => normalized(name) !== normalized(record.name)), changes: changed ? [...current.changes, `mutex ${record.name} released`] : current.changes },
    result: undefined,
  }))
}

const claimOne = async (io: ResourceIo, session: string, record: MutexRecord, path: string): Promise<{ status: 'claimed' | 'held' | 'denied'; owner?: MutexOwner }> => {
  const identity = await identityFor(io, session)
  const currentTime = await now(io)
  const owner: MutexOwner = {
    session, profile: identity.profile,
    ...(identity.pid !== undefined ? { pid: identity.pid, processCommand: identity.processCommand } : {}),
    cwd: identity.cwd, repo: identity.repo, since: iso(currentTime), heartbeat: currentTime,
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const created = await run(io, ['mkdir', ownerPath(path)], { cwd: identity.cwd, timeoutMs: 1000 })
    if (created?.exitCode === 0) {
      try {
        await io.write(ownerFile(path), JSON.stringify(owner))
      } catch (err) {
        io.log(`clm resources: could not write owner for ${record.name}: ${String(err).slice(0, 160)}`)
        await run(io, ['rm', '-rf', ownerPath(path)], { cwd: identity.cwd, timeoutMs: 1000 })
        return { status: 'denied' }
      }
      await addMutexToSession(io, session, record, true)
      return { status: 'claimed', owner }
    }
    const previous = await ownerFor(io, path)
    if (!previous) {
      if (await reclaimUnreadableOwner(io, path, identity.cwd)) continue
      return { status: 'denied' }
    }
    if (previous.session === session && previous.profile === identity.profile) {
      await io.write(ownerFile(path), JSON.stringify({ ...previous, pid: owner.pid, processCommand: owner.processCommand, cwd: owner.cwd, repo: owner.repo, heartbeat: currentTime }))
      await addMutexToSession(io, session, record, false)
      return { status: 'held', owner: previous }
    }
    if (await ownerAlive(io, previous)) return { status: 'denied', owner: previous }
    if (!(await reclaimDeadOwner(io, record, path, previous))) continue
  }
  const current = await ownerFor(io, path)
  return { status: 'denied', ...(current ? { owner: current } : {}) }
}

const releaseOne = async (io: ResourceIo, session: string, record: MutexRecord, path: string, changed: boolean): Promise<boolean> => {
  const profile = await profileFor(io)
  const owner = await ownerFor(io, path)
  if (!owner) {
    await removeMutexFromSession(io, session, record, changed)
    return true
  }
  if (owner.session !== session || owner.profile !== profile) return false
  const removed = await run(io, ['rm', '-rf', ownerPath(path)], { cwd: owner.cwd, timeoutMs: 1000 })
  if (removed?.exitCode !== 0) return false
  await removeMutexFromSession(io, session, record, changed)
  return true
}

const ensureSessionIdentity = async (io: ResourceIo, session: string, promote: boolean): Promise<ResourceSession> => {
  const identity = await identityFor(io, session)
  const currentTime = await now(io)
  const currentCwd = await io.cwd()
  const currentRepo = await io.repo()
  const nextIdentity = { ...identity, cwd: currentCwd, repo: currentRepo, heartbeat: currentTime }
  processIdentities.set(`${identity.profile}/${session}`, nextIdentity)
  const state = await mutateSession(io, session, current => {
    const notice = promote && current.changes.length
      ? current.notice ? `${current.notice}; ${current.changes.join(', ')}` : `clm resources: ${current.changes.join(', ')}`
      : current.notice
    return {
      next: { ...current, identity: nextIdentity, ...(promote && current.changes.length ? { changes: [], notice } : {}) },
      result: { ...current, identity: nextIdentity, ...(promote && current.changes.length ? { changes: [], notice } : {}) },
    }
  })
  for (const name of state.mutexes) {
    const found = await findMutex(io, name)
    if (!found) continue
    const owner = await ownerFor(io, found.path)
    if (owner?.session === session && owner.profile === nextIdentity.profile) await io.write(ownerFile(found.path), JSON.stringify({ ...owner, profile: nextIdentity.profile, pid: nextIdentity.pid, processCommand: nextIdentity.processCommand, cwd: currentCwd, repo: currentRepo, heartbeat: currentTime }))
  }
  return state
}

const shellSegments = (command: string): string[][] => {
  const segments: string[][] = []
  let words: string[] = []
  let word = ''
  let quote = ''
  let escaped = false
  const finishWord = () => { if (word) words.push(word); word = '' }
  const finishSegment = () => { finishWord(); if (words.length) segments.push(words); words = [] }
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index)
    if (escaped) { word += char; escaped = false; continue }
    if (char === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) { if (char === quote) quote = ''; else word += char; continue }
    if (char === '"' || char === "'") { quote = char; continue }
    if (char === '#' && !word && (index === 0 || /\s/.test(command[index - 1] ?? ''))) {
      while (index < command.length && command[index] !== '\n') index++
      finishSegment()
      continue
    }
    if (/[;&|\n]/.test(char)) {
      finishSegment()
      if (char === '&' || char === '|') while (command.charAt(index + 1) === char) index++
      continue
    }
    if (/\s/.test(char)) { finishWord(); continue }
    word += char
  }
  finishSegment()
  return segments
}

const segmentUsesMutex = (words: readonly string[], aliases: readonly string[]): boolean => {
  const first = (words[0] ?? '').split('/').at(-1)?.toLocaleLowerCase()
  if (['rg', 'grep', 'egrep', 'fgrep', 'fd', 'find'].includes(first ?? '')) return false
  if (first === 'git' && ['log', 'show', 'grep', 'commit'].includes((words[1] ?? '').toLocaleLowerCase())) return false
  const tokens = words.map(normalized)
  return aliases.some(alias => {
    const parts = normalized(alias).split(/\s+/).filter(Boolean)
    return parts.length > 0 && tokens.some((_, start) => parts.every((part, offset) => tokens[start + offset] === part))
  })
}

const stripCommandWrappers = (input: readonly string[]): string[] => {
  const words = [...input]
  while (words.length) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(words[0] ?? '')) words.shift()
    const first = (words[0] ?? '').toLocaleLowerCase()
    const second = (words[1] ?? '').toLocaleLowerCase()
    if (['sudo', 'command', 'npx', 'bunx'].includes(first)) { words.shift(); continue }
    if ((first === 'pnpm' && ['exec', 'dlx'].includes(second)) || (first === 'yarn' && second === 'dlx') || (first === 'bun' && second === 'x') || (first === 'npm' && second === 'exec')) {
      words.splice(0, 2)
      if (words[0] === '--') words.shift()
      continue
    }
    break
  }
  return words
}


const commandPort = (words: readonly string[]) => {
  for (let index = 2; index < words.length; index++) {
    const word = words[index] ?? ''
    const inline = /^(?:--port=|-p)(\d{1,5})$/.exec(word)?.[1]
    if (inline) return inline
    if ((word === '--port' || word === '-p') && /^\d{1,5}$/.test(words[index + 1] ?? '')) return words[index + 1]
  }
  return undefined
}


export const detectOwned = (command: string, result: unknown, cwd: string, startedAt: number, profile = 'default'): OwnedResource[] => {
  const outer = isRecord(result) ? result : {}
  const payload = isRecord(outer.result) ? outer.result : outer
  if (outer.deny !== undefined || outer.isError === true || outer.interrupted === true || payload.isError === true || payload.interrupted === true) return []
  if (typeof payload.exitCode === 'number' && payload.exitCode !== 0) return []
  const stdout = typeof payload.stdout === 'string' ? payload.stdout : ''
  const backgroundTaskId = typeof payload.backgroundTaskId === 'string' ? payload.backgroundTaskId : undefined
  const records: OwnedResource[] = []
  const add = (kind: OwnedKind, id: string, label: string) => records.push({ kind, id, label, profile, cwd, startedAt: iso(startedAt), ...(backgroundTaskId ? { backgroundTaskId } : {}) })
  const segments = shellSegments(command).map(stripCommandWrappers)
  for (const words of segments) {
    const first = (words[0] ?? '').toLocaleLowerCase()
    const second = (words[1] ?? '').toLocaleLowerCase()
    const third = (words[2] ?? '').toLocaleLowerCase()
    if (first === 'emulator' && second === '-avd' && words[2]) add('android-emulator', `avd:${words[2]}`, words[2])
    if (first === 'xcrun' && second === 'simctl' && third === 'boot' && words[3]) add('ios-simulator', words[3], words[3])
    if ((first === 'expo' && second === 'start') || (first === 'react-native' && second === 'start') || (first === 'metro' && ['serve', 'start'].includes(second ?? ''))) {
      const port = commandPort(words) ?? '8081'
      add('metro', port, `:${port}`)
    }
    if ((first === 'vite') || (first === 'next' && second === 'dev') || (['npm', 'pnpm', 'yarn', 'bun'].includes(first ?? '') && second === 'run' && third === 'dev')) {
      const port = /https?:\/\/[^\s/:]+:(\d{1,5})/i.exec(stdout)?.[1]
      if (port) add('web-dev', port, `:${port}`)
    }
    if (first === 'gh' && second === 'pr' && third === 'create') {
      const url = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i.exec(stdout)?.[0]
      if (url) add('pr', url, url)
    }
  }
  return records
}

const ownedChange = (resource: OwnedResource, prefix: '+' | '-') => {
  const label = resource.kind === 'metro' || resource.kind === 'web-dev' ? `${resource.kind} :${resource.id}` : `${resource.kind} ${resource.label}`
  return `${prefix}${label}`
}

export const recordDetected = async (io: ResourceIo, records: readonly OwnedResource[]) => {
  if (!records.length) return
  const session = await io.sessionId()
  await mutateSession(io, session, async current => {
    const owned = [...current.owned]
    const changes = [...current.changes]
    for (const resource of records) {
      const existing = owned.findIndex(item => item.kind === resource.kind && item.id === resource.id)
      if (existing >= 0) owned[existing] = resource
      else {
        owned.push(resource)
        changes.push(ownedChange(resource, '+'))
      }
    }
    return { next: { ...current, owned, changes }, result: undefined }
  })
}

export const registerResource = async (io: ResourceIo, input: ClmResourceInput): Promise<{ result?: unknown; deny?: string }> => {
  const session = await io.sessionId()
  const name = input.name?.trim()
  if (!name) return { deny: 'clm_resource requires a non-empty name.' }
  if (input.kind === 'owned') {
    await ensureSessionIdentity(io, session, false)
    const currentTime = await now(io)
    const cwd = await io.cwd()
    const resource: OwnedResource = { kind: 'custom', id: name, label: name, profile: await profileFor(io), cwd, startedAt: iso(currentTime) }
    await mutateSession(io, session, current => {
      const owned = current.owned.some(item => item.kind === 'custom' && item.id === name) ? current.owned : [...current.owned, resource]
      const changes = current.owned.some(item => item.kind === 'custom' && item.id === name) ? current.changes : [...current.changes, `+custom ${name}`]
      return { next: { ...current, owned, changes }, result: undefined }
    })
    return { result: { registered: 'owned', name } }
  }
  if (input.kind !== 'mutex') return { deny: 'clm_resource register requires kind owned or mutex.' }
  const root = await mutexRoot(io)
  const madeRoot = await run(io, ['mkdir', '-p', root], { timeoutMs: 1000 })
  if (madeRoot?.exitCode !== 0) return { deny: `Could not create the mutex registry at ${root}.` }
  const path = await mutexPath(io, name)
  const made = await run(io, ['mkdir', path], { timeoutMs: 1000 })
  const prior = await readJson(io, resourceFile(path), isMutexRecord)
  if (made?.exitCode !== 0 && !prior) return { deny: `Could not register mutex ${name}; its registry entry is unavailable.` }
  const aliases = [...new Set([...(prior?.aliases ?? []), ...(input.aliases ?? []).map(alias => alias.trim()).filter(Boolean)])]
  const record: MutexRecord = { name: prior?.name ?? name, aliases, description: input.description ?? prior?.description ?? '', registeredBy: prior?.registeredBy ?? session }
  await io.write(resourceFile(path), JSON.stringify(record))
  await mutateSession(io, session, current => ({ next: { ...current, changes: [...current.changes, `mutex ${record.name} registered`] }, result: undefined }))
  return { result: { registered: 'mutex', name: record.name, aliases } }
}

const inspectMutexes = async (io: ResourceIo) => {
  const mutexes = await listMutexRecords(io)
  const views: { name: string; aliases: string[]; description: string; borrower: string | null; owner: MutexOwner | null }[] = []
  for (const { record, path } of mutexes) {
    const borrower = await liveOwner(io, record, path)
    views.push({ name: record.name, aliases: record.aliases, description: record.description, borrower: borrower ? ownerLabel(borrower) : null, owner: borrower ?? null })
  }
  return views
}

export const acquireResource = async (io: ResourceIo, name: string): Promise<{ result?: unknown; deny?: string }> => {
  const found = await findMutex(io, name)
  if (!found) return { deny: `clm_resource: no mutex is registered as ${name}.` }
  const session = await io.sessionId()
  await ensureSessionIdentity(io, session, false)
  const acquired = await claimOne(io, session, found.record, found.path)
  if (acquired.status === 'denied') return { deny: acquired.owner ? denial(acquired.owner) : `clm_resource: could not claim ${found.record.name}; retry after checking its owner.` }
  return { result: { name: found.record.name, borrower: acquired.owner ? ownerLabel(acquired.owner) : `${await profileFor(io)}/${session}`, status: acquired.status } }
}

export const releaseResource = async (io: ResourceIo, name: string): Promise<{ result?: unknown; deny?: string }> => {
  const found = await findMutex(io, name)
  if (!found) return { deny: `clm_resource: no mutex is registered as ${name}.` }
  const session = await io.sessionId()
  const profile = await profileFor(io)
  const owner = await ownerFor(io, found.path)
  if (owner && (owner.session !== session || owner.profile !== profile)) return { deny: denial(owner) }
  if (!owner) {
    await releaseOne(io, session, found.record, found.path, true)
    return { result: { name: found.record.name, status: 'free' } }
  }
  if (!(await releaseOne(io, session, found.record, found.path, true))) return { deny: `clm_resource: could not release ${found.record.name}.` }
  return { result: { name: found.record.name, status: 'released' } }
}

const takeTemporaryOwner = async (io: ResourceIo, session: string, record: MutexRecord, path: string): Promise<boolean> => {
  const identity = await identityFor(io, session)
  const currentTime = await now(io)
  const acquired = await run(io, ['mkdir', ownerPath(path)], { cwd: identity.cwd, timeoutMs: 1000 })
  if (acquired?.exitCode !== 0) return false
  const owner: MutexOwner = { session, profile: identity.profile, ...(identity.pid !== undefined ? { pid: identity.pid, processCommand: identity.processCommand } : {}), cwd: identity.cwd, repo: identity.repo, since: iso(currentTime), heartbeat: currentTime }
  try { await io.write(ownerFile(path), JSON.stringify(owner)); return true }
  catch (err) {
    io.log(`clm resources: could not write unregister owner for ${record.name}: ${String(err).slice(0, 160)}`)
    await run(io, ['rm', '-rf', ownerPath(path)], { cwd: identity.cwd, timeoutMs: 1000 })
    return false
  }
}

export const unregisterResource = async (io: ResourceIo, name: string): Promise<{ result?: unknown; deny?: string }> => {
  const found = await findMutex(io, name)
  if (!found) return { deny: `clm_resource: no mutex is registered as ${name}.` }
  const session = await io.sessionId()
  const owner = await liveOwner(io, found.record, found.path)
  if (owner && (owner.session !== session || owner.profile !== await profileFor(io))) return { deny: denial(owner) }
  const temporary = owner ? false : await takeTemporaryOwner(io, session, found.record, found.path)
  if (!owner && !temporary) return { deny: `clm_resource: ${found.record.name} is temporarily locked; retry.` }
  const tombstone = `${found.path}.unregister-${(await now(io)).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const moved = await run(io, ['mv', found.path, tombstone], { timeoutMs: 1000 })
  if (moved?.exitCode !== 0) {
    if (temporary) await run(io, ['rm', '-rf', ownerPath(found.path)], { timeoutMs: 1000 })
    return { deny: `clm_resource: could not unregister ${found.record.name}.` }
  }
  const removed = await run(io, ['rm', '-rf', tombstone], { timeoutMs: 1000 })
  if (removed?.exitCode !== 0) return { deny: `clm_resource: ${found.record.name} was detached from the registry but its directory could not be removed.` }
  await removeMutexFromSession(io, session, found.record, false)
  await mutateSession(io, session, current => ({ next: { ...current, changes: [...current.changes, `mutex ${found.record.name} unregistered`] }, result: undefined }))
  return { result: { name: found.record.name, status: 'unregistered' } }
}

export const guardBash = async (io: ResourceIo, command: string): Promise<string | undefined> => {
  const segments = shellSegments(command).map(stripCommandWrappers)
  const registered = await listMutexRecords(io).catch(err => {
    io.log(`clm resources: mutex registry lookup failed; allowing unmatched Bash command (${String(err).slice(0, 160)})`)
    return undefined
  })
  if (!registered) return undefined
  const found = registered.filter(({ record }) => segments.some(words => segmentUsesMutex(words, [record.name, ...record.aliases].filter(Boolean))))
  if (!found.length) return undefined
  const session = await io.sessionId().catch(err => {
    io.log(`clm resources: session identity lookup failed; allowing matched Bash command (${String(err).slice(0, 160)})`)
    return undefined
  })
  if (!session) return undefined
  try {
    for (const item of found) {
      const owner = await liveOwner(io, item.record, item.path)
      if (owner && (owner.session !== session || owner.profile !== await profileFor(io))) return `${denial(owner)} Ask that borrower or wait for release before using ${item.record.name}.`
      if (!owner && await lockIsOccupied(io, item.path)) return `clm_resource: ${item.record.name} has a stale or unreadable owner record; retry shortly.`
    }
  } catch (err) {
    io.log(`clm resources: mutex owner check failed; allowing matched Bash command (${String(err).slice(0, 160)})`)
    return undefined
  }
  return undefined
}

export const applyResourceAction = async (io: ResourceIo, input: ClmResourceInput): Promise<{ result?: unknown; deny?: string }> => {
  const name = input.name?.trim()
  switch (input.action) {
    case 'list': {
      const session = await io.sessionId()
      const owned = (await readSession(io, session)).owned
      return { result: { owned, mutexes: await inspectMutexes(io) } }
    }
    case 'who': {
      if (!name) return { deny: 'clm_resource who requires name.' }
      const mutexes = await inspectMutexes(io)
      const found = mutexes.find(item => [item.name, ...item.aliases].some(alias => normalized(alias) === normalized(name)))
      return found ? { result: { name: found.name, borrower: found.borrower } } : { deny: `clm_resource: no mutex is registered as ${name}.` }
    }
    case 'register':
      return registerResource(io, input)
    case 'unregister':
      return name ? unregisterResource(io, name) : { deny: 'clm_resource unregister requires name.' }
    case 'acquire':
      return name ? acquireResource(io, name) : { deny: 'clm_resource acquire requires name.' }
    case 'release':
      return name ? releaseResource(io, name) : { deny: 'clm_resource release requires name.' }
    case 'forget': {
      if (!name) return { deny: 'clm_resource forget requires name.' }
      const session = await io.sessionId()
      const current = await readSession(io, session)
      const resource = current.owned.find(item => item.id === name || item.label === name)
      if (!resource) return { deny: `clm_resource: this session has no owned resource named ${name}.` }
      await mutateSession(io, session, state => ({ next: { ...state, owned: state.owned.filter(item => item.kind !== resource.kind || item.id !== resource.id), changes: [...state.changes, ownedChange(resource, '-')] }, result: undefined }))
      return { result: { forgotten: resource.id } }
    }
  }
}

const removeSession = async (io: ResourceIo, session: string) => {
  const removed = await run(io, ['rm', '-f', await keyFor(io, session)], { timeoutMs: 1000 })
  return removed?.exitCode === 0
}


const transferHintKey = (state: ResourceSession, source: string) => `${state.profile}/${state.identity?.pid ?? state.identity?.heartbeat}/${state.identity?.cwd ?? ''}/${source}`

const transferPending = async (io: ResourceIo, session: string, identity: ResourceIdentity) => {
  const current = await readSession(io, session)
  const alreadyTransferred = new Set(current.transferredFrom ?? [])
  const records = (await listOwnedRecords(io)).filter(item => item.session !== session && !alreadyTransferred.has(item.session))
  const transfers: { source: string; state: ResourceSession }[] = []
  for (const { session: source, state } of records) {
    const prior = processIdentities.get(`${state.profile}/${source}`)
    if (state.pendingTransfer && state.profile === identity.profile && prior?.processPid !== undefined && prior.processPid === identity.processPid && prior.cwd === identity.cwd) transfers.push({ source, state })
  }
  if (!transfers.length) return
  await mutateSession(io, session, async stateNow => {
    const owned = [...stateNow.owned]
    const mutexes = [...stateNow.mutexes]
    const changes = [...stateNow.changes]
    const transferredFrom = new Set(stateNow.transferredFrom ?? [])
    for (const { source, state } of transfers) {
      transferredFrom.add(source)
      const noticeAlreadyShown = pendingNoticesShown.has(transferHintKey(state, source))
      for (const resource of state.owned) {
        if (owned.some(item => item.kind === resource.kind && item.id === resource.id)) continue
        owned.push({ ...resource, profile: identity.profile })
        if (!noticeAlreadyShown) changes.push(`transferred ${resource.kind} ${resource.label}`)
      }
      for (const name of state.mutexes) {
        const found = await findMutex(io, name)
        if (!found) continue
        const owner = await ownerFor(io, found.path)
        if (owner?.session !== source || owner.profile !== identity.profile || owner.pid !== identity.pid || owner.cwd !== identity.cwd) continue
        if (!mutexes.some(item => normalized(item) === normalized(name))) mutexes.push(name)
        if (!noticeAlreadyShown) changes.push(`mutex ${name} held`)
        await io.write(ownerFile(found.path), JSON.stringify({ ...owner, session, profile: identity.profile, pid: identity.pid, processCommand: identity.processCommand, cwd: identity.cwd, repo: identity.repo, heartbeat: identity.heartbeat }))
      }
    }
    return { next: { ...stateNow, owned, mutexes, changes, transferredFrom: [...transferredFrom] }, result: undefined }
  })
  for (const { source } of transfers) await removeSession(io, source)
}

const transferPendingForSession = async (io: ResourceIo, session: string) => {
  const pending = (await listOwnedRecords(io)).filter(item => item.session !== session && item.state.pendingTransfer && processIdentities.has(`${item.state.profile}/${item.session}`))
  if (!pending.length) return
  const identity = await identityFor(io, session)
  await transferPending(io, session, identity)
}

const pendingTransferNotice = async (io: ResourceIo): Promise<string | undefined> => {
  const pending = (await listOwnedRecords(io)).filter(item => item.state.pendingTransfer && processIdentities.has(`${item.state.profile}/${item.session}`))
  if (!pending.length) return undefined
  const identity = await identityFor(io, await io.sessionId())
  const profile = identity.profile
  const changes: string[] = []
  for (const { session, state } of pending) {
    const prior = processIdentities.get(`${state.profile}/${session}`)
    if (!prior || state.profile !== profile || prior.processPid !== identity.processPid || prior.cwd !== identity.cwd) continue
    const key = transferHintKey(state, session)
    if (pendingNoticesShown.has(key)) continue
    pendingNoticesShown.add(key)
    changes.push(...state.owned.map(resource => ownedChange(resource, '+')))
    changes.push(...state.mutexes.map(name => `mutex ${name} held`))
  }
  return changes.length ? `clm resources: ${changes.join(', ')}` : undefined
}

export const resourceLedgerForSession = async (session: string): Promise<string[]> => {
  if (!activeResourceIo) return []
  await transferPendingForSession(activeResourceIo, session)
  return resourceLedgerLines(await readSession(activeResourceIo, session))
}


const refreshOwnedLocks = async (io: ResourceIo, session: string, state: ResourceSession) => {
  const identity = state.identity
  if (!identity) return
  for (const name of state.mutexes) {
    const found = await findMutex(io, name)
    if (!found) continue
    const owner = await ownerFor(io, found.path)
    if (owner?.session === session && owner.profile === identity.profile) await io.write(ownerFile(found.path), JSON.stringify({ ...owner, profile: identity.profile, pid: identity.pid, processCommand: identity.processCommand, cwd: identity.cwd, repo: identity.repo, heartbeat: identity.heartbeat }))
  }
}

const promoteResourceChanges = async (io: ResourceIo, session: string) => {
  await mutateSession(io, session, current => {
    if (!current.changes.length) return { next: current, result: undefined }
    const changes = current.changes.join(', ')
    const notice = current.notice ? `${current.notice}; ${changes}` : `clm resources: ${changes}`
    return { next: { ...current, changes: [], notice }, result: undefined }
  })
}


export const touchResources = async (io: ResourceIo) => {
  if (!(await hasResourceHome(io))) return
  const session = await io.sessionId()
  const profile = await profileFor(io)
  await transferPendingForSession(io, session)
  const current = await readSession(io, session)
  if (!current.owned.length && !current.mutexes.length) return
  const key = `${profile}/${session}`
  const currentTime = await now(io)
  const lastTouch = resourceTouches.get(key)
  if (lastTouch !== undefined && currentTime - lastTouch < 60_000) return
  const state = await ensureSessionIdentity(io, session, false)
  await refreshOwnedLocks(io, session, state)
  resourceTouches.set(key, currentTime)
}

export const turnStartResources = async (io: ResourceIo) => {
  if (!(await hasResourceHome(io))) return
  const session = await io.sessionId()
  await transferPendingForSession(io, session)
  const current = await readSession(io, session)
  if (current.changes.length || current.owned.length || current.mutexes.length) await ensureSessionIdentity(io, session, true)
}

export const consumeResourceNotice = async (io: ResourceIo): Promise<string | undefined> => {
  const session = await io.sessionId()
  if (!(await readSession(io, session)).notice) return undefined
  const notice = await mutateSession(io, session, current => ({
    next: { ...current, notice: undefined },
    result: current.notice,
  }))
  return notice?.replace(/\s+/g, ' ').trim()
}

const otherResourceReferences = async (io: ResourceIo, session: string, resource: OwnedResource): Promise<boolean> => {
  const transferredFrom = new Set((await readSession(io, session)).transferredFrom ?? [])
  const others = (await listOwnedRecords(io)).filter(item => item.session !== session)
  for (const other of others) {
    const identity = other.state.identity
    const alive = identity?.pid !== undefined
      ? await processAlive(io, identity.pid, identity.cwd, identity.processCommand).catch(err => {
        io.log(`clm resources: owned record PID check failed for ${other.session} (${String(err).slice(0, 160)})`)
        return false
      }) === true
      : await heartbeatAlive(io, identity?.heartbeat ?? 0).catch(err => {
        io.log(`clm resources: owned record heartbeat check failed for ${other.session} (${String(err).slice(0, 160)})`)
        return false
      })
    if (!alive) {
      const removed = await run(io, ['rm', '-f', other.path], { timeoutMs: 1000 })
      if (removed?.exitCode === 0) io.log(`clm resources: removed stale owned record ${other.session}`)
      continue
    }
    for (const source of other.state.transferredFrom ?? []) transferredFrom.add(source)
    if (!transferredFrom.has(other.session) && other.state.owned.some(item => item.id === resource.id)) return true
  }
  return false
}

const stopLog = (io: ResourceIo, resource: OwnedResource, argv: readonly string[], result: ProcessResult | undefined) => {
  io.log(`clm resources: stop ${resource.kind} ${resource.id} command=${JSON.stringify(argv)} exitCode=${result?.exitCode ?? 'unavailable'} stderr=${JSON.stringify(result?.stderr ?? '')}`)
}

const stopOwned = async (io: ResourceIo, resource: OwnedResource, identity: ResourceIdentity): Promise<boolean> => {
  const cwd = resource.cwd || identity.cwd
  if (resource.kind === 'pr' || resource.kind === 'custom') return true
  if (resource.kind === 'ios-simulator') {
    const argv = ['xcrun', 'simctl', 'shutdown', resource.id]
    const result = await run(io, argv, { cwd, timeoutMs: 1000 })
    stopLog(io, resource, argv, result)
    return result?.exitCode === 0
  }
  if (resource.kind === 'android-emulator') {
    const avd = resource.id.startsWith('avd:') ? resource.id.slice(4) : resource.id
    const devicesArgv = ['adb', 'devices', '-l']
    const devices = await run(io, devicesArgv, { cwd, timeoutMs: 1000 })
    if (!devices || devices.exitCode !== 0) {
      stopLog(io, resource, devicesArgv, devices)
      return false
    }
    const serials = [...devices.stdout.matchAll(/^\s*(emulator-\d+)\b/gm)].flatMap(match => match[1] ? [match[1]] : [])
    for (const serial of serials) {
      const nameArgv = ['adb', '-s', serial, 'emu', 'avd', 'name']
      const name = await run(io, nameArgv, { cwd, timeoutMs: 1000 })
      if (!name || name.exitCode !== 0 || name.stdout.trim() !== avd) continue
      const argv = ['adb', '-s', serial, 'emu', 'kill']
      const result = await run(io, argv, { cwd, timeoutMs: 1000 })
      stopLog(io, resource, argv, result)
      return result?.exitCode === 0
    }
    io.log(`clm resources: stop ${resource.kind} ${resource.id} skipped; no adb serial matched AVD ${avd}`)
    return true
  }
  const port = Number(resource.id)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    io.log(`clm resources: stop ${resource.kind} ${resource.id} skipped; invalid port`)
    return true
  }
  const lookup = ['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']
  const found = await run(io, lookup, { cwd, timeoutMs: 1000 })
  if (!found) {
    stopLog(io, resource, lookup, found)
    return false
  }
  const pids = found.stdout.trim().split(/\s+/).filter(pid => /^\d+$/.test(pid))
  const stopped = await Promise.all(pids.map(async pid => {
    const argv = ['/bin/kill', pid]
    const result = await run(io, argv, { cwd, timeoutMs: 1000 })
    stopLog(io, resource, argv, result)
    return result?.exitCode === 0
  }))
  if (!pids.length) io.log(`clm resources: stop ${resource.kind} ${resource.id}; no process is listening`)
  return stopped.every(Boolean)
}

const hasEndBudget = (io: ResourceIo) => {
  const remaining = io.budgetRemaining?.()
  return remaining === undefined || !Number.isFinite(remaining) || remaining >= 80
}


export const endResources = async (io: ResourceIo, session: string, reason: string): Promise<void> => {
  if (reason === 'clear' || reason === 'resume') {
    const current = await readSession(io, session)
    if (!current.owned.length && !current.mutexes.length) return
    await ensureSessionIdentity(io, session, false)
    await mutateSession(io, session, current => ({ next: { ...current, pendingTransfer: true }, result: undefined }))
    return
  }
  await transferPending(io, session, await identityFor(io, session))
  const initial = await readSession(io, session)
  for (const name of [...initial.mutexes]) {
    if (!hasEndBudget(io)) { io.log(`clm resources: session.end budget exhausted before releasing mutex ${name}`); break }
    const found = await findMutex(io, name)
    if (found) await releaseOne(io, session, found.record, found.path, false)
  }
  const identity = initial.identity ?? await runtimeIdentity(io)
  for (const resource of initial.owned) {
    if (!hasEndBudget(io)) { io.log(`clm resources: session.end budget exhausted before stopping ${resource.kind} ${resource.id}`); break }
    if (await otherResourceReferences(io, session, resource)) {
      await mutateSession(io, session, current => ({ next: { ...current, owned: current.owned.filter(item => item.kind !== resource.kind || item.id !== resource.id) }, result: undefined }))
      continue
    }
    if (!(await stopOwned(io, resource, identity))) continue
    await mutateSession(io, session, current => ({ next: { ...current, owned: current.owned.filter(item => item.kind !== resource.kind || item.id !== resource.id) }, result: undefined }))
  }
  const remaining = await readSession(io, session)
  if (!remaining.mutexes.length && !remaining.owned.length && !remaining.transferredFrom?.length) await removeSession(io, session)
}

const resourceActions = new Set(['list', 'who', 'register', 'unregister', 'acquire', 'release', 'forget'])
export const isClmResourceInput = (value: unknown): value is ClmResourceInput => {
  if (!isRecord(value) || !resourceActions.has(String(value.action))) return false
  if (value.name !== undefined && typeof value.name !== 'string') return false
  if (value.kind !== undefined && value.kind !== 'owned' && value.kind !== 'mutex') return false
  if (value.aliases !== undefined && (!Array.isArray(value.aliases) || !value.aliases.every(alias => typeof alias === 'string'))) return false
  if (value.description !== undefined && typeof value.description !== 'string') return false
  return Object.keys(value).every(key => ['action', 'name', 'kind', 'aliases', 'description'].includes(key))
}

export const handleResourceTool = async (io: ResourceIo, value: unknown): Promise<{ result?: unknown; deny?: string }> => {
  if (!isClmResourceInput(value)) return { deny: 'clm_resource requires a valid action and resource fields.' }
  return applyResourceAction(io, value)
}

type ResourceEngine = Pick<EngineInterface, 'session' | 'env' | 'clock' | 'fs' | 'process' | 'ui'>
const resourceIo = ($: ResourceEngine, budget?: () => number, sessionId?: string): ResourceIo => {
  return {
    sessionId: () => sessionId === undefined ? $.session.id() : Promise.resolve(sessionId), home: () => $.env.get('HOME'), configDir: () => $.env.get('CLAUDE_CONFIG_DIR'), cwd: () => $.session.cwd(), repo: () => $.session.root(), now: () => $.clock.now(),
    exists: path => $.fs.exists(path), list: async path => await $.fs.list(path), read: async path => { try { return await $.fs.read(path) } catch { return undefined } }, write: (path, value) => $.fs.write(path, value),
    run: (argv, options) => $.process.run(argv, options), log: text => $.ui.log(text, { to: 'debug' }), ...(budget ? { budgetRemaining: budget } : {}),
  }
}

const activateResourceIo = ($: ResourceEngine, sessionId?: string) => {
  activeResourceIo = resourceIo($, undefined, sessionId)
  return activeResourceIo
}
export const registerResources: Register = (on) => {
  on('turn.start', { turnId: /.*/ }, async ($, e, next) => {
    try { await turnStartResources(activateResourceIo($)) }
    catch (err) { $.ui.log(`clm resources: turn start failed (${String(err).slice(0, 160)})`, { to: 'debug' }) }
    return next(e)
  })

  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    activateResourceIo($)
    try {
      await $.tool.register({
        name: 'clm_resource', description: RESOURCE_DESCRIPTION,
        inputSchema: {
          type: 'object', properties: {
            action: { type: 'string', enum: ['list', 'who', 'register', 'unregister', 'acquire', 'release', 'forget'] },
            name: { type: 'string' }, kind: { type: 'string', enum: ['owned', 'mutex'] }, aliases: { type: 'array', items: { type: 'string' } }, description: { type: 'string' },
          }, required: ['action'], additionalProperties: false,
        },
      })
    } catch (err) { $.ui.log(`clm: clm_resource registration failed (${String(err).slice(0, 120)})`, { to: 'debug' }) }
    return next(e)
  })

  on('tool.call', { tool: /.*/ }, async ($, e, next) => {
    const io = activateResourceIo($)
    try { await touchResources(io) }
    catch (err) { $.ui.log(`clm resources: heartbeat failed (${String(err).slice(0, 160)})`, { to: 'debug' }) }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const io = activateResourceIo($)
    const denied = await guardBash(io, e.command).catch(err => {
      $.ui.log(`clm resources: mutex guard failed; allowing Bash command (${String(err).slice(0, 160)})`, { to: 'debug' })
      return undefined
    })
    if (denied) return { deny: denied }
    const result = await next(e)
    try {
      const records = detectOwned(e.command, result, await io.cwd(), await io.now(), await profileFor(io))
      await recordDetected(io, records)
    } catch (err) { $.ui.log(`clm resources: Bash result tracking failed (${String(err).slice(0, 160)})`, { to: 'debug' }) }
    return result
  })

  on('tool.call', { tool: RESOURCE_TOOL }, async ($, e) => {
    try {
      const { action, name, kind, aliases, description } = e
      const outcome = await handleResourceTool(activateResourceIo($), { action, name, kind, aliases, description })
      return outcome.deny ? { deny: outcome.deny } : { result: outcome.result }
    } catch (err) {
      $.ui.log(`clm resources: resource action failed (${String(err).slice(0, 160)})`, { to: 'debug' })
      return { deny: `clm_resource failed: ${String(err).slice(0, 160)}` }
    }
  })

  on('prompt.compose', { model: /.*/ }, async ($, e, next) => {
    const result = await next(e)
    try {
      const io = activateResourceIo($)
      const session = await io.sessionId()
      if ((await readSession(io, session)).changes.length) await promoteResourceChanges(io, session)
      const notice = await consumeResourceNotice(io)
      const pending = notice ? undefined : await pendingTransferNotice(io)
      const message = notice ?? pending
      return message ? { ...result, sections: [...result.sections, { id: 'clm:resources', text: message, scope: 'session' as const }] } : result
    } catch (err) {
      $.ui.log(`clm resources: prompt notice failed (${String(err).slice(0, 160)})`, { to: 'debug' })
      return result
    }
  })

  on('session.end', async ($, e, next) => {
    const io = resourceIo($, () => next.budget.remainingMs, e.sessionId)
    activeResourceIo = io
    try { await endResources(io, e.sessionId, e.reason) }
    catch (err) { $.ui.log(`clm resources: session.end failed (${String(err).slice(0, 160)})`, { to: 'debug' }) }
    return next(e)
  })
}
