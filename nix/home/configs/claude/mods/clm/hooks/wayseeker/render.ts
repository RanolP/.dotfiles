import { stripReminders } from '../fold'
import { isRecord } from '../tracker'
import { parseLiteral, printArgument, type Fact } from './syntax'
import { append, emptyLedger, nextId, type Ledger } from './store'
import type { EvalResult } from './eval'

/** Session store key of the wayseeker Ledger, kept beside clauseStoreKey's `clauses:<key>`. */
export const wayseekerKey = (key: string) => `wayseeker:${key}`

/** Which prompt address appended which utterances, so a rewind can cut that prompt's lines back out. */
export type WayseekerTurn = { address: string; firstId: number }
/** The stored record: the Ledger plus the turn index rewind reads. */
export type StoredWayseeker = Ledger & { turns?: WayseekerTurn[] }

const isTurn = (value: unknown): value is WayseekerTurn => isRecord(value) && typeof value.address === 'string' && typeof value.firstId === 'number'

/**
 * The stored ledger with the rewound prompts' utterances cut. A rewind removes the transcript's tail,
 * so every utterance from the earliest rewound turn on goes; declarations and glosses stay. Undefined when nothing changes.
 */
export function dropWayseekerTurns(value: unknown, addresses: ReadonlySet<string>): StoredWayseeker | undefined {
  if (!isRecord(value) || !Array.isArray(value.turns)) return undefined
  const ledger = readWayseekerLedger(value)
  const turns = value.turns.filter(isTurn)
  const cut = turns.filter(turn => addresses.has(turn.address)).map(turn => turn.firstId)
  if (!cut.length) return undefined
  const from = Math.min(...cut)
  return { ...ledger, utterances: ledger.utterances.filter(u => u.id < from), turns: turns.filter(turn => turn.firstId < from) }
}

export const readWayseekerTurns = (value: unknown): WayseekerTurn[] => isRecord(value) && Array.isArray(value.turns) ? value.turns.filter(isTurn) : []

/**
 * Lands one turn's extracted lines after the model call. The store is read again here, not before
 * the call, so a rewind that trimmed the ledger meanwhile stands: the lines replay onto the fresh
 * ledger (a line citing a cut utterance fails validation and is dropped), and a turn the rewind
 * removed writes nothing. Run inside the session's serialize, as landClauses does.
 */
export async function landWayseekerTurn(
  io: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; isLive(): Promise<boolean> },
  key: string, appended: readonly string[], address?: string,
): Promise<{ landed: string[]; dropped: { line: string; errors: string[] }[]; rewound: boolean }> {
  if (!appended.length) return { landed: [], dropped: [], rewound: false }
  if (!(await io.isLive())) return { landed: [], dropped: [], rewound: true }
  const stored = await io.get(wayseekerKey(key))
  let ledger = readWayseekerLedger(stored)
  const turns = readWayseekerTurns(stored)
  const firstId = nextId(ledger)
  const landed: string[] = []
  const dropped: { line: string; errors: string[] }[] = []
  for (const line of appended) {
    const result = append(ledger, line)
    if (result.ok) { ledger = result.ledger; landed.push(line) } else dropped.push({ line, errors: result.errors })
  }
  if (!landed.length) return { landed, dropped, rewound: false }
  const added = ledger.utterances.some(u => u.id >= firstId)
  await io.set(wayseekerKey(key), { ...ledger, turns: added && address ? [...turns, { address, firstId }] : turns })
  return { landed, dropped, rewound: false }
}

/**
 * Whether the prompt at `address` is still in the live transcript. Positional, not by text: a short
 * prompt ("ok") said twice is live only while the transcript still holds as many user rows with that
 * text as the address index has up to and including this address. False when the address is unknown.
 */
export function turnIsLive(
  addressRows: readonly { address: string; text: string }[], messages: readonly { role: string; text: string }[],
  address: string | undefined, userMessage: string,
): boolean {
  const upto = address === undefined ? -1 : addressRows.findIndex(row => row.address === address)
  if (upto < 0) return false
  const need = addressRows.slice(0, upto + 1).filter(row => stripReminders(row.text) === userMessage).length
  const have = messages.filter(row => row.role === 'user' && stripReminders(row.text) === userMessage).length
  return have >= need
}

