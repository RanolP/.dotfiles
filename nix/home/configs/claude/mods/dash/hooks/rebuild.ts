import type { Behind, SystemGeneration } from '../types'

export function cleanRevision(revision: string | undefined): string | undefined {
  return revision?.replace(/-dirty$/, '') || undefined
}

export function revisionOf(versionJson: string): string | undefined {
  const parsed: unknown = JSON.parse(versionJson)
  const revision = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).configurationRevision : undefined
  return typeof revision === 'string' ? revision : undefined
}

// A changed store path with zero commits between the revisions means the revisions do not describe the change, so the count is unknown rather than zero.
export function behindFromCount(stdout: string): Behind {
  const count = Number(stdout.trim())
  return Number.isInteger(count) && count > 0 ? count : 'unknown'
}

export function behindLabel(behind: Behind | undefined): string {
  if (behind === undefined) return ''
  return ` · behind ${behind === 'unknown' ? '?' : behind}`
}

export function revisionRange(baseline: SystemGeneration, latest: SystemGeneration): string | undefined {
  const from = cleanRevision(baseline.revision)
  const to = cleanRevision(latest.revision)
  return from && to ? `${from}..${to}` : undefined
}
