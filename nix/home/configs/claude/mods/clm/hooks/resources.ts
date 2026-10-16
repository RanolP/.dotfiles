import type { EngineInterface, Register } from 'claude-code'
import type { ClmResourceInput } from '../types'
import { register as registerClm } from './register'

export const RESOURCE_TOOL = 'mcp__clm__clm_resource'
export const RESOURCE_DESCRIPTION = 'Track resources this session owns and shared exclusive resources. Call `register` with kind `mutex` when a device or service may be used by only one session at a time; call `who` before using one; call `release` the moment you finish with it. Bash commands that start an emulator, simulator, Metro, a web dev server, or a PR are recorded automatically; `register` with kind `owned` covers anything they miss.'
const RESOURCE_PREFIX = 'resources:'
const HEARTBEAT_TTL_MS = 60 * 60 * 1000
const MUTEX_DIR = '.claude-work/clm/mutex'

export type OwnedKind = 'android-emulator' | 'ios-simulator' | 'metro' | 'web-dev' | 'pr' | 'custom'
export type OwnedResource = {
  kind: OwnedKind
  id: string
  label: string
  cwd: string
  startedAt: string
  backgroundTaskId?: string
}
export type MutexRecord = { name: string; aliases: string[]; description: string; registeredBy: string }
export type MutexOwner = { session: string; pid?: number; cwd: string; repo: string; since: string; heartbeat: number }
export type ResourceIdentity = { processPid?: number; pid?: number; cwd: string; repo: string; heartbeat: number; probedAt: number }
export type ResourceSession = {
  owned: OwnedResource[]
  mutexes: string[]
  changes: string[]
  transferredFrom?: string[]
  notice?: string
  pendingTransfer?: boolean
  identity?: ResourceIdentity
}
export type ProcessResult = { exitCode: number; stdout: string; stderr: string }
export type ResourceIo = {
  sessionId: () => Promise<string>
  home: () => Promise<string | undefined>
  cwd: () => Promise<string>
  repo: () => Promise<string>
  now: () => Promise<number>
  keys: () => Promise<string[]>
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  exists: (path: string) => Promise<boolean>
  list: (path: string) => Promise<{ name: string; kind: string }[]>
  read: (path: string) => Promise<string | undefined>
  write: (path: string, value: string) => Promise<void>
  run: (argv: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<ProcessResult>
  log: (text: string) => void
  budgetRemaining?: () => number
}

const queues = new Map<string, Promise<void>>()
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const asSession = (value: unknown): ResourceSession => {
  if (!isRecord(value)) return { owned: [], mutexes: [], changes: [] }
  return {
    owned: Array.isArray(value.owned) ? value.owned.filter(isOwnedResource) : [],
    mutexes: Array.isArray(value.mutexes) ? value.mutexes.filter((name): name is string => typeof name === 'string') : [],
    changes: Array.isArray(value.changes) ? value.changes.filter((change): change is string => typeof change === 'string') : [],
    ...(Array.isArray(value.transferredFrom) ? { transferredFrom: value.transferredFrom.filter((session): session is string => typeof session === 'string') } : {}),
    ...(typeof value.notice === 'string' ? { notice: value.notice } : {}),
    ...(value.pendingTransfer === true ? { pendingTransfer: true } : {}),
    ...(isIdentity(value.identity) ? { identity: value.identity } : {}),
  }
}
const isOwnedResource = (value: unknown): value is OwnedResource => isRecord(value)
  && typeof value.kind === 'string' && ['android-emulator', 'ios-simulator', 'metro', 'web-dev', 'pr', 'custom'].includes(value.kind)
  && typeof value.id === 'string' && typeof value.label === 'string' && typeof value.cwd === 'string' && typeof value.startedAt === 'string'
  && (value.backgroundTaskId === undefined || typeof value.backgroundTaskId === 'string')
const isIdentity = (value: unknown): value is ResourceIdentity => isRecord(value)
  && (value.processPid === undefined || typeof value.processPid === 'number')
  && (value.pid === undefined || typeof value.pid === 'number')
  && typeof value.cwd === 'string' && typeof value.repo === 'string' && typeof value.heartbeat === 'number' && typeof value.probedAt === 'number'
const isMutexRecord = (value: unknown): value is MutexRecord => isRecord(value)
  && typeof value.name === 'string' && Array.isArray(value.aliases) && value.aliases.every(alias => typeof alias === 'string')
  && typeof value.description === 'string' && typeof value.registeredBy === 'string'
const isMutexOwner = (value: unknown): value is MutexOwner => isRecord(value)
  && typeof value.session === 'string' && (value.pid === undefined || typeof value.pid === 'number')
  && typeof value.cwd === 'string' && typeof value.repo === 'string' && typeof value.since === 'string' && typeof value.heartbeat === 'number'

export const resourceKey = (session: string) => `${RESOURCE_PREFIX}${session}`
const iso = (ms: number) => new Date(ms).toISOString()
const normalized = (value: string) => value.trim().toLocaleLowerCase()
const mutexSlug = (name: string) => {
  const value = normalized(name)
  let hash = 2166136261
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  const base = value.normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'resource'
  return `${base}-${(hash >>> 0).toString(16)}`
}
const mutexRoot = async (io: ResourceIo) => {
  const home = await io.home()
  if (!home) throw new Error('HOME is unset; mutex resources need a persistent host directory')
  return `${home.replace(/\/$/, '')}/${MUTEX_DIR}`
}
const mutexPath = async (io: ResourceIo, name: string) => `${await mutexRoot(io)}/${mutexSlug(name)}`
const ownerPath = (path: string) => `${path}/owner`
const ownerFile = (path: string) => `${path}/owner/owner.json`
const resourceFile = (path: string) => `${path}/resource.json`
const now = (io: ResourceIo) => io.now()
const keyFor = (session: string) => resourceKey(session)

async function serialized<T>(session: string, body: () => Promise<T>): Promise<T> {
  const previous = queues.get(session) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const tail = previous.then(() => gate)
  queues.set(session, tail)
  await previous
  try { return await body() }
  finally {
    release()
    if (queues.get(session) === tail) queues.delete(session)
  }
}

function logRunFailure(io: ResourceIo, argv: readonly string[], exitCode: number | string, stderr: string) {
  io.log(`clm resources: process.run failed command=${JSON.stringify(argv)} exitCode=${exitCode} stderr=${JSON.stringify(stderr)}`)
}

async function run(io: ResourceIo, argv: readonly string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<ProcessResult | undefined> {
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

async function readJson<T>(io: ResourceIo, path: string, guard: (value: unknown) => value is T): Promise<T | undefined> {
  try {
    const text = await io.read(path)
    if (!text) return undefined
    const value: unknown = JSON.parse(text)
    return guard(value) ? value : undefined
  } catch { return undefined }
}

async function writeSession(io: ResourceIo, session: string, value: ResourceSession) {
  await io.set(keyFor(session), value)
}

async function readSession(io: ResourceIo, session: string): Promise<ResourceSession> {
  return asSession(await io.get(keyFor(session)))
}

async function mutateSession<T>(io: ResourceIo, session: string, change: (current: ResourceSession) => { next: ResourceSession; result: T } | Promise<{ next: ResourceSession; result: T }>): Promise<T> {
  return serialized(session, async () => {
    const current = await readSession(io, session)
    const outcome = await change(current)
    await writeSession(io, session, outcome.next)
    return outcome.result
  })
}

async function runtimeIdentity(io: ResourceIo): Promise<ResourceIdentity> {
  const [cwd, repo, heartbeat] = await Promise.all([io.cwd(), io.repo(), now(io)])
  const parent = await run(io, ['sh', '-c', 'echo $PPID'], { cwd, timeoutMs: 1000 })
  const parsedPid = parent?.exitCode === 0 ? Number(parent.stdout.trim()) : NaN
  let pid: number | undefined
  if (Number.isSafeInteger(parsedPid) && parsedPid > 0) {
    const ps = await run(io, ['/bin/ps', '-p', String(parsedPid), '-o', 'command='], { cwd, timeoutMs: 1000 })
    if (ps?.exitCode === 0 && /(?:^|[\/\s])claude(?:-code)?(?:\s|$)/i.test(ps.stdout.trim())) pid = parsedPid
  }
  return {
    ...(Number.isSafeInteger(parsedPid) && parsedPid > 0 ? { processPid: parsedPid } : {}),
    ...(pid ? { pid } : {}), cwd, repo, heartbeat, probedAt: heartbeat,
  }
}

async function identityFor(io: ResourceIo, session: string): Promise<ResourceIdentity> {
  const existing = (await readSession(io, session)).identity
  if (existing?.probedAt) return existing
  return runtimeIdentity(io)
}

async function listMutexRecords(io: ResourceIo): Promise<{ record: MutexRecord; path: string }[]> {
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

async function ownerFor(io: ResourceIo, path: string) {
  return readJson(io, ownerFile(path), isMutexOwner)
}

async function ownerAlive(io: ResourceIo, owner: MutexOwner): Promise<boolean> {
  if (owner.pid !== undefined) {
    const result = await run(io, ['/bin/kill', '-0', String(owner.pid)], { cwd: owner.cwd, timeoutMs: 1000 })
    if (result) return result.exitCode === 0
  }
  return owner.heartbeat > 0 && (await now(io)) - owner.heartbeat < HEARTBEAT_TTL_MS
}

async function reclaimDeadOwner(io: ResourceIo, record: MutexRecord, path: string, owner: MutexOwner): Promise<boolean> {
  if (await ownerAlive(io, owner)) return false
  const stamp = `${(await now(io)).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const stale = `${path}/owner-stale-${stamp}`
  const moved = await run(io, ['mv', ownerPath(path), stale], { cwd: owner.cwd, timeoutMs: 1000 })
  if (moved?.exitCode !== 0) return false
  await run(io, ['rm', '-rf', stale], { cwd: owner.cwd, timeoutMs: 1000 })
  io.log(`clm resources: reclaimed ${record.name} from dead session ${owner.session}`)
  return true
}

async function findMutex(io: ResourceIo, name: string) {
  const target = normalized(name)
  return (await listMutexRecords(io)).find(({ record }) => [record.name, ...record.aliases].some(alias => normalized(alias) === target))
}

function denial(owner: MutexOwner) {
  return `clm_resource: held by session ${owner.session} at ${owner.cwd} (repo ${owner.repo}) since ${owner.since}.`
}

async function addMutexToSession(io: ResourceIo, session: string, record: MutexRecord, changed: boolean) {
  await mutateSession(io, session, current => {
    const mutexes = current.mutexes.includes(record.name) ? current.mutexes : [...current.mutexes, record.name]
    return { next: { ...current, mutexes, changes: changed ? [...current.changes, `mutex ${record.name} held`] : current.changes }, result: undefined }
  })
}

async function removeMutexFromSession(io: ResourceIo, session: string, record: MutexRecord, changed: boolean) {
  await mutateSession(io, session, current => ({
    next: { ...current, mutexes: current.mutexes.filter(name => normalized(name) !== normalized(record.name)), changes: changed ? [...current.changes, `mutex ${record.name} released`] : current.changes },
    result: undefined,
  }))
}

async function claimOne(io: ResourceIo, session: string, record: MutexRecord, path: string): Promise<{ status: 'claimed' | 'held' | 'denied'; owner?: MutexOwner }> {
  const identity = await identityFor(io, session)
  const currentTime = await now(io)
  const owner: MutexOwner = {
    session,
    ...(identity.pid !== undefined ? { pid: identity.pid } : {}),
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
    if (!previous) return { status: 'denied' }
    if (previous.session === session) {
      await io.write(ownerFile(path), JSON.stringify({ ...previous, pid: owner.pid, cwd: owner.cwd, repo: owner.repo, heartbeat: currentTime }))
      await addMutexToSession(io, session, record, false)
      return { status: 'held', owner: previous }
    }
    if (await ownerAlive(io, previous)) return { status: 'denied', owner: previous }
    if (!(await reclaimDeadOwner(io, record, path, previous))) continue
  }
  const current = await ownerFor(io, path)
  return { status: 'denied', ...(current ? { owner: current } : {}) }
}

async function releaseOne(io: ResourceIo, session: string, record: MutexRecord, path: string, changed: boolean): Promise<boolean> {
  const owner = await ownerFor(io, path)
  if (!owner) {
    await removeMutexFromSession(io, session, record, changed)
    return true
  }
  if (owner.session !== session) return false
  const removed = await run(io, ['rm', '-rf', ownerPath(path)], { cwd: owner.cwd, timeoutMs: 1000 })
  if (removed?.exitCode !== 0) return false
  await removeMutexFromSession(io, session, record, changed)
  return true
}

async function ensureSessionIdentity(io: ResourceIo, session: string, promote: boolean): Promise<ResourceSession> {
  const identity = await identityFor(io, session)
  const currentTime = await now(io)
  const currentCwd = await io.cwd()
  const currentRepo = await io.repo()
  const nextIdentity = { ...identity, cwd: currentCwd, repo: currentRepo, heartbeat: currentTime }
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
    if (owner?.session === session) await io.write(ownerFile(found.path), JSON.stringify({ ...owner, pid: nextIdentity.pid, cwd: currentCwd, repo: currentRepo, heartbeat: currentTime }))
  }
  return state
}

export function detectOwned(command: string, result: unknown, cwd: string, startedAt: number): OwnedResource[] {
  const outer = isRecord(result) ? result : {}
  const payload = isRecord(outer.result) ? outer.result : outer
  if (outer.deny !== undefined || outer.isError === true || outer.interrupted === true || payload.isError === true || payload.interrupted === true) return []
  if (typeof payload.exitCode === 'number' && payload.exitCode !== 0) return []
  const stdout = typeof payload.stdout === 'string' ? payload.stdout : ''
  const backgroundTaskId = typeof payload.backgroundTaskId === 'string' ? payload.backgroundTaskId : undefined
  const records: OwnedResource[] = []
  const add = (kind: OwnedKind, id: string, label: string) => records.push({ kind, id, label, cwd, startedAt: iso(startedAt), ...(backgroundTaskId ? { backgroundTaskId } : {}) })
  const avd = /\bemulator\b[^\n]*?\s-avd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i.exec(command)
  if (avd) add('android-emulator', `avd:${avd[1] ?? avd[2] ?? avd[3]}`, avd[1] ?? avd[2] ?? avd[3]!)
  const sim = /\bxcrun\s+simctl\s+boot\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/i.exec(command)
  if (sim) add('ios-simulator', sim[1] ?? sim[2] ?? sim[3]!, sim[1] ?? sim[2] ?? sim[3]!)
  if (/\bexpo\s+start\b|\breact-native\s+start\b|\bmetro(?:\s|$)/i.test(command)) {
    const port = /(?:--port(?:=|\s+)|-p\s+)(\d{1,5})/i.exec(command)?.[1] ?? '8081'
    add('metro', port, `:${port}`)
  }
  if (/\bvite(?:\s|$)|\bnext\s+dev\b|\b(?:npm|pnpm|yarn|bun)\s+run\s+dev\b/i.test(command)) {
    const port = /https?:\/\/[^\s/:]+:(\d{1,5})/i.exec(stdout)?.[1]
    if (port) add('web-dev', port, `:${port}`)
  }
  if (/\bgh\s+pr\s+create\b/i.test(command)) {
    const url = /https?:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i.exec(stdout)?.[0]
    if (url) add('pr', url, url)
  }
  return records
}

function ownedChange(resource: OwnedResource, prefix: '+' | '-') {
  const label = resource.kind === 'metro' || resource.kind === 'web-dev' ? `${resource.kind} :${resource.id}` : `${resource.kind} ${resource.label}`
  return `${prefix}${label}`
}

export async function recordDetected(io: ResourceIo, records: readonly OwnedResource[]) {
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

export async function registerResource(io: ResourceIo, input: ClmResourceInput): Promise<{ result?: unknown; deny?: string }> {
  const session = await io.sessionId()
  const name = input.name?.trim()
  if (!name) return { deny: 'clm_resource requires a non-empty name.' }
  if (input.kind === 'owned') {
    await ensureSessionIdentity(io, session, false)
    const currentTime = await now(io)
    const cwd = await io.cwd()
    const resource: OwnedResource = { kind: 'custom', id: name, label: name, cwd, startedAt: iso(currentTime) }
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

async function inspectMutexes(io: ResourceIo) {
  const mutexes = await listMutexRecords(io)
  const views: { name: string; aliases: string[]; description: string; borrower: MutexOwner | null }[] = []
  for (const { record, path } of mutexes) {
    let borrower = await ownerFor(io, path)
    if (borrower && !(await ownerAlive(io, borrower))) {
      await reclaimDeadOwner(io, record, path, borrower)
      borrower = undefined
    }
    views.push({ name: record.name, aliases: record.aliases, description: record.description, borrower: borrower ?? null })
  }
  return views
}

export async function acquireResource(io: ResourceIo, name: string): Promise<{ result?: unknown; deny?: string }> {
  const found = await findMutex(io, name)
  if (!found) return { deny: `clm_resource: no mutex is registered as ${name}.` }
  const session = await io.sessionId()
  await ensureSessionIdentity(io, session, false)
  const acquired = await claimOne(io, session, found.record, found.path)
  if (acquired.status === 'denied') return { deny: acquired.owner ? denial(acquired.owner) : `clm_resource: could not claim ${found.record.name}; retry after checking its owner.` }
  return { result: { name: found.record.name, borrower: session, status: acquired.status } }
}

export async function releaseResource(io: ResourceIo, name: string): Promise<{ result?: unknown; deny?: string }> {
  const found = await findMutex(io, name)
  if (!found) return { deny: `clm_resource: no mutex is registered as ${name}.` }
  const session = await io.sessionId()
  const owner = await ownerFor(io, found.path)
  if (owner && owner.session !== session) return { deny: denial(owner) }
  if (!owner) {
    await releaseOne(io, session, found.record, found.path, true)
    return { result: { name: found.record.name, status: 'free' } }
  }
  if (!(await releaseOne(io, session, found.record, found.path, true))) return { deny: `clm_resource: could not release ${found.record.name}.` }
  return { result: { name: found.record.name, status: 'released' } }
}

export async function unregisterResource(io: ResourceIo, name: string): Promise<{ result?: unknown; deny?: string }> {
  const found = await findMutex(io, name)
  if (!found) return { deny: `clm_resource: no mutex is registered as ${name}.` }
  const session = await io.sessionId()
  let owner = await ownerFor(io, found.path)
  if (owner && owner.session !== session) {
    if (await ownerAlive(io, owner)) return { deny: denial(owner) }
    if (!(await reclaimDeadOwner(io, found.record, found.path, owner))) return { deny: `clm_resource: could not reclaim ${found.record.name}.` }
    owner = undefined
  }
  let temporary = false
  if (!owner) {
    const identity = await identityFor(io, session)
    const currentTime = await now(io)
    const acquired = await run(io, ['mkdir', ownerPath(found.path)], { cwd: identity.cwd, timeoutMs: 1000 })
    if (acquired?.exitCode !== 0) return { deny: `clm_resource: ${found.record.name} was claimed while unregistering; retry.` }
    try {
      await io.write(ownerFile(found.path), JSON.stringify({ session, ...(identity.pid !== undefined ? { pid: identity.pid } : {}), cwd: identity.cwd, repo: identity.repo, since: iso(currentTime), heartbeat: currentTime } satisfies MutexOwner))
    } catch (err) {
      io.log(`clm resources: could not write unregister owner for ${found.record.name}: ${String(err).slice(0, 160)}`)
      await run(io, ['rm', '-rf', ownerPath(found.path)], { cwd: identity.cwd, timeoutMs: 1000 })
      return { deny: `clm_resource: could not unregister ${found.record.name}.` }
    }
    temporary = true
  }
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

export async function guardBash(io: ResourceIo, command: string): Promise<string | undefined> {
  const session = await io.sessionId()
  await ensureSessionIdentity(io, session, false)
  const folded = command.toLocaleLowerCase()
  let registered: { record: MutexRecord; path: string }[]
  try { registered = await listMutexRecords(io) }
  catch { return 'clm resources: mutex registry is unavailable; command denied.' }
  const found = registered.filter(({ record }) => [record.name, ...record.aliases].some(alias => alias && folded.includes(alias.toLocaleLowerCase())))
  const claimed: { record: MutexRecord; path: string }[] = []
  for (const item of found) {
    const result = await claimOne(io, session, item.record, item.path)
    if (result.status === 'denied') {
      for (const prior of claimed) await releaseOne(io, session, prior.record, prior.path, true)
      return result.owner ? denial(result.owner) : `clm resources: could not verify the owner of ${item.record.name}; command denied.`
    }
    if (result.status === 'claimed') claimed.push(item)
  }
  return undefined
}

export async function applyResourceAction(io: ResourceIo, input: ClmResourceInput): Promise<{ result?: unknown; deny?: string }> {
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

async function transferPending(io: ResourceIo, session: string, identity: ResourceIdentity) {
  const keys = (await io.keys()).filter(key => key.startsWith(RESOURCE_PREFIX) && key !== keyFor(session))
  const transfers: { source: string; state: ResourceSession }[] = []
  for (const key of keys) {
    const source = key.slice(RESOURCE_PREFIX.length)
    const state = await readSession(io, source)
    const prior = state.identity
    if (state.pendingTransfer && prior?.processPid !== undefined && prior.processPid === identity.processPid && prior.cwd === identity.cwd) transfers.push({ source, state })
  }
  if (!transfers.length) return
  await mutateSession(io, session, async current => {
    const owned = [...current.owned]
    const mutexes = [...current.mutexes]
    const changes = [...current.changes]
    const transferredFrom = new Set(current.transferredFrom ?? [])
    for (const { source, state } of transfers) {
      transferredFrom.add(source)
      for (const resource of state.owned) {
        if (owned.some(item => item.kind === resource.kind && item.id === resource.id)) continue
        owned.push(resource)
        changes.push(`transferred ${resource.kind} ${resource.label}`)
      }
      for (const name of state.mutexes) {
        const found = await findMutex(io, name)
        if (!found) continue
        const owner = await ownerFor(io, found.path)
        if (owner?.session !== source || owner.pid !== identity.pid || owner.cwd !== identity.cwd) continue
        if (!mutexes.some(item => normalized(item) === normalized(name))) mutexes.push(name)
        changes.push(`mutex ${name} held`)
        await io.write(ownerFile(found.path), JSON.stringify({ ...owner, session, pid: identity.pid, cwd: identity.cwd, repo: identity.repo, heartbeat: identity.heartbeat }))
      }
    }
    return { next: { ...current, owned, mutexes, changes, transferredFrom: [...transferredFrom] }, result: undefined }
  })
}

async function refreshOwnedLocks(io: ResourceIo, session: string, state: ResourceSession) {
  const identity = state.identity
  if (!identity) return
  for (const name of state.mutexes) {
    const found = await findMutex(io, name)
    if (!found) continue
    const owner = await ownerFor(io, found.path)
    if (owner?.session === session) await io.write(ownerFile(found.path), JSON.stringify({ ...owner, pid: identity.pid, cwd: identity.cwd, repo: identity.repo, heartbeat: identity.heartbeat }))
  }
}

export async function turnStartResources(io: ResourceIo) {
  const session = await io.sessionId()
  const state = await ensureSessionIdentity(io, session, true)
  if (state.identity) await transferPending(io, session, state.identity)
  await promoteResourceChanges(io, session)
  await refreshOwnedLocks(io, session, await readSession(io, session))
}

async function promoteResourceChanges(io: ResourceIo, session: string) {
  await mutateSession(io, session, current => {
    if (!current.changes.length) return { next: current, result: undefined }
    const changes = current.changes.join(', ')
    const notice = current.notice ? `${current.notice}; ${changes}` : `clm resources: ${changes}`
    return { next: { ...current, changes: [], notice }, result: undefined }
  })
}

export async function touchResources(io: ResourceIo) {
  const session = await io.sessionId()
  const state = await ensureSessionIdentity(io, session, false)
  await refreshOwnedLocks(io, session, state)
}

export async function consumeResourceNotice(io: ResourceIo): Promise<string | undefined> {
  const session = await io.sessionId()
  if (!(await readSession(io, session)).notice) return undefined
  const notice = await mutateSession(io, session, current => ({
    next: { ...current, notice: undefined },
    result: current.notice,
  }))
  return notice?.replace(/\s+/g, ' ').trim()
}

async function otherResourceReferences(io: ResourceIo, session: string, resource: OwnedResource): Promise<boolean> {
  const transferredFrom = new Set((await readSession(io, session)).transferredFrom ?? [])
  const keys = (await io.keys()).filter(key => key.startsWith(RESOURCE_PREFIX) && key !== keyFor(session))
  const others: { session: string; state: ResourceSession }[] = []
  for (const key of keys) {
    const otherSession = key.slice(RESOURCE_PREFIX.length)
    const other = asSession(await io.get(key))
    for (const source of other.transferredFrom ?? []) transferredFrom.add(source)
    others.push({ session: otherSession, state: other })
  }
  return others.some(other => !transferredFrom.has(other.session) && other.state.owned.some(item => item.id === resource.id))
}

function stopLog(io: ResourceIo, resource: OwnedResource, argv: readonly string[], result: ProcessResult | undefined) {
  io.log(`clm resources: stop ${resource.kind} ${resource.id} command=${JSON.stringify(argv)} exitCode=${result?.exitCode ?? 'unavailable'} stderr=${JSON.stringify(result?.stderr ?? '')}`)
}

async function stopOwned(io: ResourceIo, resource: OwnedResource, identity: ResourceIdentity): Promise<boolean> {
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
    const serials = [...devices.stdout.matchAll(/^\s*(emulator-\d+)\b/gm)].map(match => match[1]!)
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
  const lookup = ['lsof', '-ti', `tcp:${port}`]
  const found = await run(io, lookup, { cwd, timeoutMs: 1000 })
  if (!found) {
    stopLog(io, resource, lookup, found)
    return false
  }
  const pids = found.stdout.trim().split(/\s+/).filter(pid => /^\d+$/.test(pid))
  let stopped = true
  for (const pid of pids) {
    const argv = ['/bin/kill', pid]
    const result = await run(io, argv, { cwd, timeoutMs: 1000 })
    stopLog(io, resource, argv, result)
    if (result?.exitCode !== 0) stopped = false
  }
  if (!pids.length) io.log(`clm resources: stop ${resource.kind} ${resource.id}; no process is listening`)
  return stopped
}

export async function endResources(io: ResourceIo, session: string, reason: string): Promise<void> {
  if (reason === 'clear' || reason === 'resume') {
    await mutateSession(io, session, current => ({ next: { ...current, pendingTransfer: true }, result: undefined }))
    return
  }
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
  if (!remaining.mutexes.length && !remaining.owned.length && !remaining.transferredFrom?.length) await io.delete(keyFor(session))
}

function hasEndBudget(io: ResourceIo) {
  const remaining = io.budgetRemaining?.()
  return remaining === undefined || !Number.isFinite(remaining) || remaining >= 80
}

export function resourceLedgerLines(value: unknown): string[] {
  const state = asSession(value)
  return [
    ...state.owned.map(resource => `- ${resource.kind} ${resource.label}${normalized(resource.label.replace(/^:/, '')) === normalized(resource.id) ? '' : ` (${resource.id})`}`),
    ...state.mutexes.map(name => `- mutex ${name} held`),
  ]
}

type ResourceEngine = Pick<EngineInterface, 'session' | 'store' | 'env' | 'clock' | 'fs' | 'process' | 'ui'>
function resourceIo($: ResourceEngine, budget?: () => number): ResourceIo {
  return {
    sessionId: () => $.session.id(), home: () => $.env.get('HOME'), cwd: () => $.session.cwd(), repo: () => $.session.root(), now: () => $.clock.now(),
    keys: () => $.store.keys(), get: key => $.store.get(key), set: (key, value) => $.store.set(key, value), delete: key => $.store.delete(key),
    exists: path => $.fs.exists(path), list: async path => await $.fs.list(path), read: async path => { try { return await $.fs.read(path) } catch { return undefined } }, write: (path, value) => $.fs.write(path, value),
    run: (argv, options) => $.process.run(argv, options), log: text => $.ui.log(text, { to: 'debug' }), ...(budget ? { budgetRemaining: budget } : {}),
  }
}

const registerResources: Register = (on) => {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
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

  on('turn.start', { turnId: /.*/ }, async ($, e, next) => {
    try { await turnStartResources(resourceIo($)) }
    catch (err) { $.ui.log(`clm resources: turn.start failed (${String(err).slice(0, 160)})`, { to: 'debug' }) }
    return next(e)
  })

  on('tool.call', { tool: /.*/ }, async ($, e, next) => {
    try { await touchResources(resourceIo($)) }
    catch (err) { $.ui.log(`clm resources: heartbeat failed (${String(err).slice(0, 160)})`, { to: 'debug' }) }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const io = resourceIo($)
    let denied: string | undefined
    try { denied = await guardBash(io, e.command) }
    catch (err) {
      $.ui.log(`clm resources: mutex guard failed (${String(err).slice(0, 160)})`, { to: 'debug' })
      return { deny: 'clm resources: mutex registry check failed; command denied.' }
    }
    if (denied) return { deny: denied }
    const result = await next(e)
    try {
      const records = detectOwned(e.command, result, await io.cwd(), await io.now())
      await recordDetected(io, records)
    } catch (err) { $.ui.log(`clm resources: Bash result tracking failed (${String(err).slice(0, 160)})`, { to: 'debug' }) }
    return result
  })

  on('tool.call', { tool: RESOURCE_TOOL }, async ($, e) => {
    try {
      const outcome = await applyResourceAction(resourceIo($), e as unknown as ClmResourceInput)
      return outcome.deny ? { deny: outcome.deny } : { result: outcome.result }
    } catch (err) {
      $.ui.log(`clm resources: resource action failed (${String(err).slice(0, 160)})`, { to: 'debug' })
      return { deny: `clm_resource failed: ${String(err).slice(0, 160)}` }
    }
  })

  on('prompt.compose', { model: /.*/ }, async ($, e, next) => {
    const result = await next(e)
    try {
      const notice = await consumeResourceNotice(resourceIo($))
      return notice ? { ...result, sections: [...result.sections, { id: 'clm:resources', text: notice, scope: 'session' as const }] } : result
    } catch (err) {
      $.ui.log(`clm resources: prompt notice failed (${String(err).slice(0, 160)})`, { to: 'debug' })
      return result
    }
  })

  on('session.end', async ($, e, next) => {
    try { await endResources(resourceIo($, () => next.budget.remainingMs), e.sessionId, e.reason) }
    catch (err) { $.ui.log(`clm resources: session.end failed (${String(err).slice(0, 160)})`, { to: 'debug' }) }
    return next(e)
  })
}

export const register: Register = (on, options) => {
  registerClm(on, options)
  registerResources(on, options)
}
