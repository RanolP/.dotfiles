import type { EngineInterface, Register } from 'claude-code'
import type { ClmCoworkerInput } from '../types'
import { append as appendEvents, captureOrigin, readAll, type EventsIo } from './events'
import {
  DEFAULT_COWORKER_TTL_MS, claimIssue, isLive, pickNext, readCoworkers, readSpawnBackoff, releaseClaim, revokeClaim,
  shouldSpawn, writeCoworker, writeSpawnBackoff, type CoworkerIo, type CoworkerRecord,
} from './coworker'
import { coworkerBrief, detectMux, launchPlan, readLoad } from './spawn'
import { snapshot, type Issue, type Origin, type Payload } from './tracker'
import type { PromptIntentIo } from './intent'
import { checkpointCommit, removeWorktree, startWorktree, type Worktree, type WorktreeIo } from './worktree'

export const COWORKER_TOOL = 'mcp__clm__clm_coworker'
const POLL_MS = 5_000
const DEFAULT_MAX_COWORKERS = 2
// A new Herdr pane measured available within 0.5 s of `tab create`; 20 tries 250 ms apart allow 5 s.
const LAUNCH_RETRIES = 20
const LAUNCH_RETRY_MS = 250

type RuntimeRole = { isCoworker: boolean; session: string; main: string; repo: string; repoRoot: string; placeholder?: string }

const roles = new Map<string, RuntimeRole>()
const timers = new Map<string, { cancel: () => void }[]>()
const intents = new Map<string, Pick<PromptIntentIo, 'isCoworker' | 'announce'>>()
const localRecords = new Map<string, CoworkerRecord>()
const registryWrites = new Map<string, Promise<void>>()
const ticksInFlight = new Set<string>()
// Per main session: the `<co-worker>:<issue>` claim request last sent, so the 5 s poll does not repeat it every tick.
const claimRequests = new Map<string, string>()

const optionalRead = async ($: EngineInterface, path: string) => {
  try { return (await $.fs.exists(path)) ? await $.fs.read(path) : undefined } catch { return undefined }
}

// The hook delivers every hand-off itself through `$.session.send`, addressed by the recipient's registry session id.
const notify = async ($: EngineInterface, session: string, text: string): Promise<boolean> => {
  try {
    const sent = await $.session.send({ to: { sessionId: session }, text })
    if (sent.isDelivered) return true
    $.ui.log(`clm co-worker message to ${session} not delivered: ${sent.reason}`)
  } catch (error) { $.ui.log(`clm co-worker message to ${session} failed: ${String(error).slice(0, 160)}`) }
  return false
}

const notified = async ($: EngineInterface, session: string, text: string) =>
  await notify($, session, text) ? `${session} was notified.` : `${session} could not be notified.`

// /clear gives main a new session id under the same stable main id, so the newest live main record is the one to address.
const liveMainSession = (records: readonly CoworkerRecord[], main: string, now: number) => records
  .filter(record => record.role === 'main' && record.main === main && isLive(record, now, DEFAULT_COWORKER_TTL_MS))
  .sort((left, right) => right.heartbeat - left.heartbeat)[0]?.session

const notifyMain = async ($: EngineInterface, role: RuntimeRole, text: string) => {
  const session = liveMainSession(await readCoworkers(runtimeIo($)), role.main, await $.clock.now())
  if (session) return notified($, session, text)
  $.ui.log(`clm co-worker message to main ${role.main} not delivered: no live main session`)
  return `Main ${role.main} has no live session to notify.`
}

const runtimeIo = ($: EngineInterface): CoworkerIo => ({
  home: () => $.env.get('HOME'),
  read: path => optionalRead($, path),
  write: (path, value) => $.fs.write(path, value),
  list: async path => {
    try { return (await $.fs.exists(path)) ? await $.fs.list(path) : [] } catch { return [] }
  },
  run: (argv, options) => $.process.run([...argv], options),
})

