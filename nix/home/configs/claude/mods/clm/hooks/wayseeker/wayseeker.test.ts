import { test, expect } from 'claude-code/testing'

import { parseLine, printUtterance, type Utterance } from './syntax'
import { append, appendAll, emptyLedger, nextId } from './store'
import { evaluate } from './eval'

const USE = 'decl use(slot, tool) key(slot) "자리마다 쓰는 도구"'
const value = (lines: string[], fact: string, opts?: { atTime?: number; fuel?: number }) => evaluate(appendAll(lines), opts).facts.get(fact)?.value
const run = (lines: string[], opts?: { atTime?: number; fuel?: number }) => evaluate(appendAll(lines), opts)

const DIALOGUE = [
  USE,
  '@1 user: ask(use(server, ?x))',
  '@2 agent: try(use(server, sglang))',
  '@3 user: try(use(server, sglang))',
  '@4 agent: ask(use(server, sglang))',
  '@5 user: accept(@2)',
  '@6 user: say(use(server, vllm))',
]

// Regression: the page's tool-choice dialogue (L1 example) stops matching the evaluator: accept must initiate, try must not.
test('tool-choice dialogue: accept(@2) makes sglang true and answers both questions', () => {
  const before = run(DIALOGUE, { atTime: 4 })
  expect(before.facts.get('use(server, sglang)')?.value).toBe('unknown')
  expect(before.openQuestions).toEqual([1, 4])
  const at5 = run(DIALOGUE, { atTime: 5 })
  expect(at5.facts.get('use(server, sglang)')).toEqual({ value: 'true', support: [5] })
  expect(at5.openQuestions).toEqual([])
})

// Regression: a same-key say from the user fails to replace the accepted value (key(slot) functional dependency).
test('tool-choice dialogue: @6 vllm replaces sglang, and reject(@6) revives sglang', () => {
  const after = run(DIALOGUE)
  expect(after.facts.get('use(server, vllm)')?.value).toBe('true')
  expect(after.facts.get('use(server, sglang)')).toEqual({ value: 'unknown', support: [], defeatedBy: 6 })
  expect(after.flaggedTries).toEqual([2, 3])
  const revived = run([...DIALOGUE, '@7 user: reject(@6)'])
  expect(revived.facts.get('use(server, sglang)')).toEqual({ value: 'true', support: [5] })
  expect(revived.facts.get('use(server, vllm)')?.value).toBe('unknown')
})

// Regression: every user self-correction surfacing as a raise (worker C's report): a newer same-key value from an equal speaker is an update.
test('a user correcting their own key value emits no raise', () => {
  expect(run(DIALOGUE).raises).toEqual([])
})

// Regression: reject(@n) of a try leaves it acceptable; a later accept must initiate nothing.
test('reject closes a proposal so a later accept does nothing', () => {
  const lines = [USE, '@1 agent: try(use(server, sglang))', '@2 user: reject(@1)', '@3 user: accept(@1)']
  expect(value(lines, 'use(server, sglang)')).toBe('unknown')
})

// Regression (F3 incident): key() over every column must keep a set, not let each value erase the previous one.
test('all-column key keeps every filter_events value', () => {
  const lines = ['decl filter_events(event) key(event) "거르는 이벤트"', '@1 user: say(filter_events(app_background))', '@2 user: say(filter_events(app_foreground))', '@3 user: say(filter_events(screen_view))']
  const result = run(lines)
  for (const event of ['app_background', 'app_foreground', 'screen_view']) expect(result.facts.get('filter_events(' + event + ')')?.value).toBe('true')
  expect(result.raises).toEqual([])
})

// Regression: key() with no columns must hold one value for the whole predicate.
test('empty key() keeps one value for the predicate', () => {
  const lines = ['decl topic(subject) key() "지금 주제"', '@1 user: say(topic(auth))', '@2 user: say(topic(billing))']
  expect(value(lines, 'topic(auth)')).toBe('unknown')
  expect(value(lines, 'topic(billing)')).toBe('true')
})

const CHAIN = [USE, '@1 user: say(use(lang, python))', '@2 user: use(lang, python) -> use(framework, fastapi)']

// Regression (D2): a conclusion outlives the premise it rested on.
test('conditional chain: fastapi ends when use(lang, python) ends', () => {
  const live = run(CHAIN)
  expect(live.facts.get('use(framework, fastapi)')).toEqual({ value: 'true', support: [1, 2] })
  expect(live.proof('use(framework, fastapi)')).toEqual({ fact: 'use(framework, fastapi)', support: [1, 2], rule: 2, premises: [{ fact: 'use(lang, python)', support: [1], premises: [] }] })
  expect(value([...CHAIN, '@3 user: say(use(lang, rust))'], 'use(framework, fastapi)')).toBe('unknown')
  expect(value([...CHAIN, '@3 user: reject(@1)'], 'use(framework, fastapi)')).toBe('unknown')
})

