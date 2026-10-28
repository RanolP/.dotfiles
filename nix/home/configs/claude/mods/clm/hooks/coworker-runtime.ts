import type { EngineInterface, Register } from 'claude-code'
import type { ClmCoworkerInput } from '../types'
import { append as appendEvents, captureOrigin, readAll, type EventsIo } from './events'
import {
  DEFAULT_COWORKER_TTL_MS, claimIssue, drainMail, isLive, pickNext, readCoworkers, releaseClaim, revokeClaim,
  sendMail, sendMailToMany, shouldSpawn, writeCoworker, type CoworkerIo, type CoworkerRecord,
} from './coworker'
import { coworkerBrief, detectMux, launchPlan, readLoad } from './spawn'
import { snapshot, type Issue, type Origin, type Payload } from './tracker'
import type { PromptIntentIo } from './intent'
import { checkpointCommit, removeWorktree, startWorktree, type Worktree, type WorktreeIo } from './worktree'
import { readWorkflow } from './workflow'

export const COWORKER_TOOL = 'mcp__clm__clm_coworker'
const POLL_MS = 5_000
const DEFAULT_MAX_COWORKERS = 2
const WORKFLOW = { plugin: 'clm', key: 'workflow' } as const

type RuntimeRole = { isCoworker: boolean; session: string; main: string; repo: string; repoRoot: string; placeholder?: string }

const roles = new Map<string, RuntimeRole>()
const timers = new Map<string, { cancel: () => void }[]>()
const intents = new Map<string, Pick<PromptIntentIo, 'isCoworker' | 'announce'>>()
const localRecords = new Map<string, CoworkerRecord>()
const registryWrites = new Map<string, Promise<void>>()
const ticksInFlight = new Set<string>()

const optionalRead = async ($: EngineInterface, path: string) => {
  try { return (await $.fs.exists(path)) ? await $.fs.read(path) : undefined } catch { return undefined }
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
    session: role.session, main: role.main, repo: role.repo, state: existing?.state ?? 'idle', heartbeat: now,
    ...(existing?.issue ? { issue: existing.issue } : {}), ...(existing?.mux ? { mux: existing.mux } : {}),
    ...(!role.isCoworker ? { maxCoworkers: existing?.maxCoworkers ?? DEFAULT_MAX_COWORKERS } : {}), ...update,
  }
  if (update.issue === undefined && 'issue' in update) delete record.issue
  localRecords.set(role.session, record)
  const previous = registryWrites.get(role.session) ?? Promise.resolve()
  const write = previous.catch(() => undefined).then(() => writeCoworker(runtimeIo($), record))
  registryWrites.set(role.session, write)
  await write
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
  await sendMail(runtimeIo($), { from: role.session, to: role.main, text: `${issue.id} is ready to land (${baseSha}..${headSha}).`, now: await $.clock.now() })
  return `${issue.id} is ready to land at ${baseSha}..${headSha}; the main session was notified.`
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
  await updateRegistry($, role, input.maxCoworkers === undefined ? {} : { maxCoworkers: input.maxCoworkers })
  if (input.ready === true) await dispatchReadyWork($, role)
  return `Planned ${issue.id}: priority=${input.priority ?? issue.priority ?? 'unset'}, ready=${input.ready ?? issue.ready ?? false}, maxCoworkers=${input.maxCoworkers ?? await maxCoworkers($, role)}.`
}

