import { expect, test } from 'claude-code/testing'
import type { SessionStartInput, ToolCallInput } from 'claude-code'
import type { CoworkerRecord } from './coworker'
import { COWORKER_TOOL } from './coworker-runtime'
import { bottoms, intentReply, promptInput, workflow, type On, type State } from './clm-test-support'
import { parseLog, snapshot, toEvents, type Payload } from './tracker'

const HOME = '/home/t'
const ROOT = `${HOME}/.claude-work/clm`
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const startInput = { cwd: '/work/repo', surface: 'terminal', isInteractive: true } satisfies SessionStartInput
const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' })

const seedBoard = (seen: ReturnType<typeof bottoms>, session: string, payloads: Payload[]) => {
  const events = toEvents(payloads, { session, repo: 'github.com/o/repo', cwd: '/work/repo' }, 0, '2026-10-06T00:00:00.000Z')
  const path = `${HOME}/.claude-work/tracker/events/${session}.jsonl`
  seen.files[path] = `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}

const issues = (seen: ReturnType<typeof bottoms>) => snapshot(Object.entries(seen.files)
  .filter(([path]) => path.startsWith(`${HOME}/.claude-work/tracker/events/`) && path.endsWith('.jsonl'))
  .flatMap(([, value]) => parseLog(value)))

const tool = ($: any, input: Record<string, unknown>) => $.tool.call({ tool: COWORKER_TOOL, ...input } as ToolCallInput) as Promise<any>
const resultText = (result: any) => String(result?.result ?? '')
const denial = (result: any) => String(result?.deny ?? '')
const NOW = Date.parse('2026-10-06T00:00:00Z')
const recipient = (to: unknown) => typeof to === 'string' ? to : (to as { sessionId?: string }).sessionId
const sentTo = (seen: ReturnType<typeof bottoms>, session: string) => seen.sends.filter(sent => recipient(sent.to) === session).map(sent => sent.text)
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

const seedRecord = (seen: ReturnType<typeof bottoms>, record: Omit<CoworkerRecord, 'role'> & { role?: CoworkerRecord['role'] }) => {
  seen.dirs.add(`${ROOT}/coworkers`)
  seen.files[`${ROOT}/coworkers/${record.session}.json`] = JSON.stringify({ role: 'coworker', ...record })
}

const setWorkflow = (on: On, read: () => ReturnType<typeof workflow>) => {
  on('state.get', async (_$: unknown, e: any, next: (e: any) => Promise<any>) => {
    const current = await next(e)
    return e.plugin === 'clm' && e.key === 'workflow' ? { value: { ...current.value, value: read() } } : current
  })
}

const coworkerState = (session: string, main: string, extra: Partial<State> = {}): State => ({
  rows: [], replies: [], sessionId: session, env: { CLM_COWORKER: '1', CLM_MAIN_SESSION: main }, ...extra,
})

// Regression caught: claim selection ignored the board priority and failed to persist the isolated checkout.
test('a co-worker claim takes the highest-priority ready issue and records its worktree', async ($, on) => {
  const seen = bottoms(on, coworkerState('worker-claim', 'main-claim'))
  seedBoard(seen, 'board-claim', [
    { op: 'create', issue: 'low', title: 'Low', status: 'todo' }, { op: 'plan', issue: 'low', priority: 1, ready: true },
    { op: 'create', issue: 'high', title: 'High', status: 'todo' }, { op: 'plan', issue: 'high', priority: 9, ready: true },
  ])
  await $.session.start(startInput)
  const output = await tool($, { action: 'claim' })
  expect(resultText(output)).toContain('Claimed high')
  expect(issues(seen).find(issue => issue.id === 'high')).toMatchObject({ status: 'doing', claimedBy: 'worker-claim', worktree: { dir: `${ROOT}/worktrees/worker-claim/high` } })
})

// Regression caught: two co-workers could both append a claim after selecting the same ready issue.
test('a second co-worker cannot claim an issue already claimed', async ($, on) => {
  const seen = bottoms(on, coworkerState('worker-second', 'main-second'))
  seedBoard(seen, 'board-second', [{ op: 'create', issue: 'one', title: 'One', status: 'todo' }, { op: 'plan', issue: 'one', priority: 1, ready: true }])
  seen.dirs.add(`${ROOT}/claims`)
  seen.files[`${ROOT}/claims/one.json`] = JSON.stringify({ session: 'worker-first' })
  seedRecord(seen, { session: 'worker-first', main: 'main-second', repo: 'github.com/o/repo', state: 'busy', issue: 'one', heartbeat: Date.parse('2026-10-06T00:00:00Z') })
  await $.session.start(startInput)
  expect(denial(await tool($, { action: 'claim', issue: 'one' }))).toContain('already claimed by worker-first')
  expect(issues(seen).find(issue => issue.id === 'one')?.claimedBy).toBeUndefined()
})

// Regression caught: a completed co-worker checkpoint stayed in doing, or main was never told it could land.
test('ready marks the issue ready-to-land and messages the live main session', async ($, on) => {
  const seen = bottoms(on, coworkerState('worker-ready', 'main-ready'))
  seedBoard(seen, 'board-ready', [{ op: 'create', issue: 'ready-one', title: 'Ready one', status: 'todo' }, { op: 'plan', issue: 'ready-one', ready: true }])
  seedRecord(seen, { session: 'main-ready', main: 'main-ready', role: 'main', repo: 'github.com/o/repo', state: 'idle', heartbeat: NOW })
  await $.session.start(startInput)
  await tool($, { action: 'claim', issue: 'ready-one' })
  const output = await tool($, { action: 'ready', issue: 'ready-one' })
  expect(resultText(output)).toContain('main-ready was notified.')
  expect(sentTo(seen, 'main-ready')).toEqual([`ready-one is ready to land (${SHA_B}..${SHA_A}).`])
  expect(issues(seen).find(issue => issue.id === 'ready-one')).toMatchObject({ status: 'ready-to-land', worktree: { baseSha: SHA_B, headSha: SHA_A } })
})

// Regression caught: after main's /clear the hand-back went to the stable main id, a session that no longer runs.
test('ready messages the newest live main record, not the stable main id', async ($, on) => {
  const seen = bottoms(on, coworkerState('worker-cleared', 'main-old'))
  seedBoard(seen, 'board-cleared', [{ op: 'create', issue: 'cleared-one', title: 'Cleared one', status: 'todo' }, { op: 'plan', issue: 'cleared-one', ready: true }])
  seedRecord(seen, { session: 'main-old', main: 'main-old', role: 'main', repo: 'github.com/o/repo', state: 'idle', heartbeat: NOW - 120_000 })
  seedRecord(seen, { session: 'main-new', main: 'main-old', role: 'main', repo: 'github.com/o/repo', state: 'idle', heartbeat: NOW })
  await $.session.start(startInput)
  await tool($, { action: 'claim', issue: 'cleared-one' })
  await tool($, { action: 'ready', issue: 'cleared-one' })
  expect(sentTo(seen, 'main-new')).toHaveLength(1)
  expect(sentTo(seen, 'main-old')).toHaveLength(0)
})

// Regression caught: an undelivered hand-back vanished silently instead of logging why.
test('an undelivered message logs its reason and the result says so', async ($, on) => {
  const seen = bottoms(on, coworkerState('worker-undelivered', 'main-undelivered', { sendResult: () => ({ isDelivered: false, reason: 'recipient gone' }) }))
  seedBoard(seen, 'board-undelivered', [{ op: 'create', issue: 'undelivered-one', title: 'Undelivered one', status: 'todo' }, { op: 'plan', issue: 'undelivered-one', ready: true }])
  seedRecord(seen, { session: 'main-undelivered', main: 'main-undelivered', role: 'main', repo: 'github.com/o/repo', state: 'idle', heartbeat: NOW })
  await $.session.start(startInput)
  await tool($, { action: 'claim', issue: 'undelivered-one' })
  expect(resultText(await tool($, { action: 'ready', issue: 'undelivered-one' }))).toContain('main-undelivered could not be notified.')
  expect(seen.logs.some(line => line.includes('message to main-undelivered not delivered: recipient gone'))).toBe(true)
})

const seedReadyToLand = (seen: ReturnType<typeof bottoms>, session: string, issue = 'land-one') => {
  const dir = `${ROOT}/worktrees/worker-land/${issue}`
  seen.dirs.add(dir)
  seedBoard(seen, session, [
    { op: 'create', issue, title: 'Land one', status: 'todo' }, { op: 'claim', issue, by: 'worker-land' }, { op: 'status', issue, status: 'ready-to-land' },
    { op: 'worktree', issue, dir, baseSha: SHA_B, headSha: SHA_A, originBranch: 'main', repoRoot: '/work/repo', worktreesRoot: `${ROOT}/worktrees` },
  ])
  seen.dirs.add(`${ROOT}/claims`)
  seen.files[`${ROOT}/claims/${issue}.json`] = JSON.stringify({ session: 'worker-land' })
}

// Regression caught: a successful hand-back left the issue and worktree open after applying its commits.
test('land cherry-picks a ready-to-land issue, removes its worktree and marks it done', async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [], sessionId: 'main-land' })
  seedReadyToLand(seen, 'board-land')
  await $.session.start(startInput)
  const output = await tool($, { action: 'land', issue: 'land-one' })
  expect(resultText(output)).toContain('changes are staged')
  expect(seen.runs.some(argv => argv.join(' ') === `git -C /work/repo cherry-pick --no-commit ${SHA_B}..${SHA_A}`)).toBe(true)
  expect(issues(seen).find(issue => issue.id === 'land-one')).toMatchObject({ status: 'done', landCommandsShown: true })
  expect(seen.dirs.has(`${ROOT}/worktrees/worker-land/land-one`)).toBe(false)
})

// Regression caught: a worktree cleanup error left an already cherry-picked issue ready-to-land, so retrying failed on the staged checkout.
test('a land cleanup failure still marks the issue done', async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], sessionId: 'main-cleanup-failure',
    processRun: argv => argv.includes('worktree') && argv.includes('remove') ? { exitCode: 1, stdout: '', stderr: 'busy worktree' } : undefined,
  })
  seedReadyToLand(seen, 'board-cleanup-failure', 'cleanup-failure-one')
  await $.session.start(startInput)
  const output = await tool($, { action: 'land', issue: 'cleanup-failure-one' })
  expect(resultText(output)).toContain('changes are staged')
  expect(issues(seen).find(issue => issue.id === 'cleanup-failure-one')).toMatchObject({ status: 'done' })
  expect(seen.logs.some(line => line.includes('worktree cleanup failed for cleanup-failure-one'))).toBe(true)
})

// Regression caught: a conflicting cherry-pick orphaned the issue instead of returning it to its current owner.
test('a conflicting land aborts the cherry-pick and returns the issue to the same co-worker', async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], sessionId: 'main-conflict',
    processRun: argv => argv.includes('cherry-pick') && argv.includes('--no-commit') ? { exitCode: 1, stdout: '', stderr: 'conflict' } : undefined,
  })
  seedReadyToLand(seen, 'board-conflict', 'conflict-one')
  await $.session.start(startInput)
  const output = await tool($, { action: 'land', issue: 'conflict-one' })
  expect(resultText(output)).toContain('worker-land was notified.')
  expect(sentTo(seen, 'worker-land')[0]).toContain(`Landing conflict-one conflicted at main HEAD ${SHA_A}.`)
  expect(seen.runs.some(argv => argv.join(' ') === 'git -C /work/repo cherry-pick --abort')).toBe(true)
  expect(issues(seen).find(issue => issue.id === 'conflict-one')).toMatchObject({ status: 'doing', claimedBy: 'worker-land' })
})

// Regression caught: landing into a dirty main checkout mixed unrelated user changes with a co-worker hand-back.
test('land refuses a dirty checkout without returning the issue', async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], sessionId: 'main-dirty',
    processRun: argv => argv.includes('status') && argv.includes('--porcelain') ? ok(' M user-file\n') : undefined,
  })
  seedReadyToLand(seen, 'board-dirty', 'dirty-one')
  await $.session.start(startInput)
  expect(denial(await tool($, { action: 'land', issue: 'dirty-one' }))).toContain('dirty checkout')
  expect(issues(seen).find(issue => issue.id === 'dirty-one')).toMatchObject({ status: 'ready-to-land', claimedBy: 'worker-land' })
})

// Regression caught: revocation updated the board but left the atomic claim directory blocking reassignment.
test('revoke frees the claim so another co-worker can take it', async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [], sessionId: 'main-revoke' })
  seedReadyToLand(seen, 'board-revoke', 'revoke-one')
  await $.session.start(startInput)
  await tool($, { action: 'revoke', issue: 'revoke-one' })
  expect(`${ROOT}/claims/revoke-one.json` in seen.files).toBe(false)
  expect(issues(seen).find(issue => issue.id === 'revoke-one')).toMatchObject({ status: 'todo' })
  expect(issues(seen).find(issue => issue.id === 'revoke-one')?.claimedBy).toBeUndefined()
})

// Regression caught: /clear cancelled polling under the old id, so the new main session never heartbeat or dispatched.
test('after /clear the main session keeps polling under its new id', async ($, on) => {
  const state: State = {
    rows: [], replies: [], sessionId: 'main-before-clear', nextSessionId: 'main-after-clear', env: { HERDR_ENV: '1' },
    processRun: argv => argv[0] === 'herdr' && argv[1] === 'tab' ? ok(JSON.stringify({ root_pane: { pane_id: 'pane-after-clear' } })) : undefined,
  }
  const seen = bottoms(on, state)
  setWorkflow(on, () => workflow())
  seedBoard(seen, 'board-after-clear', [{ op: 'create', issue: 'after-clear-ready', title: 'After clear ready', status: 'todo' }, { op: 'plan', issue: 'after-clear-ready', ready: true }])
  await $.session.start(startInput)
  await $.session.end({ sessionId: 'main-before-clear', reason: 'clear' } as Parameters<typeof $.session.end>[0])
  await seen.clock.advance(10_000); await new Promise(resolve => setTimeout(resolve, 0))
  expect(resultText(await tool($, { action: 'list' }))).toContain('Main main-before-clear: live session main-after-clear')
  expect(seen.runs.filter(argv => argv[0] === 'herdr' && argv[1] === 'tab')).toHaveLength(1)
  expect(JSON.parse(seen.files[`${ROOT}/coworkers/main-after-clear.json`]!)).toMatchObject({ main: 'main-before-clear' })
})

// Regression caught: /clear created a new main record whose default worker cap shadowed the stable main's planned cap.
test('maxCoworkers set by plan survives /clear', async ($, on) => {
  const state: State = { rows: [], replies: [], sessionId: 'main-cap-before', nextSessionId: 'main-cap-after' }
  const seen = bottoms(on, state)
  seedBoard(seen, 'board-cap-clear', [{ op: 'create', issue: 'cap-clear', title: 'Cap clear', status: 'todo' }])
  await $.session.start(startInput)
  expect(resultText(await tool($, { action: 'plan', issue: 'cap-clear', maxCoworkers: 4 }))).toContain('maxCoworkers=4')
  await $.session.end({ sessionId: 'main-cap-before', reason: 'clear' } as Parameters<typeof $.session.end>[0])
  expect(resultText(await tool($, { action: 'plan', issue: 'cap-clear', priority: 1 }))).toContain('maxCoworkers=4')
})

// Regression caught: a poll heartbeat could publish an older idle snapshot after claim had moved the worker to busy.
test('a tick during claim does not revert the co-worker to idle', async ($, on) => {
  let entered!: () => void
  let release!: () => void
  const writingBusy = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  let blocked = false
  const seen = bottoms(on, coworkerState('worker-tick-claim', 'main-tick-claim', {
    fsWriteBlock: async (path, text) => {
      if (!blocked && path.includes('/coworkers/.worker-tick-claim-') && text.includes('"state":"busy"')) { blocked = true; entered(); await gate }
    },
  }))
  seedBoard(seen, 'board-tick-claim', [{ op: 'create', issue: 'tick-one', title: 'Tick one', status: 'todo' }, { op: 'plan', issue: 'tick-one', ready: true }])
  await $.session.start(startInput)
  const claiming = tool($, { action: 'claim', issue: 'tick-one' })
  await writingBusy
  const ticking = seen.clock.advance(5_000)
  release()
  await claiming; await ticking; await new Promise(resolve => setTimeout(resolve, 0))
  expect(JSON.parse(seen.files[`${ROOT}/coworkers/worker-tick-claim.json`]!)).toMatchObject({ state: 'busy', issue: 'tick-one' })
})

// Regression caught: deferred work reached the board without any live co-worker hearing about it.
test('a classified deferral messages every live co-worker', async ($, on) => {
  const s: State = { rows: [], replies: [], sessionId: 'main-deferral', intentReplies: [intentReply({ deferred: [{ text: 'Publish later', quote: 'Publish later' }] })] }
  const seen = bottoms(on, s)
  await $.session.start(startInput)
  seedRecord(seen, { session: 'worker-deferral-a', main: 'main-deferral', repo: 'github.com/o/repo', state: 'idle', heartbeat: NOW })
  seedRecord(seen, { session: 'worker-deferral-b', main: 'main-deferral', repo: 'github.com/o/repo', state: 'busy', heartbeat: NOW })
  seedRecord(seen, { session: 'worker-deferral-stale', main: 'main-deferral', repo: 'github.com/o/repo', state: 'idle', heartbeat: NOW - 120_000 })
  await $.prompt.submit(promptInput('Publish later'))
  for (let i = 0; i < 30 && sentTo(seen, 'worker-deferral-b').length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(sentTo(seen, 'worker-deferral-a')[0]).toMatch(/^New deferred board issue: /)
  expect(sentTo(seen, 'worker-deferral-b')[0]).toMatch(/^New deferred board issue: /)
  expect(sentTo(seen, 'worker-deferral-stale')).toHaveLength(0)
})

// Regression caught: ready work remained unclaimed even though Herdr was available and capacity was below the cap.
test('a ready issue with no idle co-worker launches one co-worker in the detected multiplexer', async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], sessionId: 'main-spawn', env: { HERDR_ENV: '1', CLAUDE_CONFIG_DIR: '/home/t/.claude-work' },
    processRun: argv => argv[0] === 'herdr' && argv[1] === 'tab' ? ok(JSON.stringify({ root_pane: { pane_id: 'pane-1' } })) : undefined,
  })
  seedBoard(seen, 'board-spawn', [{ op: 'create', issue: 'spawn-one', title: 'Spawn one', status: 'todo' }])
  await $.session.start(startInput)
  const output = await tool($, { action: 'plan', issue: 'spawn-one', priority: 5, ready: true })
  expect(denial(output)).toBe('')
  expect(seen.runs.some(argv => argv[0] === 'herdr' && argv[1] === 'tab' && argv.includes('--no-focus') && argv.includes('CLAUDE_CONFIG_DIR=/home/t/.claude-work'))).toBe(true)
  expect(seen.runs.some(argv => argv[0] === 'herdr' && argv[1] === 'agent' && argv.includes('pane-1'))).toBe(true)
})

// Regression caught: auto-dispatch spawned a duplicate session while an existing co-worker was idle.
test('an idle co-worker is messaged instead of a new spawn', async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [], sessionId: 'main-idle', env: { HERDR_ENV: '1' } })
  seedBoard(seen, 'board-idle', [{ op: 'create', issue: 'idle-one', title: 'Idle one', status: 'todo' }])
  await $.session.start(startInput)
  seedRecord(seen, { session: 'worker-idle', main: 'main-idle', repo: 'github.com/o/repo', state: 'idle', heartbeat: NOW })
  expect(resultText(await tool($, { action: 'plan', issue: 'idle-one', ready: true }))).toContain('worker-idle was asked to claim idle-one.')
  expect(sentTo(seen, 'worker-idle')).toEqual(['Claim the next ready issue with clm_coworker; idle-one currently has the highest priority.'])
  expect(seen.runs.some(argv => argv[0] === 'herdr')).toBe(false)
})

// Regression caught: a released issue went back to ready while main sat idle, and the poller found the idle co-worker but told nobody.
test('the poller asks an idle co-worker to claim once, not every tick', async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [], sessionId: 'main-poll', env: { HERDR_ENV: '1' } })
  seedBoard(seen, 'board-poll', [{ op: 'create', issue: 'poll-one', title: 'Poll one', status: 'todo' }, { op: 'plan', issue: 'poll-one', ready: true }])
  await $.session.start(startInput)
  seedRecord(seen, { session: 'worker-poll', main: 'main-poll', repo: 'github.com/o/repo', state: 'idle', heartbeat: NOW + 15_000 })
  await seen.clock.advance(5_000); await settle()
  await seen.clock.advance(5_000); await settle()
  await seen.clock.advance(5_000); await settle()
  expect(sentTo(seen, 'worker-poll')).toEqual(['Claim the next ready issue with clm_coworker; poll-one currently has the highest priority.'])
  expect(seen.runs.some(argv => argv[0] === 'herdr')).toBe(false)
})

// Regression caught: auto-spawn ignored host saturation and gave no diagnostic reading for the skipped launch.
test('load above the cap skips the spawn and logs the reading', async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], sessionId: 'main-load', env: { HERDR_ENV: '1' },
    processRun: argv => argv[0] === 'sysctl' && argv.includes('vm.loadavg') ? ok('{ 7.0 7.0 7.0 }\n') : undefined,
  })
  seedBoard(seen, 'board-load', [{ op: 'create', issue: 'load-one', title: 'Load one', status: 'todo' }])
  await $.session.start(startInput)
  await tool($, { action: 'plan', issue: 'load-one', ready: true })
  expect(seen.runs.some(argv => argv[0] === 'herdr')).toBe(false)
  expect(seen.logs.some(line => line.includes('spawn skipped: load1=7 cap=6 cores=8'))).toBe(true)
})

// Regression caught: a successful mux command whose Claude process died caused a fresh launch on every poll after the placeholder expired.
test('a co-worker that never registers is not relaunched every tick', async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], sessionId: 'main-stale-start', env: { HERDR_ENV: '1' },
    processRun: argv => argv[0] === 'herdr' && argv[1] === 'tab' ? ok(JSON.stringify({ root_pane: { pane_id: 'pane-stale' } })) : undefined,
  })
  seedBoard(seen, 'board-stale-start', [{ op: 'create', issue: 'stale-start-one', title: 'Stale start one', status: 'todo' }])
  await $.session.start(startInput)
  await tool($, { action: 'plan', issue: 'stale-start-one', ready: true })
  await seen.clock.advance(75_000); await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.runs.filter(argv => argv[0] === 'herdr' && argv[1] === 'tab')).toHaveLength(1)
  expect(Object.values(seen.files).some(value => value.includes('"failures":1') && value.includes('"lastFailedAt"'))).toBe(true)
  expect(seen.logs.some(line => line.includes('failed to register'))).toBe(true)
})

// Regression caught: deleting a failed launch placeholder erased all retry state, so every poll launched again.
test('a failing launch command backs off instead of retrying every tick', async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], sessionId: 'main-launch-failure', env: { HERDR_ENV: '1' },
    processRun: argv => argv[0] === 'herdr' && argv[1] === 'tab' ? { exitCode: 1, stdout: '', stderr: 'mux failed' } : undefined,
  })
  seedBoard(seen, 'board-launch-failure', [{ op: 'create', issue: 'launch-failure', title: 'Launch failure', status: 'todo' }])
  await $.session.start(startInput)
  await tool($, { action: 'plan', issue: 'launch-failure', ready: true })
  await seen.clock.advance(15_000); await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.runs.filter(argv => argv[0] === 'herdr' && argv[1] === 'tab')).toHaveLength(1)
  expect(JSON.parse(seen.files[`${ROOT}/coworkers/main-launch-failure.spawn-backoff.json`]!)).toMatchObject({ failures: 1 })
})

// Regression caught: a recovered co-worker left the prior launch failures active, extending later retry delays indefinitely.
test('a successful co-worker start resets the spawn backoff', async ($, on) => {
  const seen = bottoms(on, coworkerState('worker-reset-backoff', 'main-reset-backoff', {
    env: { CLM_COWORKER: '1', CLM_MAIN_SESSION: 'main-reset-backoff', CLM_COWORKER_NAME: 'clm-coworker-1' },
  }))
  seen.dirs.add(`${ROOT}/coworkers`)
  seen.files[`${ROOT}/coworkers/main-reset-backoff.spawn-backoff.json`] = JSON.stringify({ failures: 4, lastFailedAt: 100 })
  seedRecord(seen, { session: 'clm-coworker-1', main: 'main-reset-backoff', repo: 'github.com/o/repo', state: 'starting', heartbeat: 100 })
  await $.session.start(startInput)
  expect(JSON.parse(seen.files[`${ROOT}/coworkers/main-reset-backoff.spawn-backoff.json`]!)).toEqual({ failures: 0 })
})

const herdrTab = (n: number) => ok(JSON.stringify({ id: 'cli:tab:create', result: { root_pane: { pane_id: `w9:p${n}`, tab_id: `w9:t${n}` }, tab: { tab_id: `w9:t${n}` }, type: 'tab_created' } }))
const paneBusy = { exitCode: 1, stdout: JSON.stringify({ error: { code: 'agent_pane_busy', message: 'agent target pane w9:p2 is not an available shell' } }), stderr: '' }

// Regression caught (e2e 2026-10-29): `agent start` ran before the new pane's shell prompt was ready, failed with agent_pane_busy, and the tab stayed behind as an orphan.
test('a pane still starting its shell is retried until the agent starts, in the same tab', async ($, on) => {
  let starts = 0
  const seen = bottoms(on, {
    rows: [], replies: [], sessionId: 'main-pane-busy', env: { HERDR_ENV: '1' },
    processRun: argv => argv[0] === 'herdr' && argv[1] === 'tab' && argv[2] === 'create' ? herdrTab(2)
      : argv[0] === 'herdr' && argv[1] === 'agent' ? (++starts < 3 ? paneBusy : ok()) : undefined,
  })
  seedBoard(seen, 'board-pane-busy', [{ op: 'create', issue: 'pane-busy', title: 'Pane busy', status: 'todo' }])
  await $.session.start(startInput)
  const planned = tool($, { action: 'plan', issue: 'pane-busy', ready: true })
  for (let i = 0; i < 20 && starts < 3; i++) { await settle(); await seen.clock.advance(250) }
  await planned
  expect(starts).toBe(3)
  expect(seen.runs.filter(argv => argv[0] === 'herdr' && argv[1] === 'tab')).toEqual([expect.arrayContaining(['herdr', 'tab', 'create'])])
  expect(seen.files[`${ROOT}/coworkers/main-pane-busy.spawn-backoff.json`]).toBeUndefined()
})

// Regression caught (e2e 2026-10-29): a launch that failed after `tab create` left the tab open, so the backed-off retry opened a second one.
test('a launch that fails after creating the tab closes that tab and logs the herdr error envelope', async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], sessionId: 'main-orphan-tab', env: { HERDR_ENV: '1' },
    processRun: argv => argv[0] === 'herdr' && argv[1] === 'tab' && argv[2] === 'create' ? herdrTab(4)
      : argv[0] === 'herdr' && argv[1] === 'agent' ? { exitCode: 1, stdout: '{"error":{"code":"agent_start_failed"}}', stderr: '' } : undefined,
  })
  seedBoard(seen, 'board-orphan-tab', [{ op: 'create', issue: 'orphan-tab', title: 'Orphan tab', status: 'todo' }])
  await $.session.start(startInput)
  await tool($, { action: 'plan', issue: 'orphan-tab', ready: true })
  expect(seen.runs.filter(argv => argv[0] === 'herdr' && argv[1] === 'agent')).toHaveLength(1)
  expect(seen.runs).toContainEqual(['herdr', 'tab', 'close', 'w9:t4'])
  expect(seen.logs.some(line => line.includes('launch failed') && line.includes('agent_start_failed'))).toBe(true)
  expect(JSON.parse(seen.files[`${ROOT}/coworkers/main-orphan-tab.spawn-backoff.json`]!)).toMatchObject({ failures: 1 })
})