const trackerIo = ($: EngineInterface): EventsIo => ({
  sessionId: () => $.session.id(),
  cwd: () => $.session.cwd(),
  run: (argv, options) => $.process.run(argv, options),
  exists: path => $.fs.exists(path),
  list: path => $.fs.list(path),
  read: path => $.fs.read(path),
  write: (path, value) => $.fs.write(path, value),
  log: (text, options) => $.ui.log(text, options),
  trackerDirectory: async () => `${(await $.env.get('HOME')) ?? '.'}/.claude-work/tracker/events`,
  trackerLogPath: async session => `${(await $.env.get('HOME')) ?? '.'}/.claude-work/tracker/events/${session}.jsonl`,
  generalLogPath: async () => `${(await $.env.get('HOME')) ?? '.'}/.claude-work/plans/clm-${await $.session.id()}.log.jsonl`,
  project: async () => undefined,
})

const worktreeIo = ($: EngineInterface): WorktreeIo => ({
  home: () => $.env.get('HOME'),
  run: (argv, options) => $.process.run([...argv], options),
})

const append = ($: EngineInterface, payloads: readonly Payload[], origin?: Origin) =>
  appendEvents(trackerIo($), payloads, origin, false)

const currentRole = async ($: EngineInterface, stableMain?: string): Promise<RuntimeRole> => {
  const session = await $.session.id()
  const known = roles.get(session)
  if (known) return known
  const isCoworker = await $.env.get('CLM_COWORKER') === '1'
  const main = isCoworker ? (await $.env.get('CLM_MAIN_SESSION'))?.trim() : stableMain ?? session
  if (!main) throw new Error('CLM_MAIN_SESSION is required when CLM_COWORKER=1')
  const origin = await captureOrigin(trackerIo($))
  const root = await $.process.run(['git', '-C', origin.cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 5_000 })
  if (root.exitCode !== 0 || !root.stdout.trim()) throw new Error(`could not resolve repository root: ${root.stderr.trim()}`)
  const placeholder = isCoworker ? (await $.env.get('CLM_COWORKER_NAME'))?.trim() : undefined
  const role = { isCoworker, session, main, repo: origin.repo, repoRoot: root.stdout.trim(), ...(placeholder ? { placeholder } : {}) }
  roles.set(session, role)
  return role
}

const updateRegistry = async ($: EngineInterface, role: RuntimeRole, update: Partial<CoworkerRecord> = {}): Promise<void> => {
  const now = await $.clock.now()
  const existing = localRecords.get(role.session)
  const record: CoworkerRecord = {
    session: role.session, main: role.main, role: role.isCoworker ? 'coworker' : 'main', repo: role.repo, state: existing?.state ?? 'idle', heartbeat: now,
    ...(existing?.issue ? { issue: existing.issue } : {}), ...(existing?.mux ? { mux: existing.mux } : {}),
    ...(role.session === role.main && existing?.maxCoworkers !== undefined ? { maxCoworkers: existing.maxCoworkers } : {}), ...update,
  }
  if (update.issue === undefined && 'issue' in update) delete record.issue
  localRecords.set(role.session, record)
  const previous = registryWrites.get(role.session) ?? Promise.resolve()
  const write = previous.catch(() => undefined).then(() => writeCoworker(runtimeIo($), record))
  registryWrites.set(role.session, write)
  await write
}

const updateMainRegistry = async ($: EngineInterface, role: RuntimeRole, maxCoworkers: number): Promise<void> => {
  if (role.session === role.main) return updateRegistry($, role, { maxCoworkers })
  const existing = (await readCoworkers(runtimeIo($))).find(record => record.role === 'main' && record.session === role.main)
  await writeCoworker(runtimeIo($), {
    session: role.main, main: role.main, role: 'main', repo: role.repo,
    state: existing?.state ?? 'idle', heartbeat: existing?.heartbeat ?? await $.clock.now(),
    maxCoworkers,
  })
}

const issuesForRepo = async ($: EngineInterface, role: RuntimeRole) =>
  snapshot(await readAll(trackerIo($))).filter(issue => issue.origin.repo === role.repo)

