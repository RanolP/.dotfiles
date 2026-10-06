import { test, expect } from 'claude-code/testing'

const M = (role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) =>
  ({ role, text, toolUses: [], ...extra }) as any
const use = (id: string, tool: string) => M('assistant', '', { toolUses: [{ tool_use_id: id, tool, input: { id }, text: 'ok' }] })
const res = (id: string, text: string) => M('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] })
const BIG = 'x'.repeat(4000) // ~1000 tokens
const MID = 'y'.repeat(800) // ~200 tokens

// ~2250 estimated tokens over four turns. With a 1200-token tail target the
// newest two turns fit and the first request's tool work plus "now fix it" fold.
const ROWS = [
  M('user', 'please investigate the build'), use('tu_a', 'Bash'), res('tu_a', 'log ' + BIG), M('assistant', 'make fails at a.ts:12'),
  M('user', 'now fix it'), use('tu_b', 'Edit'), res('tu_b', 'edited ' + MID), M('assistant', 'fixed a.ts:12'),
  M('user', 'run tests'), use('tu_c', 'Bash'), res('tu_c', 'pass ' + BIG), M('assistant', 'tests pass'),
  M('user', 'commit it'), M('assistant', 'done'),
]
// The merge model writes the three note sections, optional changes, and an <ops> array; the
// tracker renders the other three.
const NOTES = ['목표', '사용자 지시', '핵심 사실·경로']
const ledger = (fact: string, ops = '[]', changes = '') => `${NOTES.map(s => `## ${s}\n- ${s === '핵심 사실·경로' ? fact : '-'}`).join('\n\n')}${changes ? `\n\n<changes>${changes}</changes>` : ''}\n\n<ops>${ops}</ops>`
const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as any
const OPTS = { options: { budget: 2000, tailTarget: 1200, reserve: 100 } }
const LEDGER_FILE = '/home/t/.claude-work/plans/clm-s1.md'
const LOG_FILE = '/home/t/.claude-work/plans/clm-s1.log.jsonl'
const ids = (m: any) => [...m.toolUses.map((u: any) => u.tool_use_id), ...(m.toolResults ?? []).map((r: any) => r.tool_use_id)]
const est = (m: any) => Math.ceil((m.text.length + m.toolUses.reduce((k: number, u: any) => k + JSON.stringify(u.input).length + u.tool.length, 0) + (m.toolResults ?? []).reduce((k: number, x: any) => k + x.text.length, 0)) / 4)
const shape = (out: any[]) => out.map((m: any) => m.text || ids(m).join())
const handled = (rows: any[]) => rows.map((m, i) => ({ ...m, handle: `h${i}` }))

type State = { rows: any[]; replies: (string | null)[]; usage?: any }
function bottoms(on: any, s: State) {
  const seen = { store: {} as Record<string, unknown>, files: {} as Record<string, string>, prompts: [] as string[], logs: [] as string[], results: [] as any[], taskCalls: [] as any[], engineCompactions: 0 }
  on('store.get', (_$: any, e: any) => ({ value: seen.store[e.key] }))
  on('store.set', (_$: any, e: any) => { seen.store[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete seen.store[e.key]; return { value: undefined } })
  on('session.id', () => ({ value: 's1' }))
  on('session.messages', () => ({ value: s.rows }))
  on('session.usage', () => ({ value: s.usage ?? { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('env.get', () => ({ value: '/home/t' }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in seen.files || Object.keys(seen.files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$: any, e: any) => ({
    value: Object.keys(seen.files).filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/'))
      .map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: seen.files[f]!.length, mtimeMs: 0, isLink: false })),
  }))
  on('session.cwd', () => ({ value: '/work/repo' }))
  on('process.run', (_$: any, e: any) => ({ value: { exitCode: 0, stdout: e.argv.includes('get-url') ? 'git@github.com:o/repo.git\n' : 'main\n', stderr: '' } }))
  on('ui.panes', () => ({ value: [] }))
  on('fs.read', (_$: any, e: any) => ({ value: seen.files[e.path] }))
  on('fs.write', (_$: any, e: any) => { seen.files[e.path] = e.text; return { value: undefined } })
  on('model.complete', (_$: any, e: any) => {
    seen.prompts.push(e.prompt)
    const text = s.replies.shift()
    return { value: text === null ? { isAnswered: false, reason: 'aborted' } : { isAnswered: true, text: text ?? '', usage: {} } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', (_$: any, e: any) => { seen.logs.push(e.text); return { value: undefined } })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('turn.complete', () => ({ text: '' }))
  // Stands for the engine summarizer: any call reaching it is a compaction clm failed to replace.
  on('session.compact', () => { seen.engineCompactions++; return { messages: [M('user', 'ENGINE SUMMARY')] } })
  return seen
}
// The plugin raises its compaction from turn.complete; the engine answers by
// running the chain again with the live transcript, which a test raises itself.
async function turnEnds($: any, s: State, seen: { results: any[] }) {
  await $.turn.complete(TURN)
  seen.results.push(await $.session.compact({ trigger: 'plugin', messages: handled(s.rows) }))
}
const logEvents = (seen: { files: Record<string, string> }) => (seen.files[LOG_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))

// Regression caught: a fold-created issue reaches the built-in panel and a later completion updates its projected task.
test('fold issues project to the task panel', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"clm 조사하기","status":"todo","note":"조사 메모"}]'), ledger('fact 2', '[{"op":"status","issue":"s1-1","status":"done"}]')] }
  const seen = bottoms(on, s)
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    return { result: { task: { id: 'panel-1', subject: e.subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    return { result: { success: true, taskId: e.taskId, updatedFields: [] } }
  })
  await turnEnds($, s, seen)
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'complete the investigation'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'completed'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)
  const create = seen.taskCalls.find(c => c.tool === 'TaskCreate')
  const updates = seen.taskCalls.filter(c => c.tool === 'TaskUpdate')
  expect(create.subject).toBe('clm 조사하기')
  expect(create.description).toBe('조사 메모')
  expect(updates.some(u => u.taskId === 'panel-1' && u.status === 'completed')).toBe(true)
})

// Regression caught: the model cannot write the panel directly, while clm's own projection call is allowed through.
test('model task calls are denied outside clm projection', OPTS, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    return { result: { task: { id: 'panel-1', subject: e.subject } } }
  })
  const r = await $.tool.call({ tool: 'TaskCreate', subject: 'model task', description: 'should be denied' })
  expect('deny' in r).toBe(true)
  expect(seen.taskCalls).toEqual([])
})

// Regression caught: a fold creating several issues re-entered the projection and created duplicate panel tasks.
test('several fold issues create one panel task each', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"A","status":"todo"},{"op":"create","title":"B","status":"done"},{"op":"create","title":"C","status":"todo"}]')] }
  const seen = bottoms(on, s)
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    return { result: { task: { id: `panel-${++n}`, subject: e.subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, (_$: any, e: any) => {
    seen.taskCalls.push(e)
    return { result: { success: true, taskId: e.taskId, updatedFields: [] } }
  })
  await turnEnds($, s, seen)
  expect(seen.taskCalls.filter(c => c.tool === 'TaskCreate').map(c => c.subject)).toEqual(['A', 'B', 'C'])
  expect(seen.taskCalls.filter(c => c.tool === 'TaskUpdate').map(c => [c.taskId, c.status])).toEqual([['panel-2', 'completed']])
})

