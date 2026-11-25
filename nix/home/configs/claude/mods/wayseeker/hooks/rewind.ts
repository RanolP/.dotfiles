import { isRecord } from './text'

/** One user prompt as wayseeker last saw it: its text's fingerprint, and the turn address wayseeker gave it when it extracted it. */
export type PromptRow = { fp: string; address?: string }

/** Session state key of the observed prompt list for one transcript. */
export const promptsKey = (key: string) => `prompts:${key}`

const fnv1a = (text: string) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return (hash >>> 0).toString(16).padStart(8, '0')
}
export const promptFingerprint = (text: string) => `${text.length}:${fnv1a(text)}`

export const readPromptRows = (value: unknown): PromptRow[] => Array.isArray(value)
  ? value.filter((row): row is PromptRow => isRecord(row) && typeof row.fp === 'string' && (row.address === undefined || typeof row.address === 'string'))
  : []

/**
 * Lines the stored prompt list up with the prompts the transcript holds now, before the submitted
 * prompt's own row lands. A rewind truncates the transcript, so the current prompts are a proper
 * prefix of the stored ones and every stored prompt past that prefix was rewound. A compaction or a
 * clm fold rewrites the transcript's head instead, so nothing is cut: the list is rebuilt from the
 * transcript, keeping the addresses of the newest prompts that still line up from the end.
 * Known blind spot: a fold and a rewind between two submits read as a fold, and the rewound turns stay.
 */
export function reconcilePrompts(stored: readonly PromptRow[], current: readonly string[]): { rows: PromptRow[]; rewound: string[] } {
  const prefix = (short: readonly string[], long: readonly PromptRow[]) => short.length <= long.length && short.every((fp, i) => long[i]!.fp === fp)
  if (current.length < stored.length && prefix(current, stored)) {
    return { rows: stored.slice(0, current.length), rewound: stored.slice(current.length).flatMap(row => row.address ? [row.address] : []) }
  }
  if (stored.every((row, i) => current[i] === row.fp)) {
    return { rows: [...stored, ...current.slice(stored.length).map(fp => ({ fp }))], rewound: [] }
  }
  const rows: PromptRow[] = current.map(fp => ({ fp }))
  for (let i = stored.length - 1, j = current.length - 1; i >= 0 && j >= 0 && stored[i]!.fp === current[j]; i--, j--) {
    if (stored[i]!.address) rows[j] = { fp: current[j]!, address: stored[i]!.address }
  }
  return { rows, rewound: [] }
}