const PLAN = [
  'decl done(task) key(task) "끝난 작업"', 'decl ready(task) key(task) "시작할 수 있는 작업"',
  '@1 user: say(done(build))', '@2 user: say(done(docs))',
  '@3 user: done(build), done(docs) -> ready(release)',
]

// Regression: "테스트도 먼저" binds only one rule, so a second rule for ready(release) skips done(test).
test('premise append binds the conclusion, including a rule added later', () => {
  expect(value(PLAN, 'ready(release)')).toBe('true')
  const appended = [...PLAN, '@4 user: done(test) -> @3']
  expect(value(appended, 'ready(release)')).toBe('unknown')
  const second = [...appended, '@5 user: done(build) -> ready(release)']
  expect(value(second, 'ready(release)')).toBe('unknown')
  const result = run([...second, '@6 user: say(done(test))'])
  expect(result.facts.get('ready(release)')?.value).toBe('true')
  expect(value([...second, '@6 user: reject(@4)'], 'ready(release)')).toBe('true')
})

// Regression (review F1): the printed-key tie-break let the predicate name decide whether a rule-older self-defeating loop is contested.
test('a rule older than the fact it negates is contested whatever the predicate is called', () => {
  for (const name of ['done', 'pass', 'zeta']) {
    const result = run(['decl ' + name + '(x) key(x) "p"', '@1 user: ' + name + '(a) -> not(' + name + '(a))', '@2 user: say(' + name + '(a))'])
    expect(result.facts.get(name + '(a)')?.value).toBe('contested')
    expect(result.raises.map(r => r.kind)).toEqual(['contested'])
  }
})

// Regression (review F2): an append to a multi-line @m bound only the first rule line's conclusion.
test('a premise append binds the conclusion of every rule line under @m', () => {
  const lines = [
    'decl done(task) key(task) "끝난 작업"', 'decl ready(task) key(task) "시작할 수 있는 작업"',
    '@1 user: done(build) -> ready(release)', '@1 user: done(build) -> ready(deploy)',
    '@2 user: say(done(build))', '@3 user: done(test) -> @1',
  ]
  expect(value(lines, 'ready(release)')).toBe('unknown')
  expect(value(lines, 'ready(deploy)')).toBe('unknown')
  expect(value([...lines, '@4 user: say(done(test))'], 'ready(deploy)')).toBe('true')
})

// Regression: the store accepts appends that point forward or stack on another append.
test('store rejects a premise append to an append or to a later utterance', () => {
  const ledger = appendAll([...PLAN, '@4 user: done(test) -> @3'])
  expect(append(ledger, '@5 user: done(docs) -> @4').ok).toBe(false)
  expect(append(ledger, '@5 user: done(docs) -> @9').ok).toBe(false)
  const rejected = appendAll(['@5 user: reject(@3)'], ledger)
  expect(append(rejected, '@6 user: done(docs) -> @3').ok).toBe(false)
})

// Regression: derived-vs-derived conflicts resolved by recency alone let a worker-backed conclusion beat a user-backed one.
test('derived conflict: the side whose weakest support ranks higher wins', () => {
  const lines = [
    'decl choice(slot, value) key(slot) "고른 값"', 'decl have(thing) key(thing) "가진 것"',
    '@1 user: say(have(a))', '@2 worker: say(have(b))',
    '@3 user: have(a) -> choice(db, postgres)', '@4 user: have(b) -> choice(db, sqlite)',
  ]
  const result = run(lines)
  expect(result.facts.get('choice(db, postgres)')?.value).toBe('true')
  expect(result.facts.get('choice(db, sqlite)')?.value).toBe('unknown')
  expect(result.raises).toEqual([{ kind: 'conflict', key: 'db', facts: ['choice(db, postgres)', 'choice(db, sqlite)'], winner: 'choice(db, postgres)', loser: 'choice(db, sqlite)', mode: 'ask_model' }])
})

// Regression: a derived conclusion that defeats its own premise oscillates or picks a side instead of being contested.
test('self-defeating loop is contested and raised', () => {
  const lines = ['decl a() key() "a"', 'decl b() key() "b"', '@1 user: say(a)', '@2 user: a -> b', '@3 user: b -> not(a)']
  const result = run(lines)
  expect(result.facts.get('a')?.value).toBe('contested')
  expect(result.facts.get('b')?.value).toBe('contested')
  expect(result.raises).toEqual([{ kind: 'contested', key: 'a', facts: ['a', 'b', 'not(a)'], mode: 'raise' }])
  expect(result.fuelExhausted).toBe(false)
})

