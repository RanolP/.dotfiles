export const DEFAULT_COWORKER_TTL_MS = 60_000

export type CoworkerRecord = {
  session: string
  main: string
  role: 'main' | 'coworker'
  repo: string
  state: 'starting' | 'idle' | 'busy'
  issue?: string
  heartbeat: number
  mux?: string
  maxCoworkers?: number
  peer?: string
}

export type SpawnBackoff = { failures: number; lastFailedAt?: number }

export type CoworkerIssue = {
  id: string
  status: string
  ready?: boolean
  priority?: number
  claimedBy?: string
  repo: string
  createdAt: number | string
}

export type CoworkerIo = {
  root?: string
  ttlMs?: number
  random?: () => string
  home?: () => Promise<string | undefined>
  read: (path: string) => Promise<string | undefined>
  write: (path: string, value: string) => Promise<void>
  list: (path: string) => Promise<{ name: string; kind: string }[]>
  run: (argv: readonly string[], options?: { cwd?: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

const run = (io: CoworkerIo, argv: readonly string[]) => io.run(argv, { timeoutMs: 1_000 })
const nonce = (io: CoworkerIo) => io.random?.() ?? Math.random().toString(36).slice(2, 10)
const safeSegment = (value: string, label: string) => {
  if (!value || value === '.' || value === '..' || /[\u0000-\u001f\u007f/\\]/.test(value)) throw new Error(`invalid ${label}: ${JSON.stringify(value)}`)
  return value
}
const rootFor = async (io: CoworkerIo) => {
  if (io.root) return io.root.replace(/\/$/, '')
  const home = await io.home?.()
  if (!home) throw new Error('HOME is unset; co-worker state needs a shared host directory')
  return `${home.replace(/\/$/, '')}/.claude-work/clm`
}
const parse = (value: string | undefined): unknown => {
  if (!value) return undefined
  try { return JSON.parse(value) } catch { return undefined }
}
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const isCoworkerRecord = (value: unknown): value is CoworkerRecord => isRecord(value)
  && typeof value.session === 'string' && typeof value.main === 'string' && typeof value.repo === 'string'
  && (value.role === 'main' || value.role === 'coworker')
  && (value.state === 'starting' || value.state === 'idle' || value.state === 'busy')
  && typeof value.heartbeat === 'number'
  && (value.issue === undefined || typeof value.issue === 'string')
  && (value.mux === undefined || typeof value.mux === 'string')
  && (value.maxCoworkers === undefined || typeof value.maxCoworkers === 'number')
  && (value.peer === undefined || typeof value.peer === 'string')
const claimOwner = (value: unknown): string | undefined => isRecord(value) && typeof value.session === 'string' ? value.session : undefined
const isSpawnBackoff = (value: unknown): value is SpawnBackoff => isRecord(value)
  && Number.isInteger(value.failures) && typeof value.failures === 'number' && value.failures >= 0
  && (value.lastFailedAt === undefined || typeof value.lastFailedAt === 'number')

export function isLive(record: CoworkerRecord, now: number, ttlMs: number): boolean {
  return now - record.heartbeat <= ttlMs
}

export async function writeCoworker(io: CoworkerIo, record: CoworkerRecord): Promise<void> {
  const root = await rootFor(io)
  const session = safeSegment(record.session, 'session')
  const dir = `${root}/coworkers`
  await run(io, ['mkdir', '-p', dir])
  const target = `${dir}/${session}.json`
  const temporary = `${dir}/.${session}-${record.heartbeat.toString(36)}-${nonce(io)}.tmp`
  await io.write(temporary, JSON.stringify(record))
  const moved = await run(io, ['mv', temporary, target])
  if (moved.exitCode !== 0) {
    await run(io, ['rm', '-f', temporary])
    throw new Error(`could not publish co-worker record for ${session}: ${moved.stderr}`)
  }
}

export async function readCoworkers(io: CoworkerIo): Promise<CoworkerRecord[]> {
  const root = await rootFor(io)
  const dir = `${root}/coworkers`
  const records: CoworkerRecord[] = []
  for (const entry of (await io.list(dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
    const record = parse(await io.read(`${dir}/${entry.name}`))
    if (isCoworkerRecord(record)) records.push(record)
  }
  return records
}

export async function readSpawnBackoff(io: CoworkerIo, main: string): Promise<SpawnBackoff> {
  const root = await rootFor(io)
  const value = parse(await io.read(`${root}/coworkers/${safeSegment(main, 'main session')}.spawn-backoff.json`))
  return isSpawnBackoff(value) ? value : { failures: 0 }
}

export async function writeSpawnBackoff(io: CoworkerIo, main: string, backoff: SpawnBackoff): Promise<void> {
  const root = await rootFor(io)
  const session = safeSegment(main, 'main session')
  const dir = `${root}/coworkers`
  await run(io, ['mkdir', '-p', dir])
  const target = `${dir}/${session}.spawn-backoff.json`
  const temporary = `${dir}/.${session}-spawn-backoff-${nonce(io)}.tmp`
  await io.write(temporary, JSON.stringify(backoff))
  const moved = await run(io, ['mv', temporary, target])
  if (moved.exitCode !== 0) {
    await run(io, ['rm', '-f', temporary])
    throw new Error(`could not publish spawn backoff for ${session}: ${moved.stderr}`)
  }
}

async function coworkerFor(io: CoworkerIo, session: string): Promise<CoworkerRecord | undefined> {
  const root = await rootFor(io)
  const record = parse(await io.read(`${root}/coworkers/${safeSegment(session, 'session')}.json`))
  return isCoworkerRecord(record) ? record : undefined
}

export async function claimIssue(io: CoworkerIo, input: { issueId: string; session: string; now: number; ttlMs?: number }): Promise<{ claimed: true } | { claimed: false; owner: string }> {
  const root = await rootFor(io)
  const issueId = safeSegment(input.issueId, 'issueId')
  const session = safeSegment(input.session, 'session')
  const claims = `${root}/claims`
  const claim = `${claims}/${issueId}.json`
  await run(io, ['mkdir', '-p', claims])
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = `${claims}/.${issueId}-${nonce(io)}.json`
    await io.write(temporary, JSON.stringify({ session }))
    const created = await run(io, ['ln', temporary, claim])
    await run(io, ['rm', '-f', temporary])
    if (created.exitCode === 0) return { claimed: true }
    const owner = claimOwner(parse(await io.read(claim)))
    if (owner === session) return { claimed: true }
    if (!owner) return { claimed: false, owner: 'unknown' }
    const record = owner ? await coworkerFor(io, owner) : undefined
    const live = record && isLive(record, input.now, input.ttlMs ?? io.ttlMs ?? DEFAULT_COWORKER_TTL_MS)
    if (live) return { claimed: false, owner }
    const stale = `${claims}/.${issueId}-stale-${input.now.toString(36)}-${nonce(io)}.json`
    if ((await run(io, ['mv', claim, stale])).exitCode !== 0) continue
    const movedOwner = claimOwner(parse(await io.read(stale)))
    if (movedOwner !== owner) {
      await run(io, ['ln', stale, claim])
      await run(io, ['rm', '-f', stale])
      return { claimed: false, owner: movedOwner ?? 'unknown' }
    }
    await run(io, ['rm', '-f', stale])
  }
  const owner = claimOwner(parse(await io.read(claim)))
  return { claimed: false, owner: owner ?? 'unknown' }
}

async function removeClaim(io: CoworkerIo, issueId: string, expectedOwner?: string): Promise<boolean> {
  const root = await rootFor(io)
  const issue = safeSegment(issueId, 'issueId')
  const claim = `${root}/claims/${issue}.json`
  if (expectedOwner) {
    const owner = claimOwner(parse(await io.read(claim)))
    if (owner !== expectedOwner) return false
  }
  const removed = `${root}/claims/.${issue}-removed-${nonce(io)}.json`
  if ((await run(io, ['mv', claim, removed])).exitCode !== 0) return false
  await run(io, ['rm', '-f', removed])
  return true
}

export async function releaseClaim(io: CoworkerIo, issueId: string, session: string): Promise<boolean> {
  return removeClaim(io, issueId, safeSegment(session, 'session'))
}

export async function revokeClaim(io: CoworkerIo, issueId: string): Promise<boolean> {
  return removeClaim(io, issueId)
}

const createdTime = (value: number | string) => typeof value === 'number' ? value : Date.parse(value)

export function pickNext<T extends CoworkerIssue>(issues: readonly T[], repo: string): T | undefined {
  return issues.filter(issue => issue.status === 'todo' && issue.ready === true && !issue.claimedBy && issue.repo === repo)
    .sort((left, right) => (right.priority ?? Number.NEGATIVE_INFINITY) - (left.priority ?? Number.NEGATIVE_INFINITY)
      || createdTime(left.createdAt) - createdTime(right.createdAt))[0]
}

export function shouldSpawn(input: {
  issues: readonly CoworkerIssue[]
  coworkers: readonly CoworkerRecord[]
  repo: string
  main: string
  load1: number
  cores: number
  maxCoworkers?: number
  backoff?: SpawnBackoff
  now: number
  ttlMs: number
}): boolean {
  if (!pickNext(input.issues, input.repo) || input.load1 >= 0.75 * input.cores) return false
  if (input.backoff?.failures && input.backoff.lastFailedAt !== undefined
    && input.now - input.backoff.lastFailedAt < Math.min(2 ** Math.min(input.backoff.failures, 6), 60) * 60_000) return false
  const live = input.coworkers.filter(record => record.role === 'coworker' && record.main === input.main && isLive(record, input.now, input.ttlMs))
  return live.length < (input.maxCoworkers ?? 2) && !live.some(record => record.state === 'idle' || record.state === 'starting')
}
