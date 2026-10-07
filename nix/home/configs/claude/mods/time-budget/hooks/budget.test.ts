import { test, expect } from 'claude-code/testing'
import { budgetFor, budgetLine, calibrationFactor, CHECKPOINTS, crossed, dueAt, extensionFrom, FLOOR_MIN, gate, parsePairs, projectedMin, TOOL } from './budget'

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

test('an extension must be the whole prompt', () => {
  expect(extensionFrom('+2m')).toBe(2)
  expect(extensionFrom(' +2 minutes ')).toBe(2)
  expect(extensionFrom('add +2 margin')).toBeUndefined()
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

test('a codex prompt counts as budgeted only with "Budget: <N> min" as its first line', () => {
  expect(budgetLine('Budget: 20 min\nDo the thing')).toBe(20)
  expect(budgetLine('Do the thing\nBudget: 20 min')).toBeUndefined()
  expect(budgetLine('Budget: 0 min\nx')).toBeUndefined()
})

test('before the estimate only estimate, ToolSearch and SubagentHandback pass', () => {
  const u = { kind: 'main' as const, start: 0, fired: 0 }
  expect(gate(u, TOOL.estimate, 0)).toBeUndefined()
  expect(gate(u, 'ToolSearch', 0)).toBeUndefined()
  expect(gate(u, 'SubagentHandback', 0)).toBeUndefined()
  expect(gate(u, 'Read', 0)?.deny).toContain(TOOL.estimate)
  expect(gate(u, TOOL.report, 0)?.deny).toContain(TOOL.estimate)
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