/** A stored value read back as a Ledger; anything malformed reads as the empty ledger. */
export function readWayseekerLedger(value: unknown): Ledger {
  if (!isRecord(value) || !Array.isArray(value.utterances) || !Array.isArray(value.decls) || !Array.isArray(value.glosses)) return emptyLedger()
  return { utterances: value.utterances, decls: value.decls, glosses: value.glosses } as Ledger
}

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()

/**
 * One Korean sentence for a fact: the declaration gloss with each {column} replaced by
 * the argument's gloss (or the atom itself); a gloss without placeholders gets the
 * arguments appended so no value is lost.
 */
function sentence(ledger: Ledger, fact: Fact, negated: boolean): string {
  const decl = ledger.decls.findLast(item => item.name === fact.name)
  const glossOf = (atom: string) => ledger.glosses.findLast(item => item.atom === atom)?.gloss ?? atom
  const values = fact.args.map(arg => arg.kind === 'atom' ? glossOf(arg.name) : printArgument(arg))
  let text: string
  if (decl?.gloss) {
    let used = false
    text = decl.gloss.replace(/\{(\w+)\}/g, (whole, column: string) => {
      const index = decl.columns.indexOf(column)
      if (index < 0 || values[index] === undefined) return whole
      used = true
      return values[index]!
    })
    if (!used && values.length) text = `${text}: ${values.join(', ')}`
  } else text = values.length ? `${fact.name}: ${values.join(', ')}` : fact.name
  text = oneLine(text)
  return negated ? `${text} — 아니다.` : /[.!?]$/.test(text) ? text : `${text}.`
}

const userIds = (ledger: Ledger) => new Set(ledger.utterances.filter(u => u.speaker === 'user').map(u => u.id))
const address = (ids: readonly number[]) => `(${ids.map(id => `@${id}`).join(' ')})`

/** A printed literal key ("use(lang, python)" / "not(use(lang, python))") as one sentence; an unparsable key stays as written. */
const literalSentence = (ledger: Ledger, key: string) => {
  try {
    const literal = parseLiteral(key)
    return sentence(ledger, literal.fact, literal.negated)
  } catch { return key }
}

/**
 * The resident ledger's "## user instructions" section from a wayseeker Ledger:
 * every live fact a user utterance supports, then a "## raises" block for conflicts
 * still waiting on a decision and contested facts. Paid on every prompt, so empty
 * blocks are left out.
 */
export function renderInstructions(ledger: Ledger, result: EvalResult): string {
  const users = userIds(ledger)
  const instructions: string[] = []
  for (const [key, state] of result.facts) {
    if (state.value !== 'true') continue
    const spoken = state.support.filter(id => users.has(id))
    if (spoken.length) instructions.push(`- ${literalSentence(ledger, key)} ${address(spoken)}`)
  }
  // Facts settled before fuel ran out still render above; this line says the rest are undecided.
  const raises: string[] = result.fuelExhausted ? ['- 평가 한도 초과: 일부 사실을 정하지 못했다. 사용자에게 묻는다.'] : []
  const contested = new Set<string>()
  for (const raise of result.raises) {
    if (raise.kind === 'contested') { raise.facts.forEach(fact => contested.add(fact)); continue }
    if (raise.mode === 'resolve') continue
    const how = raise.mode === 'raise' ? '사용자에게 묻는다' : '맞는지 판단한다'
    const [winner, loser] = [raise.winner ?? raise.facts[0], raise.loser ?? raise.facts[1]]
    raises.push(`- 충돌: ${literalSentence(ledger, winner ?? raise.key).replace(/\.$/, '')} ↔ ${literalSentence(ledger, loser ?? raise.key).replace(/\.$/, '')} — ${how}`)
  }
  for (const [key, state] of result.facts) if (state.value === 'contested') contested.add(key)
  for (const key of contested) raises.push(`- 다툼: ${literalSentence(ledger, key).replace(/\.$/, '')} — 사용자에게 묻는다`)
  return [
    '## user instructions', instructions.length ? instructions.join('\n') : '- (none yet)',
    ...(raises.length ? ['## raises', raises.join('\n')] : []),
  ].join('\n\n')
}