const issueById = (issues: readonly Issue[], id: string | undefined): Issue => {
  if (!id) throw new Error('issue is required for this action')
  const issue = issues.find(item => item.id === id)
  if (!issue) throw new Error(`issue ${id} is not on this repository's clm board`)
  return issue
}

const selectableIssue = (issue: Issue) => ({
  id: issue.id,
  status: issue.status,
  ready: issue.ready,
  priority: issue.priority,
  claimedBy: issue.claimedBy,
  repo: issue.origin.repo,
  createdAt: issue.updated,
})

const requireCoworker = (role: RuntimeRole) => {
  if (!role.isCoworker) throw new Error('this action is available only in a clm co-worker session')
}

const requireMain = (role: RuntimeRole) => {
  if (role.isCoworker) throw new Error('this action is available only in the main clm session')
}

const git = ($: EngineInterface, cwd: string, args: readonly string[]) =>
  $.process.run(['git', '-C', cwd, ...args], { timeoutMs: 30_000 })

const checkedGit = async ($: EngineInterface, cwd: string, args: readonly string[]) => {
  const result = await git($, cwd, args)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

const worktreePayload = (issue: string, worktree: Worktree): Payload => ({ op: 'worktree', issue, ...worktree })

const claim = async ($: EngineInterface, role: RuntimeRole, requested?: string) => {
  requireCoworker(role)
  const issues = await issuesForRepo($, role)
  const selected = requested ? undefined : pickNext(issues.map(selectableIssue), role.repo)
  const issue = requested ? issueById(issues, requested) : selected ? issueById(issues, selected.id) : undefined
  if (!issue) throw new Error('no ready unclaimed issue is available for this repository')
  if (issue.status !== 'todo' || issue.ready !== true || issue.claimedBy) throw new Error(`issue ${issue.id} is not ready and unclaimed`)
  const lock = await claimIssue(runtimeIo($), { issueId: issue.id, session: role.session, now: await $.clock.now() })
  if (!lock.claimed) throw new Error(`issue ${issue.id} is already claimed by ${lock.owner}`)
  try {
    const origin = await captureOrigin(trackerIo($))
    const worktree = issue.worktree ?? await startWorktree(worktreeIo($), { repoRoot: role.repoRoot, sessionId: role.session, goalId: issue.id })
    await append($, [
      { op: 'claim', issue: issue.id, by: role.session }, { op: 'link', issue: issue.id }, { op: 'status', issue: issue.id, status: 'doing' },
      ...(issue.worktree ? [] : [worktreePayload(issue.id, worktree)]),
    ], origin)
    await updateRegistry($, role, { state: 'busy', issue: issue.id })
    return `Claimed ${issue.id} (${issue.title}). Work only in ${worktree.dir}.`
  } catch (error) {
    await releaseClaim(runtimeIo($), issue.id, role.session)
    throw error
  }
}

const ready = async ($: EngineInterface, role: RuntimeRole, issueId?: string) => {
  requireCoworker(role)
  const issue = issueById(await issuesForRepo($, role), issueId)
  if (issue.claimedBy !== role.session || !issue.worktree) throw new Error(`issue ${issue.id} is not claimed by this co-worker with a recorded worktree`)
  const headSha = await checkpointCommit(worktreeIo($), issue.worktree, issue.title)
  const baseSha = await checkedGit($, issue.worktree.dir, ['merge-base', 'HEAD', issue.worktree.originBranch])
  const worktree = { ...issue.worktree, baseSha, headSha }
  await append($, [worktreePayload(issue.id, worktree), { op: 'checkpoint', issue: issue.id, sha: headSha }, { op: 'status', issue: issue.id, status: 'ready-to-land' }])
  await updateRegistry($, role, { state: 'idle', issue: undefined })
  return `${issue.id} is ready to land at ${baseSha}..${headSha}. ${await notifyMain($, role, `${issue.id} is ready to land (${baseSha}..${headSha}).`)}`
}

const release = async ($: EngineInterface, role: RuntimeRole, issueId?: string) => {
  requireCoworker(role)
  const issue = issueById(await issuesForRepo($, role), issueId)
  if (!await releaseClaim(runtimeIo($), issue.id, role.session)) throw new Error(`issue ${issue.id} is not claimed by ${role.session}`)
  await append($, [{ op: 'claim', issue: issue.id, by: null }, { op: 'status', issue: issue.id, status: 'todo' }])
  await updateRegistry($, role, { state: 'idle', issue: undefined })
  return `Released ${issue.id}; its worktree remains attached to the issue.`
}

const plan = async ($: EngineInterface, role: RuntimeRole, input: ClmCoworkerInput) => {
  requireMain(role)
  const issue = issueById(await issuesForRepo($, role), input.issue)
  if (input.priority === undefined && input.ready === undefined && input.maxCoworkers === undefined)
    throw new Error('plan requires priority, ready, or maxCoworkers')
  if (input.maxCoworkers !== undefined && (!Number.isInteger(input.maxCoworkers) || input.maxCoworkers < 1)) throw new Error('maxCoworkers must be a positive integer')
  if (input.priority !== undefined && !Number.isInteger(input.priority)) throw new Error('priority must be an integer')
  if (input.priority !== undefined || input.ready !== undefined)
    await append($, [{ op: 'plan', issue: issue.id, ...(input.priority === undefined ? {} : { priority: input.priority }), ...(input.ready === undefined ? {} : { ready: input.ready }) }])
  if (input.maxCoworkers !== undefined) await updateMainRegistry($, role, input.maxCoworkers)
  const dispatched = input.ready === true ? await dispatchReadyWork($, role) : undefined
  return `Planned ${issue.id}: priority=${input.priority ?? issue.priority ?? 'unset'}, ready=${input.ready ?? issue.ready ?? false}, maxCoworkers=${input.maxCoworkers ?? await readMaxCoworkers($, role)}.${dispatched ? ` ${dispatched}` : ''}`
}

const revoke = async ($: EngineInterface, role: RuntimeRole, input: ClmCoworkerInput) => {
  requireMain(role)
  const issue = issueById(await issuesForRepo($, role), input.issue)
  const old = issue.claimedBy
  await revokeClaim(runtimeIo($), issue.id)
  await append($, [{ op: 'claim', issue: issue.id, by: null }, { op: 'status', issue: issue.id, status: 'todo' }])
  const notices = [
    ...(old ? [await notified($, old, `Your claim on ${issue.id} was revoked. Keep its worktree unchanged until it is reassigned.`)] : []),
    ...(input.to ? [await notified($, input.to, `Claim ${issue.id} with clm_coworker; its existing worktree remains attached to the issue.`)] : []),
  ]
  const dispatched = await dispatchReadyWork($, role)
  return [`Revoked ${issue.id}${old ? ` from ${old}` : ''}.`, ...notices, ...(dispatched ? [dispatched] : [])].join(' ')
}

const abortCherryPick = async ($: EngineInterface, repoRoot: string) => {
  const aborted = await git($, repoRoot, ['cherry-pick', '--abort'])
  if (aborted.exitCode !== 0) await checkedGit($, repoRoot, ['reset', '--merge'])
}

const land = async ($: EngineInterface, role: RuntimeRole, issueId?: string) => {
  requireMain(role)
  const issue = issueById(await issuesForRepo($, role), issueId)
  if (issue.status !== 'ready-to-land' || !issue.worktree || !issue.claimedBy) throw new Error(`issue ${issue.id} is not ready-to-land with a claimant and worktree`)
  const dirty = await checkedGit($, role.repoRoot, ['status', '--porcelain'])
  if (dirty) throw new Error(`dirty checkout: commit or clear the main checkout before landing ${issue.id}`)
  const range = `${issue.worktree.baseSha}..${issue.worktree.headSha}`
  const cherryPick = await git($, role.repoRoot, ['cherry-pick', '--no-commit', range])
  if (cherryPick.exitCode !== 0) {
    await abortCherryPick($, role.repoRoot)
    await append($, [{ op: 'status', issue: issue.id, status: 'doing' }])
    const mainHead = await checkedGit($, role.repoRoot, ['rev-parse', 'HEAD'])
    return `Landing ${issue.id} conflicted and the cherry-pick was aborted; ${issue.claimedBy} was asked to rebase onto ${mainHead}. ${await notified($, issue.claimedBy, `Landing ${issue.id} conflicted at main HEAD ${mainHead}. Rebase the issue worktree onto ${mainHead}, resolve it, and call clm_coworker ready again.`)}`
  }
  await append($, [{ op: 'status', issue: issue.id, status: 'done' }, { op: 'claim', issue: issue.id, by: null }, { op: 'land', issue: issue.id }])
  await revokeClaim(runtimeIo($), issue.id)
  const removed = await (async () => {
    try { await removeWorktree(worktreeIo($), issue.worktree); return true }
    catch (error) { $.ui.log(`clm co-worker worktree cleanup failed for ${issue.id}: ${String(error).slice(0, 160)}`); return false }
  })()
  const landedNotice = await notified($, issue.claimedBy, `${issue.id} landed successfully; its worktree ${removed ? 'was removed' : 'still needs cleanup'}.`)
  const dispatched = await dispatchReadyWork($, role)
  return `Landed ${issue.id}. Its changes are staged in ${role.repoRoot}; commit them with the repository's own subject format after final verification. ${landedNotice}${dispatched ? ` ${dispatched}` : ''}`
}

const list = async ($: EngineInterface, role: RuntimeRole) => {
  const now = await $.clock.now()
  const records = await readCoworkers(runtimeIo($))
  const coworkers = records.filter(record => record.role === 'coworker' && record.main === role.main)
  const issues = await issuesForRepo($, role)
  return [
    `Main ${role.main}: live session ${liveMainSession(records, role.main, now) ?? 'none'}`,
    'Co-workers:',
    ...(coworkers.length ? coworkers.map(record => `- ${record.session}: ${isLive(record, now, DEFAULT_COWORKER_TTL_MS) ? 'live' : 'stale'}, ${record.state}${record.issue ? `, issue ${record.issue}` : ''}`) : ['- none']),
    'Board:',
    ...(issues.length ? issues.map(issue => `- ${issue.id}: ${issue.status}, priority=${issue.priority ?? 'unset'}, ready=${issue.ready ?? false}, claimant=${issue.claimedBy ?? 'none'} — ${issue.title}`) : ['- none']),
  ].join('\n')
}

const readMaxCoworkers = async ($: EngineInterface, role: RuntimeRole) => {
  const records = await readCoworkers(runtimeIo($))
  return records.find(record => record.session === role.main)?.maxCoworkers ?? DEFAULT_MAX_COWORKERS
}

const removeRegistry = async ($: EngineInterface, session: string) => {
  const home = (await $.env.get('HOME')) ?? '.'
  await $.process.run(['rm', '-f', `${home}/.claude-work/clm/coworkers/${session}.json`], { timeoutMs: 1_000 })
}

const recordSpawnFailure = async ($: EngineInterface, role: RuntimeRole, now: number) => {
  const current = await readSpawnBackoff(runtimeIo($), role.main)
  await writeSpawnBackoff(runtimeIo($), role.main, { failures: current.failures + 1, lastFailedAt: now })
}

const launchCoworker = async ($: EngineInterface, role: RuntimeRole, records: readonly CoworkerRecord[]) => {
  const env = {
    HERDR_SOCKET_PATH: await $.env.get('HERDR_SOCKET_PATH'), HERDR_ENV: await $.env.get('HERDR_ENV'),
    HERDR_WORKSPACE_ID: await $.env.get('HERDR_WORKSPACE_ID'),
    ZELLIJ: await $.env.get('ZELLIJ'), TMUX: await $.env.get('TMUX'),
  }
  const mux = detectMux(env)
  const used = new Set(records.map(record => record.session))
  let index = 1
  while (used.has(`clm-coworker-${index}`)) index += 1
  const name = `clm-coworker-${index}`
  await writeCoworker(runtimeIo($), { session: name, main: role.main, role: 'coworker', repo: role.repo, state: 'starting', heartbeat: await $.clock.now(), mux })
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  const launch = launchPlan({ mux, cwd: role.repoRoot, name, env: { CLM_COWORKER: '1', CLM_MAIN_SESSION: role.main, CLM_COWORKER_NAME: name, ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}) }, brief: coworkerBrief({ main: role.main, repo: role.repoRoot }), herdrWorkspaceId: env.HERDR_WORKSPACE_ID })
  if ('manual' in launch) {
    $.ui.log(`clm co-worker launch unavailable: mux=none command=${launch.manual} exitCode=unavailable stderr=${JSON.stringify('no supported multiplexer detected')}`, { to: 'debug' })
    await removeRegistry($, name)
    return
  }
  // A step that created something (a Herdr tab) registers its undo, so a later failure leaves no orphan behind for the next spawn to duplicate.
  const undo: (() => readonly string[])[] = []
  const fail = async (detail: string) => {
    $.ui.log(`clm co-worker launch failed: ${detail}`, { to: 'debug' })
    for (const undoArgv of undo.reverse()) {
      let argv: readonly string[]
      try { argv = undoArgv() } catch (error) {
        $.ui.log(`clm co-worker launch cleanup impossible: ${JSON.stringify(String(error).slice(0, 400))}`, { to: 'debug' })
        continue
      }
      const closed = await $.process.run([...argv], { cwd: role.repoRoot, timeoutMs: 10_000 }).catch(error => ({ exitCode: -1, stdout: '', stderr: String(error) }))
      if (closed.exitCode !== 0) $.ui.log(`clm co-worker launch cleanup failed: command=${JSON.stringify(argv)} exitCode=${closed.exitCode} stdout=${JSON.stringify(closed.stdout.slice(0, 400))} stderr=${JSON.stringify(closed.stderr.slice(0, 400))}`, { to: 'debug' })
    }
    await removeRegistry($, name)
    await recordSpawnFailure($, role, await $.clock.now())
  }
  let stdout = ''
  for (const step of launch.steps) {
    let argv: readonly string[] | undefined
    try {
      argv = step.argv ?? step.argvFromPrevious?.(stdout)
      if (!argv) continue
      // Above Herdr's own 30 s readiness wait, so its verdict arrives before this process timeout kills it.
      const run = () => $.process.run([...argv!], { cwd: role.repoRoot, timeoutMs: 35_000 })
      let result = await run()
      for (let attempt = 1; result.exitCode !== 0 && step.retryWhile?.(result) && attempt < LAUNCH_RETRIES; attempt += 1) {
        await new Promise<void>(resolve => { $.clock.after(LAUNCH_RETRY_MS, () => resolve()) })
        result = await run()
      }
      // Herdr reports its error envelope on stdout, so both streams go into the log.
      if (result.exitCode !== 0) return await fail(`command=${JSON.stringify(argv)} exitCode=${result.exitCode} stdout=${JSON.stringify(result.stdout.slice(0, 400))} stderr=${JSON.stringify(result.stderr.slice(0, 400))}`)
      const { undo: undoStep } = step, created = result.stdout
      if (undoStep) undo.push(() => undoStep(created))
      stdout = result.stdout
    } catch (error) {
      return await fail(`command=${JSON.stringify(argv ?? null)} error=${JSON.stringify(String(error).slice(0, 400))}`)
    }
  }
}

