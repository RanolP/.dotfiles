import { test, expect } from 'claude-code/testing'
import { coworkerBrief, detectMux, launchPlan, parseHerdrPaneId, readLoad, type SpawnIo } from './spawn'

const env = { CLM_COWORKER: '1', CLM_MAIN_SESSION: 'main-1', CLM_COWORKER_NAME: 'clm-worker' } as const

// Regression caught: Herdr could focus the new tab or start Claude outside the tab's root pane.
test('herdr launch creates an unfocused tab and starts claude in its root pane', () => {
  const plan = launchPlan({ mux: 'herdr', cwd: '/repo/worktree', name: 'clm-worker', env, brief: 'Do the work', herdrWorkspaceId: 'w4K' })
  if (!('steps' in plan)) throw new Error('expected argv steps')
  expect(plan.steps[0]!.argv).toEqual(['herdr', 'tab', 'create', '--workspace', 'w4K', '--cwd', '/repo/worktree', '--label', 'clm-worker', '--env', 'CLM_COWORKER=1', '--env', 'CLM_MAIN_SESSION=main-1', '--env', 'CLM_COWORKER_NAME=clm-worker', '--no-focus'])
  const stdout = JSON.stringify({ id: 'cli:tab:create', result: { root_pane: { agent_status: 'unknown', cwd: '/repo/worktree', focused: false, pane_id: 'w4K:p1', tab_id: 'w4K:t1', workspace_id: 'w4K' }, tab: {}, type: 'tab_created' } })
  expect(parseHerdrPaneId(stdout)).toBe('w4K:p1')
  expect(plan.steps[1]!.argvFromPrevious?.(stdout)).toEqual(['herdr', 'agent', 'start', 'clm-worker', '--kind', 'claude', '--pane', 'w4K:p1', '--', 'Do the work'])
  expect(plan.steps[0]!.undo?.(stdout)).toEqual(['herdr', 'tab', 'close', 'w4K:t1'])
})

test('herdr launch omits the workspace flag when no workspace id is available', () => {
  const plan = launchPlan({ mux: 'herdr', cwd: '/repo/worktree', name: 'clm-worker', env, brief: 'Do the work' })
  if (!('steps' in plan)) throw new Error('expected argv steps')
  expect(plan.steps[0]!.argv).not.toContain('--workspace')
})

// Regression caught: alternate mux launchers could omit orchestration identity or steal the active pane.
test('zellij and tmux launch argv carry the co-worker env and never take focus', () => {
  const zellij = launchPlan({ mux: 'zellij', cwd: '/repo/worktree', name: 'clm-worker', env, brief: 'Do the work' })
  const tmux = launchPlan({ mux: 'tmux', cwd: '/repo/worktree', name: 'clm-worker', env, brief: 'Do the work' })
  if (!('steps' in zellij) || !('steps' in tmux)) throw new Error('expected argv steps')
  expect(zellij.steps[0]).toEqual({ argv: ['zellij', 'run', '--name', 'clm-worker', '--cwd', '/repo/worktree', '--no-focus', '--', 'env', 'CLM_COWORKER=1', 'CLM_MAIN_SESSION=main-1', 'CLM_COWORKER_NAME=clm-worker', 'claude', 'Do the work'] })
  expect(tmux.steps[0]).toEqual({ argv: ['tmux', 'new-window', '-d', '-c', '/repo/worktree', '-e', 'CLM_COWORKER=1', '-e', 'CLM_MAIN_SESSION=main-1', '-e', 'CLM_COWORKER_NAME=clm-worker', '-n', 'clm-worker', 'claude', 'Do the work'] })
  expect(zellij.steps[0]!.argv).toContain('--no-focus')
  expect(tmux.steps[0]!.argv).toContain('-d')
})

// Regression caught: braces in Darwin load output and trailing Linux fields could corrupt the load cap.
test('readLoad parses darwin sysctl and linux proc output', async () => {
  const darwin: SpawnIo = {
    run: async argv => argv.includes('vm.loadavg')
      ? { exitCode: 0, stdout: '{ 2.98 3.85 7.10 }\n', stderr: '' }
      : { exitCode: 0, stdout: '12\n', stderr: '' },
    read: async () => undefined,
  }
  const linux: SpawnIo = {
    run: async () => ({ exitCode: 0, stdout: '8\n', stderr: '' }),
    read: async path => path === '/proc/loadavg' ? '1.25 2.00 3.00 1/100 123\n' : undefined,
  }
  expect(await readLoad(darwin)).toEqual({ load1: 2.98, cores: 12 })
  expect(await readLoad(linux)).toEqual({ load1: 1.25, cores: 8 })
})

// Regression caught: mux detection could choose an inner multiplexer over Herdr's orchestration context.
test('detectMux prefers herdr, then zellij, then tmux', () => {
  expect(detectMux({ HERDR_ENV: '1', ZELLIJ: '1', TMUX: '1' })).toBe('herdr')
  expect(detectMux({ ZELLIJ: '1', TMUX: '1' })).toBe('zellij')
  expect(detectMux({ TMUX: '1' })).toBe('tmux')
  expect(detectMux({})).toBe('none')
})

// Regression caught: the initial session prompt could omit the claim-to-ready handoff protocol.
test('coworker brief names the main session, repo, worktree boundary, and handoff actions', () => {
  const brief = coworkerBrief({ main: 'main-1', repo: '/repo' })
  for (const text of ['main-1', '/repo', 'SendMessage', 'clm_coworker', 'claim', 'returned worktree', 'checkpoint', 'ready']) expect(brief).toContain(text)
})

// Regression caught: a co-worker started under another CLAUDE_CONFIG_DIR cannot exchange messages with main.
test('launch env carries CLAUDE_CONFIG_DIR when set and omits it when unset', () => {
  const plan = launchPlan({ mux: 'tmux', cwd: '/repo', name: 'clm-worker', env: { ...env, CLAUDE_CONFIG_DIR: '/home/u/.claude-work' }, brief: 'b' })
  if (!('steps' in plan)) throw new Error('expected argv steps')
  expect(plan.steps[0]!.argv).toContain('CLAUDE_CONFIG_DIR=/home/u/.claude-work')
  const bare = launchPlan({ mux: 'tmux', cwd: '/repo', name: 'clm-worker', env, brief: 'b' })
  if (!('steps' in bare)) throw new Error('expected argv steps')
  expect(bare.steps[0]!.argv!.some(value => value.startsWith('CLAUDE_CONFIG_DIR'))).toBe(false)
})