// Regression caught: a refused panel write blocked the fold or the tracker append.
test('a refused TaskCreate still lets the fold complete', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[{"op":"create","title":"clm 조사하기","status":"todo"}]')] }
  const seen = bottoms(on, s)
  on('tool.call', { tool: 'TaskCreate' }, () => ({ deny: 'refused in test' }))
  await turnEnds($, s, seen)
  expect(seen.results[0].messages[1].text).toContain('clm 조사하기')
  expect(seen.logs).toContain("작업 'clm 조사하기' 추가")
})

// Regression caught: a changes block written before the notes emptied them and dropped the fold.
test('a changes block before the notes still applies the fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [`<changes>핵심 사실: 순서가 바뀐 응답</changes>\n\n${ledger('fact')}`] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(seen.results[0].messages[1].text).toContain('fact')
  expect(seen.logs).toContain('맥락 갱신: 핵심 사실: 순서가 바뀐 응답')
})

// Regression caught: non-task ledger changes were lost from the fold or leaked into the session transcript.
test('non-task merge changes show display-only notices', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact', '[]', '핵심 사실: 브리지 재시작 시 키 유실 확인\n미결 질문 추가: ui.log가 --resume 후 남는지')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(seen.logs).toContain('맥락 갱신: 핵심 사실: 브리지 재시작 시 키 유실 확인')
  expect(seen.logs).toContain('맥락 갱신: 미결 질문 추가: ui.log가 --resume 후 남는지')
  expect(seen.results[0].messages.some(m => m.text?.includes('맥락 갱신:'))).toBe(false)
})

