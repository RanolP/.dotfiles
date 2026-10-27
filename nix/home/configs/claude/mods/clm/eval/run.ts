import type { SessionMessage } from 'claude-code'
import { isLedgerRow, isSystemRow, isUserTyped, protectedIndex, sum } from '../hooks/fold'
import { REVIEW_SYSTEM, SPLIT_MERGE_SYSTEM } from '../hooks/ledger'
import { isRecord } from '../hooks/tracker'

type Kind = 'instruction' | 'decision' | 'focus' | 'fact' | 'stack'
export type Probe = { id: string; fixture: string; kind: Kind; expect: string; mustBe: 'resident' | 'resident-or-recall'; forbid?: string }
export type Fixture = { id: string; sessionId: string; rows: SessionMessage[] }
type Result = { id: string; kind: Kind; pass: boolean }
type RecordReply = { fixture: string; reply: string }
export type Mode = 'stub' | 'real'
type On = (event: string, handler: (...args: any[]) => unknown) => void

export const QUEUE_TARGET = 8_000
const OPTIONS = { budget: 32_000, tailTarget: 1_800, queueTarget: QUEUE_TARGET, ledgerTarget: 900, reserve: 1_000, model: 'haiku', reviewModel: 'haiku' }
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
const rowText = (row: SessionMessage) => [row.text, ...row.toolUses.map(use => `${use.tool} ${JSON.stringify(use.input ?? {})}`), ...(row.toolResults ?? []).map(result => result.text)].join('\n')

function installHarness(
  on: On, current: () => Fixture, files: Record<string, string>, store: Record<string, unknown>, logs: string[],
  replies: Readonly<Record<string, RecordReply>>, recorded: RecordReply[], mode: Mode,
) {
  let splitCalls = 0
  on('session.id', () => ({ value: current().sessionId }))
  on('session.messages', () => ({ value: current().rows }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000, tokens: 32_000 }, rateLimits: [] } }))
  on('session.cwd', () => ({ value: '/work/clm-eval' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-15T00:00:00Z') }))
  on('store.get', (_: unknown, event: { key: string }) => ({ value: store[event.key] }))
  on('store.set', (_: unknown, event: { key: string; value: unknown }) => { store[event.key] = event.value; return { value: undefined } })
  on('store.delete', (_: unknown, event: { key: string }) => { delete store[event.key]; return { value: undefined } })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('env.get', async (_: unknown, event: { name: string }, next: (e: unknown) => Promise<unknown>) => event.name === 'HOME'
    ? { value: '/home/t' }
    : next(event))
  on('fs.exists', (_: unknown, event: { path: string }) => ({ value: event.path in files || Object.keys(files).some(path => path.startsWith(`${event.path}/`)) }))
  on('fs.list', (_: unknown, event: { path: string }) => ({ value: Object.keys(files)
    .filter(path => path.startsWith(`${event.path}/`) && !path.slice(event.path.length + 1).includes('/'))
    .map(path => ({ name: path.slice(event.path.length + 1), kind: 'file', size: files[path]!.length, mtimeMs: 0, isLink: false })) }))
  on('fs.read', (_: unknown, event: { path: string }) => {
    return { value: files[event.path] ?? '' }
  })
  on('fs.write', (_: unknown, event: { path: string; text: string }) => {
    files[event.path] = event.text
    return { value: undefined }
  })
  on('process.run', (_: unknown, event: { argv: string[] }) => ({ value: {
    exitCode: 0,
    stdout: event.argv.includes('get-url') ? 'git@example.invalid:synthetic/clm-eval.git\n' : event.argv.includes('--abbrev-ref') ? 'main\n' : '/work/clm-eval\n',
    stderr: '',
  } }))
  on('ui.log', (_: unknown, event: { text: string }) => { logs.push(event.text); return { value: undefined } })
  on('ui.panes', () => ({ value: [] }))
  on('command.register', (_: unknown, event: { name: string }) => ({ value: { command: event.name } }))
  on('prompt.submit', (_: unknown, event: { text: string; context?: unknown }) => ({ text: event.text, context: event.context }))
  on('tool.call', () => ({ result: { success: true } }))
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'engine summary', toolUses: [] }] }))
  on('model.complete', async ($: any, event: { system: string; prompt: string }, next: (e: unknown) => Promise<any>) => {
    if (event.system === SPLIT_MERGE_SYSTEM) {
      splitCalls++
      if (mode === 'real') {
        const result = await next(event)
        if (result.value?.isAnswered && typeof result.value.text === 'string') {
          const reply = { fixture: current().id, reply: result.value.text }
          recorded.push(reply)
          console.log(`CLM_EVAL_RECORD ${JSON.stringify({ ...reply, model: 'haiku' })}`)
        }
        return result
      }
      const reply = replies[current().id]
      if (!reply || reply.fixture !== current().id || typeof reply.reply !== 'string') throw new Error(`missing recorded reply for ${current().id}`)
      return { value: { isAnswered: true, text: reply.reply, usage: {} } }
    }
    if (event.system === REVIEW_SYSTEM) return { value: { isAnswered: true, text: '{"verdicts":[]}', usage: {} } }
    logs.push(`unmocked model.complete: ${event.system.slice(0, 100)}`)
    return next(event)
  })
  return () => splitCalls
}