// Regression: facts that only support each other get bootstrapped to true instead of staying unknown.
test('positive loop stays unknown', () => {
  const lines = [
    'decl done(task) key(task) "끝난 작업"', 'decl ready(task) key(task) "시작할 수 있는 작업"',
    '@1 user: done(a) -> ready(b)', '@2 user: done(b) -> ready(a)', '@3 user: ready(?g) -> done(?g)',
  ]
  const result = run(lines)
  for (const fact of ['done(a)', 'ready(b)', 'done(b)', 'ready(a)']) expect(result.facts.get(fact)?.value).toBe('unknown')
  expect(result.raises).toEqual([])
})

// Regression: a fuel cap that never stops evaluation, or stops it while still reporting unsettled conclusions as true.
test('fuel exhaustion stops and leaves unsettled facts unknown', () => {
  const result = run(CHAIN, { fuel: 1 })
  expect(result.fuelExhausted).toBe(true)
  expect(result.facts.get('use(framework, fastapi)')?.value).toBe('unknown')
  expect(run(CHAIN).fuelExhausted).toBe(false)
})

// Regression: raise_on / not(raise_on) stop routing conflicts (U2).
test('raise_on(K) raises, not(raise_on(K)) resolves, neither asks the model', () => {
  const conflict = (rule: string[]) => run([USE, ...rule, '@5 user: say(use(lang, python))', '@6 agent: say(use(lang, rust))']).raises.map(r => r.mode)
  expect(conflict(['@1 user: say(raise_on(lang))'])).toEqual(['raise'])
  expect(conflict(['@1 user: say(not(raise_on(lang)))'])).toEqual(['resolve'])
  expect(conflict([])).toEqual(['ask_model'])
  // "언어 바뀌는 건 꼭 물어봐": with raise_on(lang) even the user's own update is raised.
  expect(run([USE, '@1 user: say(raise_on(lang))', '@2 user: say(use(lang, python))', '@3 user: say(use(lang, rust))']).raises.map(r => r.mode)).toEqual(['raise'])
})

// Regression: raise rules fighting each other escalate endlessly or rank by speaker instead of recency (U2).
test('raise_on conflicts resolve by recency only and never raise', () => {
  const result = run(['@1 user: say(raise_on(lang))', '@2 agent: say(not(raise_on(lang)))'])
  expect(result.facts.get('raise_on(lang)')?.value).toBe('false')
  expect(result.facts.get('not(raise_on(lang))')?.value).toBe('true')
  expect(result.raises).toEqual([])
})

// Regression: p vs not(p) from the same speaker loses the later statement.
test('say(not(p)) terminates p', () => {
  const lines = [USE, '@1 user: say(use(server, sglang))', '@2 user: say(not(use(server, sglang)))']
  expect(value(lines, 'use(server, sglang)')).toBe('false')
  expect(value(lines, 'not(use(server, sglang))')).toBe('true')
})

// Regression: pasted material outranks a worker (L1: pasted claims are the material's, not instructions).
test('pasted-material speaker ranks below worker', () => {
  const lines = ['decl max(thing, n) key(thing) "상한"', 'paste_3 := "retry 3회"', '@1 worker: say(max(retry, 5))', '@2 paste_3: say(max(retry, 3))']
  expect(value(lines, 'max(retry, 5)')).toBe('true')
  expect(value(lines, 'max(retry, 3)')).toBe('unknown')
  expect(append(emptyLedger(), '@1 paste_9: say(max(retry, 3))').ok).toBe(false)
})

// Regression: a try that contradicts a live derived not(...) is not flagged (L5 django example).
test('a try that would conflict with a true fact is flagged', () => {
  const lines = [USE, '@1 user: say(use(lang, python))', '@2 user: use(lang, python) -> not(use(framework, django))', '@3 agent: try(use(framework, django))']
  expect(run(lines).flaggedTries).toEqual([3])
})

// Regression: every line after the first of a multi-line extraction under one @n was rejected (worker B's report).
test('several lines may share one @n; earlier ids are still rejected', () => {
  let ledger = appendAll([USE, '@4 user: say(use(lang, python))'])
  const second = append(ledger, '@5 user: use(lang, python) -> use(framework, fastapi)')
  expect(second.ok).toBe(true)
  ledger = second.ledger
  const third = append(ledger, '@5 user: use(lang, rust) -> use(framework, axum)')
  expect(third.ok).toBe(true)
  expect(append(third.ledger, '@3 user: say(use(lang, go))').ok).toBe(false)
  expect(nextId(third.ledger)).toBe(6)
  expect(ledger.utterances.length).toBe(2) // append never mutates its input
})

