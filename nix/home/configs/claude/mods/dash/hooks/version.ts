import type { Behind } from '../types'

export function behindFromCount(stdout: string): Behind {
  const text = stdout.trim()
  const count = Number(text)
  return text !== '' && Number.isInteger(count) && count >= 0 ? count : 'unknown'
}

export function versionLabel(baseline: string | undefined, behind: Behind | undefined): string {
  if (baseline === undefined) return ''
  const drift = behind === undefined ? '' : ` · behind ${behind === 'unknown' ? '?' : behind}`
  return ` · @${baseline.slice(0, 7)}${drift}`
}