// undefined: no live idle co-worker, so dispatch may spawn; a string: an idle co-worker has been asked to claim `next`, once per (co-worker, issue).
async function requestClaim($: EngineInterface, records: readonly CoworkerRecord[], next: string, role: RuntimeRole, now: number): Promise<string | undefined> {
  const idle = records.find(record => record.role === 'coworker' && record.main === role.main && record.state === 'idle' && isLive(record, now, DEFAULT_COWORKER_TTL_MS))
  if (!idle) { claimRequests.delete(role.session); return }
  const key = `${idle.session}:${next}`
  if (claimRequests.get(role.session) === key) return `${idle.session} was already asked to claim ${next}.`
  claimRequests.set(role.session, key)
  return await notify($, idle.session, `Claim the next ready issue with clm_coworker; ${next} currently has the highest priority.`)
    ? `${idle.session} was asked to claim ${next}.`
    : `${idle.session} could not be asked to claim ${next}.`
}

async function dispatchReadyWork($: EngineInterface, role: RuntimeRole): Promise<string | undefined> {
  if (role.isCoworker) return
  const now = await $.clock.now()
  const issues = await issuesForRepo($, role)
  const records: CoworkerRecord[] = []
  for (const record of await readCoworkers(runtimeIo($))) {
    if (record.role === 'coworker' && record.main === role.main && record.state === 'starting' && !isLive(record, now, DEFAULT_COWORKER_TTL_MS)) {
      await recordSpawnFailure($, role, now)
      await removeRegistry($, record.session)
      $.ui.log(`clm co-worker ${record.session} failed to register before its ${DEFAULT_COWORKER_TTL_MS} ms startup deadline`)
    } else records.push(record)
  }
  const next = pickNext(issues.map(selectableIssue), role.repo)
  if (!next) { claimRequests.delete(role.session); return }
  const claimNotice = await requestClaim($, records, next.id, role, now)
  if (claimNotice !== undefined) return claimNotice
  const load = await (async () => {
    try { return await readLoad({ run: (argv, options) => $.process.run([...argv], options), read: path => optionalRead($, path) }) }
    catch (error) { $.ui.log(`clm co-worker load reading failed: ${String(error).slice(0, 160)}`, { to: 'debug' }); return undefined }
  })()
  if (!load) return
  const cap = 0.75 * load.cores
  if (load.load1 >= cap) {
    $.ui.log(`clm co-worker spawn skipped: load1=${load.load1} cap=${cap} cores=${load.cores}`, { to: 'debug' })
    return
  }
  if (shouldSpawn({
    issues: issues.map(selectableIssue), coworkers: records.filter(record => record.role === 'coworker'), repo: role.repo, main: role.main,
    ...load, maxCoworkers: await readMaxCoworkers($, role), backoff: await readSpawnBackoff(runtimeIo($), role.main), now, ttlMs: DEFAULT_COWORKER_TTL_MS,
  }))
    await launchCoworker($, role, records)
}

