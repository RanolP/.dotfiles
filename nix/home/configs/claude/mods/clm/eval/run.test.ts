import { expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { createHarness, formatReport, type Fixture, type Probe } from './run'
import { fixtures as fixtureData, probes as probeData, replies as replyData } from './data'

const OPTIONS = { budget: 32_000, tailTarget: 1_800, queueTarget: 8_000, ledgerTarget: 900, reserve: 1_000, model: 'haiku', reviewModel: 'haiku' }

test('the folded ledger retains or can resolve every declared fact', { options: OPTIONS }, async ($, on) => {
  const fixtures = [fixtureData.release, fixtureData.auth, fixtureData.migration] as unknown as Fixture[]
  const harness = createHarness(on, fixtures, replyData)
  const results: { id: string; kind: Probe['kind']; pass: boolean }[] = []
  for (const fixture of fixtures) {
    harness.select(fixture)
    harness.seedResidentState(fixture)
    const tokens = harness.queueTokens(fixture)
    if (tokens < 8_000 || tokens >= 16_000) throw new Error(`${fixture.id} queue has ${tokens} tokens; expected one crossing of queueTarget 8000`)
    const callsBefore = harness.splitCalls()
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: `turn-${fixture.id}`, reason: 'answer' })
    const pendingKey = `pending:${fixture.sessionId}`
    for (let i = 0; i < 2_000 && harness.store[pendingKey] === undefined; i++) await new Promise(resolve => setTimeout(resolve, 1))
    if (harness.store[pendingKey] === undefined) throw new Error(`${fixture.id} did not produce a queued fold; split calls=${harness.splitCalls() - callsBefore}; logs=${harness.logs.slice(-8).join(' | ')}`)
    const messages = fixture.rows.map((row, index) => ({ ...row, handle: `eval-${index}` } satisfies SessionMessage))
    const compacted = await $.session.compact({ trigger: 'plugin', messages })
    if (!compacted || !Array.isArray(compacted.messages)) throw new Error(`${fixture.id} compaction returned no messages`)
    if (harness.splitCalls() - callsBefore !== 1) throw new Error(`${fixture.id} crossed queueTarget with ${harness.splitCalls() - callsBefore} split-summary calls`)
    results.push(...harness.score(fixture, probeData as unknown as Probe[], compacted.messages))
  }
  console.log(formatReport(results))
  expect(results.filter(result => !result.pass).length).toBe(0)
})