const revoke = async ($: EngineInterface, role: RuntimeRole, input: ClmCoworkerInput) => {
  requireMain(role)
  const issue = issueById(await issuesForRepo($, role), input.issue)
  const old = issue.claimedBy
  await revokeClaim(runtimeIo($), issue.id)
  await append($, [{ op: 'claim', issue: issue.id, by: null }, { op: 'status', issue: issue.id, status: 'todo' }])
  const now = await $.clock.now()
  if (old) await sendMail(runtimeIo($), { from: role.session, to: old, text: `Your claim on ${issue.id} was revoked. Keep its worktree unchanged until it is reassigned.`, now })
  if (input.to) await sendMail(runtimeIo($), { from: role.session, to: input.to, text: `Claim ${issue.id}; its existing worktree remains attached to the issue.`, now })
  await dispatchReadyWork($, role)
  return `Revoked ${issue.id}${old ? ` from ${old}` : ''}${input.to ? ` and notified ${input.to}` : ''}.`
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
    await sendMail(runtimeIo($), {
      from: role.session, to: issue.claimedBy,
      text: `Landing ${issue.id} conflicted at main HEAD ${mainHead}. Rebase the issue worktree onto ${mainHead}, resolve it, and call ready again.`,
      now: await $.clock.now(),
    })
    return `Landing ${issue.id} conflicted. The cherry-pick was aborted and ${issue.claimedBy} was asked to rebase onto ${mainHead}.`
  }
  await append($, [{ op: 'status', issue: issue.id, status: 'done' }, { op: 'claim', issue: issue.id, by: null }, { op: 'land', issue: issue.id }])
  await revokeClaim(runtimeIo($), issue.id)
  const removed = await (async () => {
    try { await removeWorktree(worktreeIo($), issue.worktree); return true }
    catch (error) { $.ui.log(`clm co-worker worktree cleanup failed for ${issue.id}: ${String(error).slice(0, 160)}`); return false }
  })()
  await sendMail(runtimeIo($), { from: role.session, to: issue.claimedBy, text: `${issue.id} landed successfully; its worktree ${removed ? 'was removed' : 'still needs cleanup'}.`, now: await $.clock.now() })
  await dispatchReadyWork($, role)
  return `Landed ${issue.id}. Its changes are staged in ${role.repoRoot}; commit them with the repository's own subject format after final verification.`
}

const message = async ($: EngineInterface, role: RuntimeRole, input: ClmCoworkerInput) => {
  if (!input.to || !input.text?.trim()) throw new Error('message requires to and non-empty text')
  const records = await readCoworkers(runtimeIo($))
  const now = await $.clock.now()
  const recipients = input.to === 'main' ? [role.main]
    : input.to === 'all' ? records.filter(record => record.main === role.main && record.session !== role.session && isLive(record, now, DEFAULT_COWORKER_TTL_MS)).map(record => record.session)
      : [input.to]
  await sendMailToMany(runtimeIo($), { from: role.session, to: [...new Set(recipients)], text: input.text.trim(), now })
  return `Sent the message to ${[...new Set(recipients)].join(', ') || 'no live sessions'}.`
}

const list = async ($: EngineInterface, role: RuntimeRole) => {
  const now = await $.clock.now()
  const coworkers = (await readCoworkers(runtimeIo($))).filter(record => record.main === role.main && record.session !== role.main)
  const issues = await issuesForRepo($, role)
  return [
    'Co-workers:',
    ...(coworkers.length ? coworkers.map(record => `- ${record.session}: ${isLive(record, now, DEFAULT_COWORKER_TTL_MS) ? 'live' : 'stale'}, ${record.state}${record.issue ? `, issue ${record.issue}` : ''}`) : ['- none']),
    'Board:',
    ...(issues.length ? issues.map(issue => `- ${issue.id}: ${issue.status}, priority=${issue.priority ?? 'unset'}, ready=${issue.ready ?? false}, claimant=${issue.claimedBy ?? 'none'} — ${issue.title}`) : ['- none']),
  ].join('\n')
}

const maxCoworkers = async ($: EngineInterface, role: RuntimeRole) => {
  const records = await readCoworkers(runtimeIo($))
  return records.find(record => record.session === role.session)?.maxCoworkers
    ?? records.find(record => record.session === role.main)?.maxCoworkers
    ?? DEFAULT_MAX_COWORKERS
}

const removeRegistry = async ($: EngineInterface, session: string) => {
  const home = (await $.env.get('HOME')) ?? '.'
  await $.process.run(['rm', '-f', `${home}/.claude-work/clm/coworkers/${session}.json`], { timeoutMs: 1_000 })
}