const tick = async ($: EngineInterface, role: RuntimeRole) => {
  if (ticksInFlight.has(role.session)) return
  ticksInFlight.add(role.session)
  try {
    await updateRegistry($, role)
    await dispatchReadyWork($, role)
  } finally { ticksInFlight.delete(role.session) }
}

const handleTool = async ($: EngineInterface, input: ClmCoworkerInput) => {
  const role = await currentRole($)
  switch (input.action) {
    case 'claim': return claim($, role, input.issue)
    case 'ready': return ready($, role, input.issue)
    case 'release': return release($, role, input.issue)
    case 'plan': return plan($, role, input)
    case 'revoke': return revoke($, role, input)
    case 'land': return land($, role, input.issue)
    case 'list': return list($, role)
    default: throw new Error('action must be claim, ready, release, plan, revoke, land, or list')
  }
}

const announceDeferred = async ($: EngineInterface, ids: string[]) => {
  const role = await currentRole($)
  if (role.isCoworker) return
  const now = await $.clock.now()
  const recipients = (await readCoworkers(runtimeIo($)))
    .filter(record => record.role === 'coworker' && record.main === role.main && isLive(record, now, DEFAULT_COWORKER_TTL_MS))
  if (!recipients.length) return
  const text = `New deferred board issue${ids.length === 1 ? '' : 's'}: ${ids.join(', ')}.`
  for (const record of recipients) await notify($, record.session, text)
}

