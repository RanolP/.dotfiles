import { test, expect } from 'claude-code/testing'
import { budgetFor, budgetLine, calibrationFactor, CHECKPOINTS, crossed, dueAt, extensionSummary, FLOOR_MIN, parseExtensions, parsePairs, projectedMin } from './budget'

test('history that ran 3x over scales the next budget 3x, clamped to [0.25, 10]', () => {
  expect(calibrationFactor([])).toBe(1)
  expect(budgetFor(5, 1)).toBe(FLOOR_MIN)
  const hist = [...Array(9).fill({ estimate_min: 10, actual_min: 30 }), { estimate_min: 10, actual_min: 5 }]
  expect(calibrationFactor(hist)).toBe(3)
  expect(calibrationFactor(Array(9).fill({ estimate_min: 1, actual_min: 99 }))).toBe(10)
  expect(calibrationFactor(Array(9).fill({ estimate_min: 10, actual_min: 2 }))).toBe(0.25)
})

test('history that finished at one fifth of the estimate scales below one', () => {
  expect(calibrationFactor(Array(5).fill({ estimate_min: 10, actual_min: 2 }))).toBe(0.25)
})

test('python-written calibration.jsonl lines load and give the python factor', () => {
  // json.dumps' own spacing, a null agent_type and a torn last line, as the python hook left the file.
  const line = (est: number, act: number) => `{"kind": "main", "agent_type": null, "estimate_min": ${est}, "budget_min": ${Math.max(15, est)}, "actual_min": ${act}, "at": 1791276436}`
  const text = [...Array(9).fill(line(10, 30)), line(10, 5), '{"kind": "sub", "estimate_'].join('\n')
  const pairs = parsePairs(text)
  expect(pairs.length).toBe(10)
  expect(calibrationFactor(pairs)).toBe(3)
})

test('checkpoint labels stay exactly 1/3,1/2,2/3,5/6,6/6 and a jump past two counts both', () => {
  expect(CHECKPOINTS.map(c => c.label)).toEqual(['1/3', '1/2', '2/3', '5/6', '6/6'])
  expect(crossed(9 * 60_000, 30)).toBe(0)
  expect(crossed(10 * 60_000, 30)).toBe(1)
  expect(crossed(21 * 60_000, 30)).toBe(3)
  expect(crossed(30 * 60_000, 30)).toBe(5)
})

test('2 done / 4 open at 50% elapsed projects an overrun', () => {
  const p = projectedMin(15 * 60_000, { done: [{ item: 'a', check: 'x' }, { item: 'b', check: 'x' }], open: [1, 2, 3, 4].map(i => ({ item: `o${i}`, next: 'n' })) })
  expect(p).toBe(45)
  expect(p > 30).toBe(true)
})

test('a report with zero done items still projects instead of dividing by zero', () => {
  const p = projectedMin(6 * 60_000, { done: [], open: [{ item: 'o', next: 'n' }] })
  expect(p).toBe(12)
})

test('a spawned unit reads an optional "Budget: <N> min" from its first line', () => {
  expect(budgetLine('Budget: 20 min\nDo the thing')).toBe(20)
  expect(budgetLine('Do the thing\nBudget: 20 min')).toBeUndefined()
  expect(budgetLine('Budget: 0 min\nx')).toBeUndefined()
})

test('old calibration lines and extension history keep their compatible fields', () => {
  const old = parsePairs('{"kind":"main","agent_type":null,"estimate_min":20,"budget_min":20,"actual_min":12,"at":10}')
  const extended = parsePairs('{"kind":"sub","agent_type":"worker","estimate_min":10,"budget_min":25,"actual_min":20,"at":11,"extended_min":15,"extensions":2}')
  expect(old[0]).toMatchObject({ estimate_min: 20, actual_min: 12 })
  expect(old[0]?.extended_min).toBeUndefined()
  expect(extended[0]).toMatchObject({ extended_min: 15, extensions: 2 })
  expect(parseExtensions('{"at":12,"kind":"main","agent_type":null,"task":"task-1","scope":"fix","estimate_min":20,"budget_before":20,"budget_after":30,"minutes":10,"elapsed_min":5,"reason":"scope grew","source":"extend"}'))
    .toHaveLength(1)
})

test('estimate feedback summarizes extension share, median minutes, and three recent reasons', () => {
  const pairs = [{ extended_min: 10 }, { extended_min: 0 }, { extended_min: 20 }]
  const extensions = [
    { minutes: 10, reason: 'scope grew', source: 'extend' as const },
    { minutes: 20, reason: 'verification took longer', source: 'grant' as const },
    { minutes: 30, reason: 'not completed yet', source: 'report' as const },
  ]
  const summary = extensionSummary(pairs, extensions)
  expect(summary).toContain('2/3 recent units needed extra time')
  expect(summary).toContain('median +15 min per extension')
  expect(summary).toContain('scope grew')
  expect(summary).toContain('not completed yet')
})

// Regression: a 20 min budget put 5/6 at 999999.99… ms, so the timer fired with nothing crossed and spun at delay 0.
test('every checkpoint of a 20 min budget is crossed exactly at its whole-ms due time', () => {
  for (let i = 0; i < CHECKPOINTS.length; i++) {
    const due = dueAt(i, 20)
    expect(Number.isInteger(due)).toBe(true)
    expect(crossed(due, 20)).toBe(i + 1)
    expect(crossed(due - 1, 20)).toBe(i)
  }
})
