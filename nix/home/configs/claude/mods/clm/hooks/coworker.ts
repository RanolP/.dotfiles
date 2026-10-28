export const DEFAULT_COWORKER_TTL_MS = 60_000

export type CoworkerRecord = {
  session: string
  main: string
  repo: string
  state: 'starting' | 'idle' | 'busy'
  issue?: string
  heartbeat: number
  mux?: string
}

export type CoworkerIssue = {
  id: string
  status: string
  ready?: boolean
  priority?: number
  claimedBy?: string
  repo: string
  createdAt: number | string
}

export type CoworkerMail = { from: string; to: string; text: string; now: number }
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
const parse = <T>(value: string | undefined): T | undefined => {
  if (!value) return undefined
  try { return JSON.parse(value) as T } catch { return undefined }
}

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
    const record = parse<CoworkerRecord>(await io.read(`${dir}/${entry.name}`))
    if (record && typeof record.session === 'string' && typeof record.heartbeat === 'number') records.push(record)
  }
  return records
}

async function coworkerFor(io: CoworkerIo, session: string): Promise<CoworkerRecord | undefined> {
  const root = await rootFor(io)
  return parse<CoworkerRecord>(await io.read(`${root}/coworkers/${safeSegment(session, 'session')}.json`))
}

export async function claimIssue(io: CoworkerIo, input: { issueId: string; session: string; now: number; ttlMs?: number }): Promise<{ claimed: true } | { claimed: false; owner: string }> {
  const root = await rootFor(io)
  const issueId = safeSegment(input.issueId, 'issueId')
  const session = safeSegment(input.session, 'session')
  const claims = `${root}/claims`
  const claim = `${claims}/${issueId}`
  await run(io, ['mkdir', '-p', claims])
  for (let attempt = 0; attempt < 3; attempt++) {
    const created = await run(io, ['mkdir', claim])
    if (created.exitCode === 0) {
      try {
        await io.write(`${claim}/owner.json`, JSON.stringify({ session }))
        return { claimed: true }
      } catch (error) {
        await run(io, ['rm', '-rf', claim])
        throw error
      }
    }
    const owner = parse<{ session?: string }>(await io.read(`${claim}/owner.json`))?.session
    if (owner === session) return { claimed: true }
    const record = owner ? await coworkerFor(io, owner) : undefined
    const live = record && isLive(record, input.now, input.ttlMs ?? io.ttlMs ?? DEFAULT_COWORKER_TTL_MS)
    if (owner && live) return { claimed: false, owner }
    const stale = `${claims}/.${issueId}-stale-${input.now.toString(36)}-${nonce(io)}`
    if ((await run(io, ['mv', claim, stale])).exitCode !== 0) continue
    await run(io, ['rm', '-rf', stale])
  }
  const owner = parse<{ session?: string }>(await io.read(`${claim}/owner.json`))?.session
  return { claimed: false, owner: owner ?? 'unknown' }
}

async function removeClaim(io: CoworkerIo, issueId: string, expectedOwner?: string): Promise<boolean> {
  const root = await rootFor(io)
  const issue = safeSegment(issueId, 'issueId')
  const claim = `${root}/claims/${issue}`
  if (expectedOwner) {
    const owner = parse<{ session?: string }>(await io.read(`${claim}/owner.json`))?.session
    if (owner !== expectedOwner) return false
  }
  const removed = `${root}/claims/.${issue}-removed-${nonce(io)}`
  if ((await run(io, ['mv', claim, removed])).exitCode !== 0) return false
  await run(io, ['rm', '-rf', removed])
  return true
}

export async function releaseClaim(io: CoworkerIo, issueId: string, session: string): Promise<boolean> {
  return removeClaim(io, issueId, safeSegment(session, 'session'))
}

export async function revokeClaim(io: CoworkerIo, issueId: string): Promise<boolean> {
  return removeClaim(io, issueId)
}

export async function sendMail(io: CoworkerIo, message: CoworkerMail): Promise<void> {
  const root = await rootFor(io)
  const to = safeSegment(message.to, 'mail recipient')
  const dir = `${root}/mail/${to}`
  await run(io, ['mkdir', '-p', dir])
  const id = nonce(io)
  const name = `${String(message.now).padStart(16, '0')}-${id}.json`
  const temporary = `${dir}/.${name}.tmp`
  await io.write(temporary, JSON.stringify(message))
  const moved = await run(io, ['mv', temporary, `${dir}/${name}`])
  if (moved.exitCode !== 0) {
    await run(io, ['rm', '-f', temporary])
    throw new Error(`could not send mail to ${to}: ${moved.stderr}`)
  }
}

export async function sendMailToMany(io: CoworkerIo, input: { from: string; to: readonly string[]; text: string; now: number }): Promise<void> {
  await Promise.all(input.to.map(to => sendMail(io, { from: input.from, to, text: input.text, now: input.now })))
}

export async function drainMail(io: CoworkerIo, session: string): Promise<CoworkerMail[]> {
  const root = await rootFor(io)
  const dir = `${root}/mail/${safeSegment(session, 'session')}`
  const messages: CoworkerMail[] = []
  const entries = (await io.list(dir)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`
    const contents = await io.read(path)
    await run(io, ['rm', '-f', path])
    const message = parse<CoworkerMail>(contents)
    if (message) messages.push(message)
  }
  return messages
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
  now: number
  ttlMs: number
}): boolean {
  if (!pickNext(input.issues, input.repo) || input.load1 >= 0.75 * input.cores) return false
  const live = input.coworkers.filter(record => record.main === input.main && isLive(record, input.now, input.ttlMs))
  return live.length < (input.maxCoworkers ?? 2) && !live.some(record => record.state === 'idle' || record.state === 'starting')
}