// Regression caught: a merge reply without the optional changes block must still apply its ledger fold.
test('a merge without non-task changes still applies the fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fact')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(seen.results[0].messages[1].text).toContain('fact')
  expect(seen.logs.some(l => l.startsWith('맥락 갱신: '))).toBe(false)
})

// Regression caught: the automatic fold keeps the wrong rows (drops the request, keeps folded turns, or cuts between a tool_use and its tool_result).
test('over budget, a fold keeps [first request, ledger, newest turns] with tool pairs intact', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('a.ts:12 is the bad import')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out[0].text).toBe('please investigate the build')
  expect(out[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(out[1].text).toContain('a.ts:12 is the bad import')
  expect(shape(out.slice(2))).toEqual(['run tests', 'tu_c', 'tu_c', 'tests pass', 'commit it', 'done'])
  expect(out.some((m: any) => m.handle !== undefined)).toBe(false)
  expect(seen.prompts[0]).toContain('fixed a.ts:12')
  expect(seen.prompts[0]).not.toContain('tests pass')
  expect(seen.files[LEDGER_FILE]).toContain('## 핵심 사실·경로')
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: a second fold loses the first ledger (not fed back from the file) or stacks a second ledger row beside the first.
test('the ledger round-trips through its file and survives a second fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('FIRST-FACT'), ledger('FIRST-FACT; SECOND-FACT')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const after1 = seen.results[0].messages
  // The stored transcript keeps the pre-fold chain in front of the live one.
  s.rows = [...ROWS, ...after1, M('user', 'add docs'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'docs added'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)
  expect(seen.prompts[1]).toContain('FIRST-FACT')
  const out = seen.results[1].messages
  expect(out.filter((m: any) => m.text.startsWith('[clm ledger')).length).toBe(1)
  expect(out[1].text).toMatch(/^\[clm ledger #2 · /)
  expect(out[1].text).toContain('SECOND-FACT')
  expect(out.map((m: any) => m.text).filter(Boolean)).toEqual(['please investigate the build', out[1].text, 'commit it', 'done', 'add docs', 'docs added', 'push', 'pushed'])
})

// Regression caught: a merged ledger missing a section replaces the memory anyway and silently drops that section.
test('a merged ledger without all three note headers skips the fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['## 목표\n- only one section\n\n<ops>[]</ops>'] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(seen.files[LEDGER_FILE]).toBeUndefined()
  expect((seen.store['ledger:s1'] as any).lastSkip).toContain('expected the 3 note sections')
  expect(logEvents(seen).map(e => e.event)).toEqual(['merge-invalid'])
})

// Regression caught: after a fold, reads include the pre-boundary transcript so totals double-count rows the model no longer sees; and /clm output lands in the model's transcript.
test('/clm prints the ledger, a budget line counting only post-boundary rows, and the last decisions', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('LEDGER-ONLY-FACT')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const after = seen.results[0].messages
  s.rows = [...ROWS, ...after]
  const r: any = await $.command.run({ command: 'clm' } as any)
  expect(r.text).toBeUndefined()
  const text = seen.logs.at(-1)!
  const expected = after.reduce((n: number, m: any) => n + est(m), 0)
  expect(text.split('\n')[0]).toBe(`clm budget: ${expected}/2000 tokens (${Math.round(expected / 20)}%); folds above 1900, tail target 1200, ratio 1`)
  expect(text).toContain('LEDGER-ONLY-FACT')
  expect(text).toContain('"event":"clear"')
})

// Regression caught (guard 1): when the newest turn alone exceeds the tail target, the fold drops it too and the model loses the turn it is working on.
test('the tail keeps the newest turn even when that turn alone exceeds the tail target', OPTS, async ($, on) => {
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', 'HEAD' + 'z'.repeat(8000) + 'TAIL'), M('assistant', 'dumped')]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(shape(out.slice(2))).toEqual(['dump logs', 'tu_e', 'tu_e', 'dumped'])
})

// Regression caught (guards 2 and 6): one huge tool result in the kept tail keeps the context over budget after every fold, and the model forgets which command flooded it.
test('an oversized tool result in the kept tail is cut to head and tail and its command is remembered', OPTS, async ($, on) => {
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', 'HEAD' + 'z'.repeat(8000) + 'TAIL'), M('assistant', 'dumped')]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  const cut = out.find((m: any) => m.toolResults?.[0]?.tool_use_id === 'tu_e').toolResults[0].text
  expect(cut.startsWith('HEAD')).toBe(true)
  expect(cut.endsWith('TAIL')).toBe(true)
  expect(cut).toMatch(/…\[clm: \d+ of 8008 chars cut at fold time\]…/)
  // Cut to its share of the 1200-token tail target, not to a fixed size.
  expect(cut.length).toBeLessThan(4 * 1200)
  expect(out[1].text).toContain('- 출력 과다: Bash {"id":"tu_e"}')
  expect(seen.files[LEDGER_FILE]).toContain('출력 과다:')
  expect(logEvents(seen).map(e => e.event)).toContain('truncation')
})

// Regression caught (guard 6): oversize notes pile up in the ledger without bound across folds.
test('only the last five oversize notes stay in the ledger', OPTS, async ($, on) => {
  const old = ['a', 'b', 'c', 'd', 'e'].map(c => `- 출력 과다: Bash old-${c}`).join('\n')
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', 'z'.repeat(8000)), M('assistant', 'dumped')]
  const s: State = { rows, replies: [ledger(`kept fact\n${old}`)] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const notes = seen.results[0].messages[1].text.split('\n').filter((l: string) => l.includes('출력 과다:'))
  expect(notes.length).toBe(5)
  expect(notes[0]).toContain('old-b')
  expect(notes[4]).toContain('tu_e')
  expect(seen.results[0].messages[1].text).toContain('kept fact')
})

// Regression caught (guard 3): a fold whose ledger outweighs the turns it drops makes the context bigger, and the next turn folds again.
test('a fold that would not shrink the context is skipped with both sizes logged', { options: { budget: 2000, tailTarget: 1990, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'start'), M('user', 'a'), M('assistant', 'A'), M('user', 'b'), M('assistant', 'B'), M('user', 'go'), M('assistant', 'w'.repeat(7600))]
  const s: State = { rows, replies: [ledger('p'.repeat(1700))] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect(seen.store['pending:s1']).toBeUndefined()
  const line = seen.logs.find(l => l.includes('would not shrink'))!
  expect(line).toMatch(/\(\d+ -> \d+ est\. tokens\)/)
  const ev = logEvents(seen).find(e => e.event === 'skip-not-shrinking')
  expect(ev.tokensAfter).toBeGreaterThanOrEqual(ev.tokensBefore)
})

// Regression caught (guard 4): a merge model that keeps answering badly blocks every fold, and the context grows without bound.
test('after three failed merges in a row the fold uses a mechanical ledger', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['bad', null, 'bad'] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await $.turn.complete(TURN)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect((seen.store['ledger:s1'] as any).fails).toBe(2)
  await turnEnds($, s, seen)
  const row = seen.results[0].messages[1].text
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(row).toContain('- "now fix it"')
  expect(row).toContain('- turn (first request, continued): tools Bash')
  expect(row).toContain('- turn "now fix it": tools Edit')
  expect((seen.store['ledger:s1'] as any).fails).toBe(0)
  expect(logEvents(seen).map(e => e.event)).toEqual(['merge-invalid', 'merge-timeout', 'merge-invalid', 'fallback', 'clear'])
})

// Regression caught (guard 5): chars/4 undercounts Korean and code, so the real context overflows while the estimate still reads under budget; and a plain real/estimate quotient counts the system prompt and tools as conversation.
test('a token ratio measured on growth between turns scales the estimate so the fold fires on real size', OPTS, async ($, on) => {
  const rows = ROWS.slice(4) // ~1250 estimated tokens: under the 1900 trigger on chars/4 alone
  const msgs = rows.reduce((n: number, m: any) => n + est(m), 0)
  const usage = (tokens: number) => ({ startedAt: 0, rateLimits: [], context: { window: 200000, tokens } })
  const s: State = { rows, replies: [ledger('x')], usage: usage(15000 + msgs) }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect((seen.store['ledger:s1'] as any).ratio).toBeUndefined() // one reading is only a baseline
  expect(seen.store['pending:s1']).toBeUndefined()
  const more = [M('user', 'and the docs'), use('tu_g', 'Read'), res('tu_g', MID), M('assistant', 'read')]
  const grew = more.reduce((n: number, m: any) => n + est(m), 0)
  s.rows = [...rows, ...more] // ~1470 estimated: still under 1900 at ratio 1
  s.usage = usage(15000 + msgs + 2 * grew)
  await $.turn.complete(TURN)
  expect((seen.store['ledger:s1'] as any).ratio).toBe(2)
  expect(seen.store['pending:s1']).toBeDefined()
  expect(logEvents(seen).map(e => e.event)).toContain('calibration')
})

// Regression caught (guard 7): empty and "(no content)" rows carried into the rewritten transcript waste context and can be refused by the API.
test('empty and "(no content)" rows are dropped from the fold result', OPTS, async ($, on) => {
  const rows = [...ROWS.slice(0, 12), M('assistant', '(no content)'), M('assistant', ''), ...ROWS.slice(12)]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out.some((m: any) => m.text === '(no content)' || (m.text === '' && ids(m).length === 0))).toBe(false)
})

// Regression caught (guard 8): a fold or skip leaves nothing to diagnose it from after the fact.
test('every fold writes a JSONL decision line with sizes, kept turns and ratio', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const clear = logEvents(seen).find(e => e.event === 'clear')
  expect(Object.keys(clear).sort()).toEqual(['event', 'keptTurns', 'ratio', 'reason', 'tokensAfter', 'tokensBefore', 'ts'])
  expect(clear.keptTurns).toBe(2)
  expect(clear.tokensAfter).toBeLessThan(clear.tokensBefore)
})