// Regression: the store accepts undeclared predicates or wrong arity (L2, D3).
test('store rejects undeclared predicates and arity mismatches', () => {
  const ledger = appendAll([USE])
  expect(append(ledger, '@1 user: say(uses(server, vllm))').errors).toEqual(['predicate uses is not declared'])
  expect(append(ledger, '@1 user: say(use(server))').ok).toBe(false)
})

// Regression (R18): "일단 해봐" (report) and "잘되면 바로 ㄱㄱ" (proceed) encoded the same way.
test('try(p) -> report and try(p) -> proceed give different policies', () => {
  const base = [USE, '@1 agent: try(use(server, sglang))']
  expect(run([...base, '@2 user: try(use(server, sglang)) -> report']).tryPolicy).toEqual([{ tryId: 1, fact: 'use(server, sglang)', policy: 'report' }])
  expect(run([...base, '@2 user: try(use(server, ?x)) -> proceed']).tryPolicy).toEqual([{ tryId: 1, fact: 'use(server, sglang)', policy: 'proceed' }])
  // A lower-ranked newer rule does not override the user's.
  expect(run([...base, '@2 user: try(use(server, sglang)) -> report', '@3 agent: try(use(server, sglang)) -> proceed']).tryPolicy[0]?.policy).toBe('report')
})

// Regression: an ambiguous try defaulting to proceed, or an accepted/rejected try still awaiting a decision.
test('a try with no policy rule defaults to report; accept or reject closes it', () => {
  const base = [USE, '@1 agent: try(use(server, sglang))']
  expect(run(base).tryPolicy).toEqual([{ tryId: 1, fact: 'use(server, sglang)', policy: 'report' }])
  expect(run([...base, '@2 user: accept(@1)']).tryPolicy).toEqual([])
  expect(run([...base, '@2 user: reject(@1)']).tryPolicy).toEqual([])
})

const parseError = (line: string) => { const r = parseLine(line); return r.ok ? undefined : r.error }

// Regression (L6, F5, F6): the parser admits a bare ?, retract, a nested kind or a sentence argument.
test('parser rejects bare ?, retract, nested kinds and sentence arguments', () => {
  expect(parseError('@1 user: ask(use(server, ?))')).toContain('bare ?')
  expect(parseError('@1 user: say(retract(spec))')).toContain('retract')
  expect(parseError('decl retract(x) key(x) "x"')).toContain('reserved')
  expect(parseError('@1 user: say(try(use(server, sglang)))')).toContain('inside content')
  expect(parseError('@1 user: try(a -> guess(b))')).toContain('nested')
  expect(parseError('@1 user: say(severity(rule, "대안 문장"))')).toContain('atoms')
  expect(parseError('@1 user: say(severity(rule, 대안))')).toContain('sentences')
  expect(parseError('@1 user: a(?x) -> b(f(?x))')).toContain('function symbol')
  expect(parseError('@1 user: a -> b(?y)')).toContain('?y')
  expect(parseError('@1 user: say(use(server, ?x))')).toContain('variables')
})

// Regression: say(a -> guess(b)) is rejected or kept as a say instead of hoisting to guess(a -> b).
test('say(a -> guess(b)) is normalized to guess(a -> b)', () => {
  const r = parseLine('@1 user: say(a -> guess(b))')
  if (!r.ok) throw new Error(r.error)
  const u = r.entry as Utterance
  expect(u.kind).toBe('guess')
  expect(printUtterance(u)).toBe('@1 user: guess(a -> b)')
})

// Regression: the try -> report/proceed forms and atom forms (uppercase, numerals) stop round-tripping.
test('parses and prints the remaining line forms', () => {
  for (const line of [
    '@1 user: try(use(server, sglang)) -> report',
    '@2 user: try(use(server, sglang)) -> proceed',
    '@3 user: done(build), not(done(docs)) -> ready(release)',
    '@4 user: done(test) -> @3',
    '@5 agent: ask(use(lang, Python))',
    '@6 paste_3: say(max(retry, 3))',
    '@7 user: accept(@2)',
  ]) {
    const r = parseLine(line)
    if (!r.ok) throw new Error(line + ': ' + r.error)
    expect(printUtterance(r.entry as Utterance)).toBe(line)
  }
  const cond = parseLine('@3 user: done(build) -> ready(release)')
  expect(cond.ok && (cond.entry as Utterance).kind).toBe('cond')
  expect(parseLine('sglang := "빠른 서버 프레임워크"')).toEqual({ ok: true, entry: { kind: 'gloss', atom: 'sglang', gloss: '빠른 서버 프레임워크' } })
})
