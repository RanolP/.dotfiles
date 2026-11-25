import { isRecord } from './text'

/**
 * One user prompt as wayseeker last saw it: its text's fingerprint, and the turn address wayseeker gave it when it extracted it.
 * `midTurn` marks a prompt the engine folded into a running turn (a `queued_command` attachment): it has no row in
 * `$.session.messages()`, so it lives and is rewound with the visible prompt whose turn absorbed it.
 */
export type PromptRow = { fp: string; address?: string; midTurn?: true }

/** Session state key of the observed prompt list for one transcript. */
export const promptsKey = (key: string) => `prompts:${key}`

const fnv1a = (text: string) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return (hash >>> 0).toString(16).padStart(8, '0')
}
export const promptFingerprint = (text: string) => `${text.length}:${fnv1a(text)}`

export const readPromptRows = (value: unknown): PromptRow[] => Array.isArray(value)
  ? value.filter((row): row is PromptRow => isRecord(row) && typeof row.fp === 'string' && (row.address === undefined || typeof row.address === 'string') && (row.midTurn === undefined || row.midTurn === true))
  : []

/**
 * Lines the stored prompt list up with the prompts the transcript holds now, before the submitted
 * prompt's own row lands. A rewind truncates the transcript, so the current prompts are a proper
 * prefix of the stored ones and every stored prompt past that prefix was rewound. A compaction or a
 * clm fold rewrites the transcript's head instead, so nothing is cut: the list is rebuilt from the
 * transcript, keeping the addresses of the newest prompts that still line up from the end.
 * Known blind spot: a fold and a rewind between two submits read as a fold, and the rewound turns stay.
 * A midTurn row lines up with nothing: it rides with the visible row before it, kept while that row is and rewound with it.
 */
export function reconcilePrompts(stored: readonly PromptRow[], current: readonly string[]): { rows: PromptRow[]; rewound: string[] } {
  const visible: PromptRow[] = []
  const riders = new Map<number, PromptRow[]>() // index in `visible` of the host row (-1: none) -> the midTurn rows after it
  for (const row of stored) {
    if (row.midTurn) riders.set(visible.length - 1, [...(riders.get(visible.length - 1) ?? []), row])
    else visible.push(row)
  }
  const addresses = (rows: readonly PromptRow[]) => rows.flatMap(row => row.address ? [row.address] : [])
  // placed[j]: the index in `visible` that current prompt j lines up with, if any.
  const { rows: lined, placed, cut } = lineUp(visible, current)
  const rows: PromptRow[] = [...(riders.get(-1) ?? [])]
  lined.forEach((row, j) => { rows.push(row); if (placed[j] !== undefined) rows.push(...(riders.get(placed[j]!) ?? [])) })
  const rewound = cut === undefined ? [] : [
    ...addresses(visible.slice(cut)),
    ...[...riders].flatMap(([host, rode]) => host >= cut ? addresses(rode) : []),
  ]
  return { rows, rewound }
}

function lineUp(stored: readonly PromptRow[], current: readonly string[]): { rows: PromptRow[]; placed: (number | undefined)[]; cut?: number } {
  const prefix = (short: readonly string[], long: readonly PromptRow[]) => short.length <= long.length && short.every((fp, i) => long[i]!.fp === fp)
  if (current.length < stored.length && prefix(current, stored)) {
    return { rows: stored.slice(0, current.length), placed: current.map((_, j) => j), cut: current.length }
  }
  if (stored.every((row, i) => current[i] === row.fp)) {
    return { rows: [...stored, ...current.slice(stored.length).map(fp => ({ fp }))], placed: current.map((_, j) => j < stored.length ? j : undefined) }
  }
  const rows: PromptRow[] = current.map(fp => ({ fp }))
  const placed: (number | undefined)[] = current.map(() => undefined)
  for (let i = stored.length - 1, j = current.length - 1; i >= 0 && j >= 0 && stored[i]!.fp === current[j]; i--, j--) {
    placed[j] = i
    if (stored[i]!.address) rows[j] = { fp: current[j]!, address: stored[i]!.address }
  }
  return { rows, placed }
}