// Regression caught (guard 9): a budget under 2000 or a reserve over the budget is silently replaced and the user never learns the setting was ignored.
test('a bad option is logged with the value actually used', { options: { budget: 100, tailTarget: 50000, reserve: 9999 } }, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  await ($ as any).session.start({ source: 'startup' })
  expect(seen.logs).toContain('clm: option budget=100 must be an integer of at least 2000; using 2000')
  expect(seen.logs).toContain('clm: option tailTarget=50000 must be a positive integer under the budget (2000); using 1000')
  expect(seen.logs).toContain('clm: option reserve=9999 must be a positive integer under the budget (2000); using 500')
})

// Regression caught: with no plan pending, the engine's threshold or a /compact runs its own summarizer and replaces the ledger with an engine summary.
test('auto compaction with no pending plan produces an engine summary instead of a clm ledger', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('INLINE-FACT'), 'not a ledger'] }
  const seen = bottoms(on, s)
  const auto: any = await $.session.compact({ trigger: 'auto', messages: handled(ROWS) } as any)
  expect(auto.messages[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(auto.messages[1].text).toContain('INLINE-FACT')
  // A failed merge still folds, mechanically, rather than handing over to the engine.
  const manual: any = await $.session.compact({ trigger: 'manual', messages: handled([...ROWS, ...auto.messages, M('user', 'more'), use('tu_f', 'Bash'), res('tu_f', BIG), M('assistant', 'ok')]) } as any)
  expect(manual.messages[1].text).toMatch(/^\[clm ledger #2 · /)
  expect(manual.messages.some((m: any) => m.text === 'ENGINE SUMMARY')).toBe(false)
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: the engine spends a summarizer call ahead of time and can install that summary at the next compaction.
test('precompute runs the engine summarizer ahead of time', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [] }
  const seen = bottoms(on, s)
  const r: any = await $.session.compact({ trigger: 'precompute', messages: handled(ROWS) } as any)
  expect(r.skip).toBe('clm replaces compaction')
  expect(seen.engineCompactions).toBe(0)
  expect(seen.prompts.length).toBe(0)
  // A subagent's own transcript is still the engine's to compact.
  await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: handled(ROWS) } as any)
  expect(seen.engineCompactions).toBe(1)
})