export function createHarness(on: On, fixtures: readonly Fixture[], replies: Readonly<Record<string, RecordReply>>) {
  let active = fixtures[0]!
  const files: Record<string, string> = {}
  const store: Record<string, unknown> = {}
  const logs: string[] = []
  const recorded: RecordReply[] = []
  const splitCalls = installHarness(on, () => active, files, store, logs, replies, recorded, evalMode())
  return {
    files, store, logs, recorded, splitCalls,
    sessionValue(session: string, key: string) {
      try {
        const value: unknown = JSON.parse(files[`/home/t/.claude-work/plans/clm-${session}.state.json`] ?? '{}')
        if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, key)) return value[key]
      } catch { /* malformed fixture state reads as absent */ }
      return undefined
    },
    select: (fixture: Fixture) => { active = fixture },
    queueTokens: (fixture: Fixture) => sum(fixture.rows.slice(protectedIndex(fixture.rows) + 1)),
    score: (fixture: Fixture, probes: readonly Probe[], messages: readonly SessionMessage[]) => probes
      .filter(item => item.fixture === fixture.id)
      .map(item => score(item, fixture, residentText(messages))),
    seedResidentState: (fixture: Fixture) => {
      const rows = fixture.rows.filter(row => row.role === 'user').map(row => row.text)
      const key = `${fixture.sessionId}:main`
      if (fixture.id === 'f757aaf2') {
        const upgrade = rows.find(text => text.includes('upgrade했을 때 벤치마크'))
        const cache = rows.find(text => text.includes('캐시만 패치해서 벤치마크'))
        if (!upgrade || !cache) throw new Error('f757aaf2 is missing benchmark correction rows')
        files[`/home/t/.claude-work/plans/clm-${fixture.sessionId}.state.json`] = JSON.stringify({ [`clauses:${key}`]: {
          version: 1, nextId: 3, predicates: { benchmark: { key: 1, example: 'benchmark(tool, method).' } }, clauses: [
            { id: 'C1', head: { name: 'benchmark', args: [{ atom: 'stylelint' }, { atom: 'upgrade' }] }, neg: false, body: [], source: 'benchmark(stylelint, upgrade).', text: 'stylelint를 업그레이드한 상태로 벤치마크한다.', quote: upgrade, address: '@00000004', promptSeq: 4, issue: null, at: '2026-10-15T00:00:04Z', status: 'retracted', retraction: { at: '2026-10-15T00:00:05Z', by: 'C2', bySource: 'benchmark(stylelint, cache_patch_only).', reason: 'conflict' } },
            { id: 'C2', head: { name: 'benchmark', args: [{ atom: 'stylelint' }, { atom: 'cache_patch_only' }] }, neg: false, body: [], source: 'benchmark(stylelint, cache_patch_only).', text: '캐시만 패치한 상태로 stylelint 벤치마크를 돌린다.', quote: cache, address: '@00000005', promptSeq: 5, issue: null, at: '2026-10-15T00:00:05Z', status: 'live' },
          ],
        } })
        return
      }
      const globalRule = rows.find(text => text.startsWith('Never push '))
      const scopedRule = rows.find(text => text.startsWith('For '))
      const focusPrompt = rows.find(text => text.startsWith('Help me review '))
      const transition = rows.find(text => text.startsWith('Reverse that decision: '))
      const mainIssue = transition?.match(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g)?.at(-1)
      const sideIssue = transition?.match(/Interleave ([A-Z][A-Z0-9]{1,9}-\d+) above/)?.[1]
      if (!globalRule || !scopedRule || !focusPrompt || !transition || !mainIssue || !sideIssue)
        throw new Error(`${fixture.id} is missing instruction or focus transcript rows`)
      const title = `${focusPrompt.replace(/^Help me review the /, '').replace(/\.$/, '')} [${mainIssue}]`
      const origin = { session: fixture.sessionId, repo: 'example.invalid/synthetic/clm-eval', cwd: '/work/clm-eval' }
      const at = (seq: number) => new Date(Date.parse('2026-10-15T00:00:00Z') + seq * 1000).toISOString()
      const events = [
        { ts: at(1), seq: 1, issue: mainIssue, origin, op: 'create', title, status: 'doing' },
        { ts: at(2), seq: 2, issue: fixture.sessionId, origin, op: 'focus', stack: [mainIssue], pending: [], intent: 'handoff' },
        { ts: at(3), seq: 3, issue: sideIssue, origin, op: 'create', title: `side review [${sideIssue}]`, status: 'doing' },
        { ts: at(4), seq: 4, issue: mainIssue, origin, op: 'status', status: 'todo' },
        { ts: at(5), seq: 5, issue: sideIssue, origin, op: 'parent', parent: mainIssue },
        { ts: at(6), seq: 6, issue: fixture.sessionId, origin, op: 'focus', stack: [mainIssue, sideIssue], pending: [], intent: 'interleave' },
        { ts: at(7), seq: 7, issue: sideIssue, origin, op: 'status', status: 'done' },
        { ts: at(8), seq: 8, issue: mainIssue, origin, op: 'status', status: 'doing' },
        { ts: at(9), seq: 9, issue: fixture.sessionId, origin, op: 'focus', stack: [mainIssue], pending: [], intent: 'continue' },
      ]
      files[`/home/t/.claude-work/tracker/events/${fixture.sessionId}.jsonl`] = events.map(event => JSON.stringify(event)).join('\n') + '\n'
      files[`/home/t/.claude-work/plans/clm-${fixture.sessionId}.state.json`] = JSON.stringify({
        [`clauses:${key}`]: {
        version: 1, nextId: 3, predicates: { preserve: { key: 0, example: 'preserve(scope).' } }, clauses: [
          { id: 'C1', head: { name: 'preserve', args: [{ atom: 'global' }] }, neg: false, body: [], source: 'preserve(global).', text: globalRule, quote: globalRule, address: '@00000001', promptSeq: 1, issue: null, at: at(1), status: 'live' },
          { id: 'C2', head: { name: 'preserve', args: [{ atom: 'scope' }] }, neg: false, body: [], source: 'preserve(scope).', text: scopedRule, quote: scopedRule, address: '@00000002', promptSeq: 2, issue: mainIssue, at: at(2), status: 'live' },
        ],
        },
        [`issue-addresses:${key}`]: { [mainIssue]: '@00000003' },
      })
    },
    options: OPTIONS,
  }
}

