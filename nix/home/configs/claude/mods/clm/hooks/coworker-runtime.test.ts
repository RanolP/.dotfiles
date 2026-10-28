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

const seedRecord = (seen: ReturnType<typeof bottoms>, record: CoworkerRecord) => {
  seen.dirs.add(`${ROOT}/coworkers`)
  seen.files[`${ROOT}/coworkers/${record.session}.json`] = JSON.stringify(record)
}

const seedMail = (seen: ReturnType<typeof bottoms>, to: string, from: string, text: string, n = 1) => {
  seen.dirs.add(`${ROOT}/mail`)
  seen.dirs.add(`${ROOT}/mail/${to}`)
  seen.files[`${ROOT}/mail/${to}/${String(n).padStart(16, '0')}-mail.json`] = JSON.stringify({ from, to, text, now: n })
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

// Regression caught: a completed co-worker checkpoint stayed in doing and never notified its orchestrator.
test('ready marks the issue ready-to-land and mails main', async ($, on) => {
  const seen = bottoms(on, coworkerState('worker-ready', 'main-ready'))
  seedBoard(seen, 'board-ready', [{ op: 'create', issue: 'ready-one', title: 'Ready one', status: 'todo' }, { op: 'plan', issue: 'ready-one', ready: true }])
  await $.session.start(startInput)
  await tool($, { action: 'claim', issue: 'ready-one' })
  const output = await tool($, { action: 'ready', issue: 'ready-one' })
  expect(resultText(output)).toContain(`${SHA_B}..${SHA_A}`)
  expect(issues(seen).find(issue => issue.id === 'ready-one')).toMatchObject({ status: 'ready-to-land', worktree: { baseSha: SHA_B, headSha: SHA_A } })
  expect(Object.values(seen.files).some(value => value.includes('ready-one is ready to land'))).toBe(true)
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
  expect(resultText(output)).toContain('worker-land was asked to rebase')
  expect(seen.runs.some(argv => argv.join(' ') === 'git -C /work/repo cherry-pick --abort')).toBe(true)
  expect(issues(seen).find(issue => issue.id === 'conflict-one')).toMatchObject({ status: 'doing', claimedBy: 'worker-land' })
  expect(Object.values(seen.files).some(value => value.includes(`main HEAD ${SHA_A}`) && value.includes('worker-land'))).toBe(true)
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
  expect(Object.values(seen.files).some(value => value.includes('rebase the issue worktree'))).toBe(false)
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

// Regression caught: mailbox polling delivered separate human-origin prompts and left files to replay.
test('mail reaches an idle session as one non-human prompt and is deleted', async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [], sessionId: 'main-mail' })
  setWorkflow(on, () => workflow())
  await $.session.start(startInput)
  seedMail(seen, 'main-mail', 'worker-a', 'first', 1)
  seedMail(seen, 'main-mail', 'worker-b', 'second', 2)
  await seen.clock.advance(5_000); await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.submissions).toEqual([{ text: '[clm message from worker-a]\nfirst\n\n[clm message from worker-b]\nsecond' }])
  expect(Object.keys(seen.files).filter(path => path.startsWith(`${ROOT}/mail/main-mail/`))).toEqual([])
})

// Regression caught: polling drained mail during an active turn, so the message was lost before it could be submitted.
test('mail waits while a turn is active and is delivered after it ends', async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [], sessionId: 'main-busy-mail' })
  let current = workflow({ activeTurnId: 'turn-1' })
  setWorkflow(on, () => current)
  await $.session.start(startInput)
  seedMail(seen, 'main-busy-mail', 'worker-a', 'wait for idle')
  await seen.clock.advance(5_000); await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.submissions).toEqual([])
  expect(Object.keys(seen.files).some(path => path.startsWith(`${ROOT}/mail/main-busy-mail/`))).toBe(true)
  current = workflow()
  await seen.clock.advance(5_000); await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.submissions).toEqual([{ text: '[clm message from worker-a]\nwait for idle' }])
})

// Regression caught: a rejected prompt submission deleted the only durable copy of co-worker mail.
test('a dropped prompt keeps the mail for the next tick', async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [], sessionId: 'main-drop-mail', promptDrops: ['busy'] })
  setWorkflow(on, () => workflow())
  await $.session.start(startInput)
  seedMail(seen, 'main-drop-mail', 'worker-a', 'retry me')
  await seen.clock.advance(5_000); await new Promise(resolve => setTimeout(resolve, 0))
  expect(Object.keys(seen.files).some(path => path.startsWith(`${ROOT}/mail/main-drop-mail/`))).toBe(true)
  await seen.clock.advance(5_000); await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.submissions).toHaveLength(2)
  expect(Object.keys(seen.files).some(path => path.startsWith(`${ROOT}/mail/main-drop-mail/`))).toBe(false)
})

