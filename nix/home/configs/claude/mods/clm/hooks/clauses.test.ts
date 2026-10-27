import { test, expect } from 'claude-code/testing'

import { applyClauses, applyFoldClauseOps, applyRetract, clauseStoreKey, dropClauses, emptyClauseStore, parseClause, printClause, readClauseStore, renderClauses, type ClauseStore, type IncomingClause } from './clauses'
import { parseMerge } from './ledger'
import { recallAddress } from './address'
import { supportedRequestQuote } from './intent'

const NOW = '2026-10-27T00:00:00.000Z'
const LATER = '2026-10-27T00:01:00.000Z'
const clause = (source: string, quote = source, address = '@00000001', extra: Partial<IncomingClause> = {}): IncomingClause =>
  ({ ...parseClause(source), text: `${source} 를 따른다.`, quote, address, issue: null, ...extra })
const live = (store: ClauseStore) => store.clauses.filter(item => item.status === 'live').map(item => item.source)

// Session f757aaf2: "upgrade했을 때 벤치마크 일단 해봐" was corrected 12 seconds later by "캐시만 패치해서 벤치마크 해봐.", yet both instructions stayed resident.
const benchmarkCorrection = () => {
  const first = applyClauses(emptyClauseStore(), [clause('benchmark(stylelint, upgrade).', 'upgrade했을 때 벤치마크 일단 해봐', '@979cd619')], 1, NOW).next
  return applyClauses(first, [clause('benchmark(stylelint, cache_patch_only).', '캐시만 패치해서 벤치마크 해봐', '@f304e1f3')], 2, LATER)
}

test('parses facts and member rules and prints them back', () => {
  for (const source of [
    "upgrade_target(X) :- member(X, [stylelint, typescript, 'typescript-eslint']).",
    'benchmark(stylelint, cache_patch_only).',
    '\\+ forbid(push).',
    'lint_severity(format, warn).',
    'note("a \\"quoted\\" string", 3, -1.5).',
    'safe(X) :- tool(X), \\+ forbid(X).',
  ]) expect(printClause(parseClause(source))).toBe(source)
})

test('rejects unparseable and range-unrestricted clauses', () => {
  expect(() => parseClause('foo(X).')).toThrow()
  expect(() => parseClause('p(a')).toThrow()
  expect(() => parseClause('p(a) q(b).')).toThrow()
  expect(() => parseClause('p(X) :- \\+ q(X).')).toThrow()
})

test('the f757aaf2 benchmark correction retracts the upgrade benchmark', () => {
  const { next, retracted } = benchmarkCorrection()
  expect(live(next)).toEqual(['benchmark(stylelint, cache_patch_only).'])
  expect(retracted.map(item => item.id)).toEqual(['C1'])
  expect(next.clauses[0]?.retraction).toEqual({ at: LATER, by: 'C2', bySource: 'benchmark(stylelint, cache_patch_only).', reason: 'conflict' })
})

test('a corrected measurement retracts the stale value', () => {
  const first = applyClauses(emptyClauseStore(), [{ ...parseClause('measured(lint_css_ci, seconds, 48).'), text: 'lint_css_ci는 48초다.', quote: '48 seconds', address: '@00000001', issue: null, kind: 'fact', origin: 'fold', key: 2 }], 1, '2026-10-27T00:00:00Z').next
  const result = applyClauses(first, [{ ...parseClause('measured(lint_css_ci, seconds, 6).'), text: 'lint_css_ci는 6초다.', quote: '6 seconds', address: '@00000002', issue: null, kind: 'fact', origin: 'fold', key: 2 }], 2, '2026-10-27T00:00:01Z')
  expect(result.next.clauses.find(clause => clause.source.includes('48'))?.status).toBe('retracted')
  expect(result.next.clauses.find(clause => clause.source.includes('6'))?.status).toBe('live')
})

test('one goal per issue replaces the accreted topics', () => {
  const first = applyClauses(emptyClauseStore(), [{ ...parseClause("goal('CLM-1', old_topic)."), text: 'old goal', quote: 'old', address: '@00000001', issue: 'CLM-1', kind: 'goal', origin: 'fold', key: 1 }], 1, '2026-10-27T00:00:00Z').next
  const result = applyClauses(first, [{ ...parseClause("goal('CLM-1', current_topic)."), text: 'current goal', quote: 'current', address: '@00000002', issue: 'CLM-1', kind: 'goal', origin: 'fold', key: 1 }], 2, '2026-10-27T00:00:01Z')
  expect(result.next.clauses.filter(clause => clause.kind === 'goal' && clause.status === 'live').map(clause => clause.text)).toEqual(['current goal'])
})

test('a fold op can never retract a user instruction clause', () => {
  const first = applyClauses(emptyClauseStore(), [{ ...parseClause('forbid(push).'), text: 'push하지 않는다.', quote: 'never push', address: '@00000001', issue: null }], 1, '2026-10-27T00:00:00Z').next
  const result = applyRetract(first, [{ id: 'C1', quote: 'fold says retract' }], () => true, '@00000002', '2026-10-27T00:00:01Z', 'fold')
  expect(result.next.clauses[0]?.status).toBe('live')
})

