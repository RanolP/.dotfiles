import { test, expect, mock, type Engine } from 'claude-code/testing'
import { AWAKE_TOOL, MAX_AWAKE_MIN } from './awake'

const T0 = 1_000_000_000_000
const FILE = '/home/t/.local/state/claude-awake/until'

function world(on: any) {
  const files: Record<string, string> = {}
  const ran: string[][] = []
  mock.clock(on, { now: T0 })
  mock.env(on, { HOME: '/home/t' })
  on('fs.exists', (_$: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path] }))
  on('fs.write', (_$: any, e: any) => { files[e.path] = e.text; return { value: undefined } })
  on('process.run', (_$: any, e: any) => {
    ran.push(e.argv)
    if (e.argv[0] === 'rm') delete files[e.argv[2]]
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_$: any, e: any) => ({ value: { tool: `mcp__time-budget__${e.name}` } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('tool.call', () => ({ result: 'ran' }))
  return { files, ran }
}

const start = ($: Engine) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
const awake = ($: Engine, minutes: unknown) => $.tool.call({ tool: AWAKE_TOOL, minutes } as any)

// Regression: an oversized request would keep the Mac awake for hours past what one call may grant.
test('stay_awake clamps a request above the per-call max to 240 minutes', async ($, on) => {
  const { files, ran } = world(on)
  await start($)
  const r = await awake($, 10_000)
  expect(files[FILE]).toBe(`${T0 / 1000 + MAX_AWAKE_MIN * 60}\n`)
  expect(r.result).toContain('clamped')
  expect(ran).toContainEqual(['mkdir', '-p', '/home/t/.local/state/claude-awake'])
})

// Regression: the daemon reads epoch seconds, so writing milliseconds or minutes would pin the Mac awake for good or never.
test('stay_awake writes now plus minutes as epoch seconds', async ($, on) => {
  const { files } = world(on)
  await start($)
  await awake($, 30)
  expect(files[FILE]).toBe(`${T0 / 1000 + 30 * 60}\n`)
})

// Regression: minutes 0 must let the Mac sleep again instead of leaving the old deadline in place.
test('stay_awake with 0 minutes removes the until file', async ($, on) => {
  const { files } = world(on)
  await start($)
  await awake($, 30)
  await awake($, 0)
  expect(FILE in files).toBe(false)
})

// Regression: a negative or non-numeric minutes would write a garbage deadline.
test('stay_awake denies minutes that are not a non-negative number', async ($, on) => {
  const { files } = world(on)
  await start($)
  expect((await awake($, -5)).deny).toContain('minutes')
  expect((await awake($, 'lots')).deny).toContain('minutes')
  expect(FILE in files).toBe(false)
})