export function evalMode(): Mode {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.CLM_EVAL_MODE === 'real' ? 'real' : 'stub'
}

function residentText(messages: readonly SessionMessage[]): string {
  const ledgerIndex = messages.findIndex(row => row.text.startsWith('[clm ledger #'))
  if (ledgerIndex < 0) throw new Error('fold result has no ledger row')
  return [messages[ledgerIndex]!.text, ...messages.slice(ledgerIndex + 1).map(rowText)].join('\n')
}

export const residentTokenEstimate = (messages: readonly SessionMessage[]): number =>
  sum([{ role: 'user', text: residentText(messages), toolUses: [] }])

function recalledText(address: string, fixture: Fixture): string[] {
  const rowRef = /^m(\d+)$/i.exec(address)
  if (rowRef) {
    const first = protectedIndex(fixture.rows)
    const sources = fixture.rows.slice(first + 1).filter(row => !isSystemRow(row) && !isLedgerRow(row))
    const row = sources[Number(rowRef[1]) - 1]
    return row && isUserTyped(row) ? [rowText(row)] : []
  }
  return fixture.rows.filter(row => rowText(row).includes(address)).map(rowText)
}

function sourceAddresses(resident: string): string[] {
  const refs = [...resident.matchAll(/\bm\d+\b/gi)].map(match => match[0])
  const issues = [...resident.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d+\b/g)].map(match => match[0])
  return [...new Set([...refs, ...issues])]
}

function score(probe: Probe, fixture: Fixture, resident: string): Result {
  const normalizedResident = normalize(resident)
  if (probe.forbid && normalizedResident.includes(normalize(probe.forbid))) return { id: probe.id, kind: probe.kind, pass: false }
  if (normalizedResident.includes(normalize(probe.expect))) return { id: probe.id, kind: probe.kind, pass: true }
  if (probe.mustBe === 'resident') return { id: probe.id, kind: probe.kind, pass: false }
  const recalled = sourceAddresses(resident).some(address => recalledText(address, fixture).some(text => normalize(text).includes(normalize(probe.expect))))
  return { id: probe.id, kind: probe.kind, pass: recalled }
}

export function formatReport(results: readonly Result[]): string {
  const lines = results.map(result => `${result.pass ? 'PASS' : 'FAIL'} ${result.id} ${result.kind}`)
  lines.push('', 'by kind')
  for (const kind of ['instruction', 'decision', 'focus', 'fact', 'stack'] as const) {
    const matches = results.filter(result => result.kind === kind)
    lines.push(`${kind.padEnd(12)} ${matches.filter(result => result.pass).length}/${matches.length}`)
  }
  return lines.join('\n')
}