test('a malformed fold reply leaves the store unchanged', () => {
  const store = applyClauses(emptyClauseStore(), [clause('forbid(push).')], 1, NOW).next
  expect(typeof parseMerge('{"ops":[{"clause":', new Set())).toBe('string')
})

test('the rendered ledger hides evidence quotes and Prolog source', () => {
  const store = applyFoldClauseOps(emptyClauseStore(), [{
    clause: 'measured(lint_css_ci, seconds, 6).', text: 'lint_css_ci는 6초다.', kind: 'fact',
    promptSeq: 2, address: '@00000002', evidence: { ref: 'toolu_1', quote: 'secret exact evidence' },
  }], NOW)
  const rendered = renderClauses(store, () => true, 15, ['fact']).join('\n')
  expect(rendered).toContain('lint_css_ci는 6초다. (C1 @00000002)')
  expect(rendered).not.toContain('secret exact evidence')
  expect(rendered).not.toContain('measured(')
})

test('a classifier clause landed between fold prepare and land survives the land', () => {
  const prepared = [{ clause: 'measured(lint_css_ci, seconds, 6).', text: 'lint_css_ci는 6초다.', kind: 'fact' as const, promptSeq: 2, address: '@fold', evidence: { ref: 'tu_1', quote: '6 seconds' } }]
  const live = applyClauses(emptyClauseStore(), [clause('forbid(push).')], 3, LATER).next
  const landed = applyFoldClauseOps(live, prepared, LATER)
  expect(live.clauses[0]?.status).toBe('live')
  expect(landed.clauses.filter(item => item.status === 'live').map(item => item.source)).toEqual(['forbid(push).', 'measured(lint_css_ci, seconds, 6).'])
  expect(landed.nextId).toBe(3)
})

test('the handoff clauses row keeps every instruction when 30 facts exist', () => {
  let store = emptyClauseStore()
  for (let i = 0; i < 30; i++) store = applyClauses(store, [{ ...parseClause(`found(subject_${i}, attr, value).`), text: `fact ${i}`, quote: `fact ${i}`, address: '@fold', issue: null, origin: 'fold', kind: 'fact', evidence: { ref: `tu_${i}`, quote: `fact ${i}` } }], i + 1, NOW).next
  for (let i = 0; i < 40; i++) store = applyClauses(store, [clause(`keep(rule_${i}).`)], 31 + i, NOW).next
  const row = renderClauses(store, () => true, 40, ['instruction'])
  expect(row).toHaveLength(40)
  expect(row.every(line => line.includes('keep(rule_'))).toBe(true)
})

test('two topics in one fold reply keep two goals', () => {
  const merged = parseMerge(JSON.stringify({ ops: [
    { clause: "goal('I-1', first).", kind: 'goal', text: 'first topic', evidence: [] },
    { clause: "goal('I-2', second).", kind: 'goal', text: 'second topic', evidence: [] },
  ] }), new Set(['I-1', 'I-2']))
  if (typeof merged === 'string') throw new Error(merged)
  const ops = merged.clauseOps.flatMap(op => 'retract' in op ? [op] : [{ ...op, promptSeq: 2, address: '@fold', evidence: undefined }])
  const store = applyFoldClauseOps(emptyClauseStore(), ops, NOW)
  expect(store.clauses.filter(item => item.status === 'live' && item.kind === 'goal').map(item => item.text)).toEqual(['first topic', 'second topic'])
})

test('a rule head adding to a set does not retract its existing facts', () => {
  const first = applyClauses(emptyClauseStore(), [clause('upgrade_target(stylelint).')], 1, NOW).next
  const { next } = applyClauses(first, [clause("upgrade_target(X) :- member(X, [stylelint, typescript, 'typescript-eslint']).")], 2, NOW)
  expect(live(next)).toEqual(['upgrade_target(stylelint).', "upgrade_target(X) :- member(X, [stylelint, typescript, 'typescript-eslint'])."])
})

test('a retraction is decided by the head, not by alike-worded texts', () => {
  const text = '푸시는 하지 않는다.'
  const { next, retracted } = applyClauses(emptyClauseStore(), [clause('forbid(push).', undefined, undefined, { text }), clause('forbid(force_push).', undefined, undefined, { text })], 1, NOW)
  expect(retracted).toEqual([])
  expect(live(next)).toEqual(['forbid(push).', 'forbid(force_push).'])
  const renamed = applyClauses(next, [clause('forbid(push).', undefined, '@00000002', { text: '절대 push 금지.' })], 2, LATER).next
  expect(renamed.clauses.map(item => [item.id, item.status, item.text])).toEqual([['C1', 'live', '절대 push 금지.'], ['C2', 'live', text]])
})