export const coworkerIntent = (session: string) => intents.get(session)

const startRuntime = async ($: EngineInterface, stableMain?: string) => {
  const role = await currentRole($, stableMain)
  intents.set(role.session, { isCoworker: role.isCoworker, announce: ids => announceDeferred($, ids) })
  await updateRegistry($, role, { state: 'idle' })
  if (role.placeholder && role.placeholder !== role.session) await removeRegistry($, role.placeholder)
  if (role.isCoworker) await writeSpawnBackoff(runtimeIo($), role.main, { failures: 0 })
  for (const timer of timers.get(role.session) ?? []) timer.cancel()
  timers.set(role.session, [
    $.clock.every(POLL_MS, () => { void tick($, role).catch(error => $.ui.log(`clm co-worker poll failed: ${String(error).slice(0, 160)}`, { to: 'debug' })) }),
  ])
  await $.tool.register({
    name: 'clm_coworker',
    description: 'Coordinate clm board work between the main session and detached co-worker sessions: plan, claim, hand back, land, reassign, or list. clm messages the other side of each hand-off itself.',
    inputSchema: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['claim', 'ready', 'release', 'plan', 'revoke', 'land', 'list'] },
        issue: { type: 'string' }, priority: { type: 'integer' }, ready: { type: 'boolean' }, maxCoworkers: { type: 'integer', minimum: 1 },
        to: { type: 'string' },
      }, required: ['action'], additionalProperties: false,
    },
  })
}