const launchCoworker = async ($: EngineInterface, role: RuntimeRole, records: readonly CoworkerRecord[]) => {
  const env = {
    HERDR_SOCKET_PATH: await $.env.get('HERDR_SOCKET_PATH'), HERDR_ENV: await $.env.get('HERDR_ENV'),
    ZELLIJ: await $.env.get('ZELLIJ'), TMUX: await $.env.get('TMUX'),
  }
  const mux = detectMux(env)
  const used = new Set(records.map(record => record.session))
  let index = 1
  while (used.has(`clm-coworker-${index}`)) index += 1
  const name = `clm-coworker-${index}`
  await writeCoworker(runtimeIo($), { session: name, main: role.main, repo: role.repo, state: 'starting', heartbeat: await $.clock.now(), mux })
  const failures = records.filter(record => record.main === role.main && record.state === 'failed').length + 1
  const launch = launchPlan({ mux, cwd: role.repoRoot, name, env: { CLM_COWORKER: '1', CLM_MAIN_SESSION: role.main, CLM_COWORKER_NAME: name }, brief: coworkerBrief({ main: role.main, repo: role.repoRoot }) })
  if ('manual' in launch) {
    $.ui.log(`clm co-worker launch unavailable: mux=none command=${launch.manual} exitCode=unavailable stderr=${JSON.stringify('no supported multiplexer detected')}`, { to: 'debug' })
    await removeRegistry($, name)
    return
  }
  let stdout = ''
  for (const step of launch.steps) {
    const argv = step.argv ?? step.argvFromPrevious?.(stdout)
    if (!argv) continue
    const result = await $.process.run([...argv], { cwd: role.repoRoot, timeoutMs: 30_000 })
    if (result.exitCode !== 0) {
      $.ui.log(`clm co-worker launch failed: command=${JSON.stringify(argv)} exitCode=${result.exitCode} stderr=${JSON.stringify(result.stderr)}`, { to: 'debug' })
      await removeRegistry($, name)
      return
    }
    stdout = result.stdout
  }
  const placeholder = (await readCoworkers(runtimeIo($))).find(record => record.session === name)
  if (placeholder) await writeCoworker(runtimeIo($), { ...placeholder, failures })
}

async function dispatchReadyWork($: EngineInterface, role: RuntimeRole): Promise<void> {
  if (role.isCoworker) return
  const now = await $.clock.now()
  const issues = await issuesForRepo($, role)
  const observed = await readCoworkers(runtimeIo($))
  const records = await Promise.all(observed.map(async record => {
    if (record.main !== role.main || record.state !== 'starting' || isLive(record, now, DEFAULT_COWORKER_TTL_MS)) return record
    const failed = { ...record, state: 'failed' as const, failedAt: now, failures: record.failures ?? 1 }
    await writeCoworker(runtimeIo($), failed)
    $.ui.log(`clm co-worker ${record.session} failed to register before its ${DEFAULT_COWORKER_TTL_MS} ms startup deadline`)
    return failed
  }))
  const next = pickNext(issues.map(selectableIssue), role.repo)
  if (!next) return
  const idle = records.find(record => record.main === role.main && record.session !== role.main && record.state === 'idle' && isLive(record, now, DEFAULT_COWORKER_TTL_MS))
  if (idle) {
    await sendMail(runtimeIo($), { from: role.session, to: idle.session, text: `Claim the next ready issue; ${next.id} currently has the highest priority.`, now })
    return
  }
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
  if (shouldSpawn({ issues: issues.map(selectableIssue), coworkers: records.filter(record => record.session !== role.main), repo: role.repo, main: role.main, ...load, maxCoworkers: await maxCoworkers($, role), now, ttlMs: DEFAULT_COWORKER_TTL_MS }))
    await launchCoworker($, role, records)
}