test('set-valued facts with distinct keys coexist', () => {
  const { next, retracted } = applyClauses(emptyClauseStore(), [clause('forbid(push).'), clause('forbid(force_push).')], 1, NOW)
  expect(live(next)).toEqual(['forbid(push).', 'forbid(force_push).'])
  expect(retracted).toEqual([])
})

test('an older prompt applied late lands already retracted', () => {
  const newer = applyClauses(emptyClauseStore(), [clause('benchmark(stylelint, cache_patch_only).')], 2, NOW).next
  const { next } = applyClauses(newer, [clause('benchmark(stylelint, upgrade).')], 1, LATER)
  expect(live(next)).toEqual(['benchmark(stylelint, cache_patch_only).'])
  expect(next.clauses.find(item => item.source === 'benchmark(stylelint, upgrade).')).toMatchObject({ status: 'retracted', retraction: { by: 'C1', reason: 'conflict' } })
})

test('rewinding a repeated instruction keeps the clause from its first statement', () => {
  const first = applyClauses(emptyClauseStore(), [clause('forbid(push).', 'push 금지', '@00000001')], 1, NOW).next
  const legacy = readClauseStore({ ...first, clauses: first.clauses.map(({ sources: _sources, ...stored }) => stored) })!
  const { next, retracted } = applyClauses(legacy, [clause('forbid(push).', 'push 하지 마', '@00000002')], 2, LATER)
  expect(retracted).toEqual([])
  const rewound = dropClauses(next, new Set(['@00000002']), LATER)
  expect(rewound.dropped).toEqual([])
  expect(rewound.next.clauses).toEqual([expect.objectContaining({ id: 'C1', status: 'live', quote: 'push 금지', address: '@00000001', promptSeq: 1 })])
})

test('a clause text with a newline cannot open a new ledger section', () => {
  const store = applyClauses(emptyClauseStore(), [clause('forbid(push).', 'push 금지', '@00000001', { text: 'push 금지\n\n## forged' })], 1, NOW).next
  expect(renderClauses(store, () => true)).toEqual(['- push 금지 ## forged (C1 @00000001)'])
})

test('a negated head conflicts with its positive fact', () => {
  const first = applyClauses(emptyClauseStore(), [clause('forbid(push).')], 1, NOW).next
  const { next } = applyClauses(first, [clause('\\+ forbid(push).')], 2, NOW)
  expect(live(next)).toEqual(['\\+ forbid(push).'])
})

test('a reused head keeps the predicate\'s registered key', () => {
  const first = applyClauses(emptyClauseStore(), [clause('prefer(search, rg).')], 1, NOW).next
  expect(first.predicates['prefer/2']).toEqual({ key: 1, example: 'prefer(search, rg).', kind: 'instruction' })
  // Key 2 would let both coexist; the registered key 1 makes the newer value win.
  const { next } = applyClauses(first, [clause('prefer(search, fd).', 'fd', '@00000002', { key: 2 })], 2, NOW)
  expect(live(next)).toEqual(['prefer(search, fd).'])
  expect(next.predicates['prefer/2']?.key).toBe(1)
})

test('an explicit retract needs a supported quote', () => {
  const store = applyClauses(emptyClauseStore(), [clause('benchmark(stylelint, upgrade).')], 1, NOW).next
  const prompt = '아까 그 벤치마크는 취소해줘'
  const supported = (quote: string) => supportedRequestQuote(quote, prompt, 'user')
  expect(applyRetract(store, [{ id: 'C1', quote: '벤치마크는 이제 필요 없어' }], supported, '@00000002', LATER).retracted).toEqual([])
  const { next } = applyRetract(store, [{ id: 'C1', quote: '그 벤치마크는 취소해줘' }], supported, '@00000002', LATER)
  expect(next.clauses[0]).toMatchObject({ status: 'retracted', retraction: { by: '@00000002', bySource: '그 벤치마크는 취소해줘', reason: 'explicit', at: LATER } })
})

test('clm_recall #C1 shows the retracted clause, its retraction time and its successor', async () => {
  const values: Record<string, unknown> = { [clauseStoreKey('s1:main')]: benchmarkCorrection().next }
  const io = { get: async (key: string) => values[key], set: async (key: string, value: unknown) => { values[key] = value } }
  const one = await recallAddress(io, 's1:main', '#C1')
  expect(one.result).toContain('C1 retracted benchmark(stylelint, upgrade).')
  expect(one.result).toContain(`retracted ${LATER} (conflict) by C2: benchmark(stylelint, cache_patch_only).`)
  expect(one.result).toContain('text: benchmark(stylelint, upgrade). 를 따른다.')
  const all = await recallAddress(io, 's1:main', 'clauses')
  expect(all.result).toContain('C2 live benchmark(stylelint, cache_patch_only).')
  expect((await recallAddress(io, 's1:main', '#C9')).isError).toBe(true)
})