const stopRuntime = (session: string) => {
  intents.delete(session)
  roles.delete(session)
  localRecords.delete(session)
  registryWrites.delete(session)
  ticksInFlight.delete(session)
  claimRequests.delete(session)
  for (const timer of timers.get(session) ?? []) timer.cancel()
  timers.delete(session)
}

const promptContext = async ($: EngineInterface, role: RuntimeRole): Promise<string | undefined> => {
  const issues = await issuesForRepo($, role)
  const records = await readCoworkers(runtimeIo($))
  if (role.isCoworker) {
    const record = records.find(item => item.session === role.session)
    const issue = record?.issue ? issues.find(item => item.id === record.issue) : undefined
    return `Role: clm co-worker for main session ${role.main}.${issue ? ` Claimed issue: ${issue.id} (${issue.title}). Worktree: ${issue.worktree?.dir ?? 'not recorded'}.` : ' Claim ready work with clm_coworker before editing.'}`
  }
  const unplanned = issues.filter(issue => issue.status === 'todo' && issue.priority === undefined && issue.ready === undefined)
  const waiting = issues.filter(issue => issue.status === 'ready-to-land')
  const lines = [
    ...(unplanned.length ? [`Unplanned deferred issues: ${unplanned.map(issue => `${issue.id} (${issue.title})`).join('; ')}.`] : []),
    ...(waiting.length ? [`Ready-to-land issues: ${waiting.map(issue => `${issue.id} (${issue.title})`).join('; ')}.`] : []),
  ]
  return lines.length ? lines.join('\n') : undefined
}

