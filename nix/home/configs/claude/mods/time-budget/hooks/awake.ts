// stay_awake: the user's ask, "덮개 닫아도 절전 안 빠지는 걸 클로드가 툴로 연장할 수
// 있어야 함". The tool only writes an epoch-seconds deadline; the root launchd
// daemon `org.ranolp.claude-awake` (nix/darwin/default.nix) reads it every
// minute and flips `pmset disablesleep`, so no sudo ever runs from here.

export const AWAKE_TOOL = 'mcp__time-budget__stay_awake'
export const MAX_AWAKE_MIN = 240

/** Registered by register.ts's session.start alongside estimate/report/grant, which also serves its calls. */
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

/** The deadline file the daemon reads, under `home`. */
export function awakeFile(home: string) {
  const dir = `${home}/.local/state/claude-awake`
  return { dir, path: `${dir}/until` }
}
