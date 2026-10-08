import type { EngineInterface, Register } from 'claude-code'

// stay_awake: the user's ask, "덮개 닫아도 절전 안 빠지는 걸 클로드가 툴로 연장할 수
// 있어야 함". The tool only writes an epoch-seconds deadline; the root launchd
// daemon `org.ranolp.claude-awake` (nix/darwin/default.nix) reads it every
// minute and flips `pmset disablesleep`, so no sudo ever runs from here.

export const AWAKE_TOOL = 'mcp__time-budget__stay_awake'
export const MAX_AWAKE_MIN = 240

/** Registered by register.ts's session.start alongside estimate/report/grant: one handler per event per module. */
export const AWAKE_DEF = {
  name: 'stay_awake',
  description: `Keep the Mac awake with the lid closed for the next N minutes (max ${MAX_AWAKE_MIN} per call; 0 lets it sleep again). Call it again before the deadline to extend. A root daemon applies it within a minute, and only while the battery is at 20% or more or on AC power.`,
  inputSchema: {
    type: 'object',
    properties: { minutes: { type: 'number', minimum: 0, description: `Minutes from now to stay awake, 0 to ${MAX_AWAKE_MIN}; 0 clears it` } },
    required: ['minutes'],
  },
}

/** The deadline, in epoch seconds, that `minutes` from `nowMs` writes; undefined clears it. */
export function awakeUntil(nowMs: number, minutes: number): number | undefined {
  const m = Math.min(Math.max(0, minutes), MAX_AWAKE_MIN)
  if (m === 0) return undefined
  return Math.floor(nowMs / 1000 + m * 60)
}

async function untilFile($: EngineInterface) {
  const dir = `${(await $.env.get('HOME')) ?? '.'}/.local/state/claude-awake`
  return { dir, path: `${dir}/until` }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const register: Register = (on) => {
  on('tool.call', { tool: AWAKE_TOOL }, async ($, e) => {
    const m = (e as unknown as Record<string, unknown>).minutes
    if (typeof m !== 'number' || !Number.isFinite(m) || m < 0) return { deny: `Call ${AWAKE_TOOL} with minutes as a number from 0 to ${MAX_AWAKE_MIN}.` }
    const until = awakeUntil(await $.clock.now(), m)
    const { dir, path } = await untilFile($)
    try {
      if (until === undefined) {
        const rm = await $.process.run(['rm', '-f', path], { timeoutMs: 5_000 })
        if (rm.exitCode !== 0) throw new Error(`rm -f ${path} failed (${rm.exitCode}): ${rm.stderr}`)
        return { result: 'Stay-awake cleared; the Mac may sleep with the lid closed again within a minute.' }
      }
      const mk = await $.process.run(['mkdir', '-p', dir], { timeoutMs: 5_000 })
      if (mk.exitCode !== 0) throw new Error(`mkdir -p ${dir} failed (${mk.exitCode}): ${mk.stderr}`)
      await $.fs.write(path, `${until}\n`)
    } catch (err) {
      return { isError: true, text: `stay_awake could not update ${path}: ${errText(err)}` }
    }
    const clamped = m > MAX_AWAKE_MIN ? ` (clamped from ${m} to ${MAX_AWAKE_MIN} min)` : ''
    return { result: `Staying awake until ${new Date(until * 1000).toISOString()} (epoch ${until})${clamped}; call again before then to extend.` }
  })
}