export const registerCoworkers: Register = (on) => {
  on('session.start', { isInteractive: [true, false] }, async ($, e, next) => {
    try { await startRuntime($) }
    catch (error) { $.ui.log(`clm co-worker start failed: ${String(error).slice(0, 160)}`, { to: 'debug' }) }
    return next(e)
  })

  on('tool.call', { tool: COWORKER_TOOL }, async ($, e) => {
    try { return { result: await handleTool($, e) } }
    catch (error) { return { deny: `clm_coworker failed: ${String(error).slice(0, 240)}` } }
  })

  on('prompt.compose', { model: /.*/ }, async ($, e, next) => {
    const result = await next(e)
    if (e.traits.includes('bare')) return result
    try {
      const role = await currentRole($)
      const text = await promptContext($, role)
      return text ? { ...result, sections: [...result.sections, { id: 'clm:coworker', text, scope: 'session' as const }] } : result
    } catch (error) {
      $.ui.log(`clm co-worker prompt context failed: ${String(error).slice(0, 160)}`, { to: 'debug' })
      return result
    }
  })

  on('session.end', { sessionId: /.*/ }, async ($, e, next) => {
    const stableMain = roles.get(e.sessionId)?.main
    stopRuntime(e.sessionId)
    const result = await next(e)
    if (e.reason === 'clear') {
      try { await startRuntime($, stableMain) }
      catch (error) { $.ui.log(`clm co-worker clear restart failed: ${String(error).slice(0, 160)}`, { to: 'debug' }) }
    }
    return result
  })
}