const deliverMail = async ($: EngineInterface, role: RuntimeRole) => {
  const workflow = await readWorkflow({ get: async () => (await $.state.get(WORKFLOW)).value })
  if (workflow.activeTurnId) return
  const mailboxes = role.isCoworker || role.session === role.main ? [role.session] : [role.session, role.main]
  const messages = (await Promise.all([...new Set(mailboxes)].map(session => drainMail(runtimeIo($), session)))).flat()
  if (!messages.length) return
  const text = messages.map(item => `[clm message from ${item.message.from}]\n${item.message.text}`).join('\n\n')
  const result = await $.prompt.submit({ text })
  if (result.drop !== undefined) {
    $.ui.log(`clm co-worker mail delivery dropped: ${String(result.drop).slice(0, 160)}`, { to: 'debug' })
    return
  }
  await Promise.all(messages.map(item => $.process.run(['rm', '-f', item.path], { timeoutMs: 1_000 })))
}

const tick = async ($: EngineInterface, role: RuntimeRole) => {
  if (ticksInFlight.has(role.session)) return
  ticksInFlight.add(role.session)
  try {
    await updateRegistry($, role)
    await deliverMail($, role)
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
    case 'message': return message($, role, input)
    default: throw new Error('action must be claim, ready, release, plan, revoke, land, list, or message')
  }
}

const announceDeferred = async ($: EngineInterface, ids: string[]) => {
  const role = await currentRole($)
  if (role.isCoworker) return
  const now = await $.clock.now()
  const recipients = (await readCoworkers(runtimeIo($)))
    .filter(record => record.main === role.main && record.session !== role.main && isLive(record, now, DEFAULT_COWORKER_TTL_MS))
    .map(record => record.session)
  await sendMailToMany(runtimeIo($), { from: role.session, to: recipients, text: `New deferred board issue${ids.length === 1 ? '' : 's'}: ${ids.join(', ')}.`, now })
}

export const coworkerIntent = (session: string) => intents.get(session)

const startRuntime = async ($: EngineInterface, stableMain?: string) => {
  const role = await currentRole($, stableMain)
  intents.set(role.session, { isCoworker: role.isCoworker, announce: ids => announceDeferred($, ids) })
  await updateRegistry($, role, { state: 'idle' })
  if (role.placeholder && role.placeholder !== role.session) await removeRegistry($, role.placeholder)
  for (const timer of timers.get(role.session) ?? []) timer.cancel()
  timers.set(role.session, [
    $.clock.every(POLL_MS, () => { void tick($, role).catch(error => $.ui.log(`clm co-worker poll failed: ${String(error).slice(0, 160)}`, { to: 'debug' })) }),
  ])
  await $.tool.register({
    name: 'clm_coworker',
    description: 'Coordinate clm board work between the main session and detached co-worker sessions: plan, claim, hand back, land, reassign, list, or message.',
    inputSchema: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['claim', 'ready', 'release', 'plan', 'revoke', 'land', 'list', 'message'] },
        issue: { type: 'string' }, priority: { type: 'integer' }, ready: { type: 'boolean' }, maxCoworkers: { type: 'integer', minimum: 1 },
        to: { type: 'string' }, text: { type: 'string' },
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
  for (const timer of timers.get(session) ?? []) timer.cancel()
  timers.delete(session)
}

const promptContext = async ($: EngineInterface, role: RuntimeRole): Promise<string | undefined> => {
  const issues = await issuesForRepo($, role)
  if (role.isCoworker) {
    const record = (await readCoworkers(runtimeIo($))).find(item => item.session === role.session)
    const issue = record?.issue ? issues.find(item => item.id === record.issue) : undefined
    return `Role: clm co-worker for main session ${role.main}.${issue ? ` Claimed issue: ${issue.id} (${issue.title}). Worktree: ${issue.worktree?.dir ?? 'not recorded'}.` : ' Claim ready work with clm_coworker before editing.'}`
  }
  const unplanned = issues.filter(issue => issue.status === 'todo' && issue.priority === undefined && issue.ready === undefined)
  const waiting = issues.filter(issue => issue.status === 'ready-to-land')
  if (!unplanned.length && !waiting.length) return undefined
  return [
    ...(unplanned.length ? [`Unplanned deferred issues: ${unplanned.map(issue => `${issue.id} (${issue.title})`).join('; ')}.`] : []),
    ...(waiting.length ? [`Ready-to-land issues: ${waiting.map(issue => `${issue.id} (${issue.title})`).join('; ')}.`] : []),
  ].join('\n')
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
