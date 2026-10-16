import { test, expect } from 'claude-code/testing'
import type { AgentInfo } from 'claude-code'
import { reconcileAgents, recordCompletion, recordMessage, withoutStaleDone } from './fleet'

// Regression: a stale listing requested before completion cannot undo the newer turn.complete event.
test('reconcile keeps a completion newer than the agent.list request', () => {
  const done = recordCompletion([], 'agent-1', 'Finished the task', 10_000)
  const listed: AgentInfo[] = [{ id: 'agent-1', description: 'work', type: 'codex-subagent:sol', status: 'running' }]
  const merged = reconcileAgents(done, listed, 5_000, 20_000)

  expect(merged).toHaveLength(1)
  expect(merged[0]?.status).toBe('done')
  expect(merged[0]?.finishedAt).toBe(10_000)
  expect(merged[0]?.type).toBe('codex-subagent:sol')
})

// Regression: a SendMessage resume after turn.complete must restore running status and elapsed time.
test('a message revives a completed agent', () => {
  const done = recordCompletion([], 'agent-1', 'Finished the task', 10_000)
  const resumed = recordMessage(done, 'agent-1', 'Continue with the next part', 20_000)

  expect(resumed[0]?.status).toBe('running')
  expect(resumed[0]?.finishedAt).toBeUndefined()
  expect(resumed[0]?.startedAt).toBe(10_000)
  expect(resumed[0]?.lastMessage).toBe('Continue with the next part')
})

// Regression: an agent omitted from a fresh listing cannot stay running forever.
test('reconcile finishes agents missing from the listing', () => {
  const running = recordMessage([], 'agent-1', 'Working', 10_000)
  const merged = reconcileAgents(running, [], 15_000, 20_000)

  expect(merged[0]?.status).toBe('done')
  expect(merged[0]?.finishedAt).toBe(20_000)
})

// Regression: every finished agent of the session stayed in dash, pushing running ones out of view.
test('only the two most recently finished agents survive alongside running ones', () => {
  let agents = recordMessage([], 'running', 'Working', 1_000)
  for (const [id, at] of [['old', 2_000], ['newest', 5_000], ['middle', 4_000]] as const) agents = recordCompletion(agents, id, 'done', at)

  expect(withoutStaleDone(agents, 2).map(agent => agent.id).sort()).toEqual(['middle', 'newest', 'running'])
})