// Regression caught: /clear cancelled polling under the old id and stranded mail addressed by co-workers to that main id.
test('after /clear the main session still drains co-worker mail', async ($, on) => {
  const state: State = { rows: [], replies: [], sessionId: 'main-before-clear', nextSessionId: 'main-after-clear' }
  const seen = bottoms(on, state)
  setWorkflow(on, () => workflow())
  await $.session.start(startInput)
  await $.session.end({ sessionId: 'main-before-clear', reason: 'clear' } as Parameters<typeof $.session.end>[0])
  seedMail(seen, 'main-before-clear', 'worker-a', 'addressed to the stable main id')
  await seen.clock.advance(5_000); await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.submissions.at(-1)).toEqual({ text: '[clm message from worker-a]\naddressed to the stable main id' })
  expect(JSON.parse(seen.files[`${ROOT}/coworkers/main-after-clear.json`]!)).toMatchObject({ main: 'main-before-clear' })
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

// Regression caught: deferred work reached the board without telling any available co-worker that the queue changed.
test('a classified deferral mails every live co-worker of the main session', async ($, on) => {
  const s: State = { rows: [], replies: [], sessionId: 'main-deferral', intentReplies: [intentReply({ deferred: [{ text: 'Publish later', quote: 'Publish later' }] })] }
  const seen = bottoms(on, s)
  await $.session.start(startInput)
  const now = Date.parse('2026-10-06T00:00:00Z')
  seedRecord(seen, { session: 'worker-deferral-a', main: 'main-deferral', repo: 'github.com/o/repo', state: 'idle', heartbeat: now })
  seedRecord(seen, { session: 'worker-deferral-b', main: 'main-deferral', repo: 'github.com/o/repo', state: 'busy', heartbeat: now })
  await $.prompt.submit(promptInput('Publish later'))
  for (let i = 0; i < 30 && !Object.keys(seen.files).some(path => path.includes('/mail/worker-deferral-b/')); i++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(Object.keys(seen.files).some(path => path.includes('/mail/worker-deferral-a/'))).toBe(true)
  expect(Object.keys(seen.files).some(path => path.includes('/mail/worker-deferral-b/'))).toBe(true)
})

// Regression caught: ready work remained unclaimed even though Herdr was available and capacity was below the cap.
test('a ready issue with no idle co-worker launches one co-worker in the detected multiplexer', async ($, on) => {
  const seen = bottoms(on, {
    rows: [], replies: [], sessionId: 'main-spawn', env: { HERDR_ENV: '1' },
    processRun: argv => argv[0] === 'herdr' && argv[1] === 'tab' ? ok(JSON.stringify({ root_pane: { pane_id: 'pane-1' } })) : undefined,
  })
  seedBoard(seen, 'board-spawn', [{ op: 'create', issue: 'spawn-one', title: 'Spawn one', status: 'todo' }])
  await $.session.start(startInput)
  const output = await tool($, { action: 'plan', issue: 'spawn-one', priority: 5, ready: true })
  expect(denial(output)).toBe('')
  expect(seen.runs.some(argv => argv[0] === 'herdr' && argv[1] === 'tab' && argv.includes('--no-focus'))).toBe(true)
  expect(seen.runs.some(argv => argv[0] === 'herdr' && argv[1] === 'agent' && argv.includes('pane-1'))).toBe(true)
})

// Regression caught: auto-dispatch spawned a duplicate session while an existing co-worker was idle.
test('an idle co-worker is mailed instead of a new spawn', async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [], sessionId: 'main-idle', env: { HERDR_ENV: '1' } })
  seedBoard(seen, 'board-idle', [{ op: 'create', issue: 'idle-one', title: 'Idle one', status: 'todo' }])
  await $.session.start(startInput)
  seedRecord(seen, { session: 'worker-idle', main: 'main-idle', repo: 'github.com/o/repo', state: 'idle', heartbeat: Date.parse('2026-10-06T00:00:00Z') })
  await tool($, { action: 'plan', issue: 'idle-one', ready: true })
  expect(Object.values(seen.files).some(value => value.includes('Claim the next ready issue') && value.includes('idle-one'))).toBe(true)
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
  expect(Object.values(seen.files).some(value => value.includes('"state":"failed"') && value.includes('"failedAt"'))).toBe(true)
  expect(seen.logs.some(line => line.includes('failed to register'))).toBe(true)
})
