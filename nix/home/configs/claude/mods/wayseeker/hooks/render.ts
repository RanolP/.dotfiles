import { isRecord, stripReminders } from './text'
import { parseLiteral, printArgument, printFact, printLiteral, type Fact, type Literal } from './syntax'
import { append, declarations, emptyLedger, liveIds, nextId, type Ledger } from './store'
import type { EvalResult } from './eval'
import { liveRubricItems, rubricSteps } from './stepped'

/** Session state key of the wayseeker Ledger for one transcript (`<session>:<agent or main>`). */
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

/** User rows whose stripped text equals `userMessage`. */
export const countUserRows = (messages: readonly { role: string; text: string }[], userMessage: string) =>
  messages.filter(row => row.role === 'user' && stripReminders(row.text) === userMessage).length

/**
 * Whether a prompt is still in the live transcript. `seen` is how many user rows with this text the
 * transcript held at submit time, this prompt included; a rewind drops it below that. The baseline comes
 * from the transcript, not the address index, because the index keeps rewound rows: "ok", rewound,
 * then resent would otherwise demand two rows where only the live resend remains.
 *
 * `host` is given for a prompt submitted over a running turn: the engine may fold it into that turn as an
 * attachment, which `$.session.messages()` never lists, or hold it queued, so it has no row of its own. Such a
 * prompt is live while the prompt whose turn it was delivered into is; the next submit's reconcilePrompts cuts
 * it if it was in fact withdrawn or rewound.
 */
export const turnIsLive = (
  messages: readonly { role: string; text: string }[], userMessage: string, seen: number, host?: { text: string; seen: number },
): boolean =>
  countUserRows(messages, userMessage) >= seen || (host !== undefined && countUserRows(messages, host.text) >= host.seen)

/** A stored value read back as a Ledger; anything malformed reads as the empty ledger. */
export function readWayseekerLedger(value: unknown): Ledger {
  if (!isRecord(value) || !Array.isArray(value.utterances) || !Array.isArray(value.decls) || !Array.isArray(value.glosses)) return emptyLedger()
  return { utterances: value.utterances, decls: value.decls, glosses: value.glosses } as Ledger
}

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()

// Korean particle pairs as [after a final consonant, after a vowel]; 으로/로 also takes 로 after ㄹ.
const PARTICLES: Record<string, [string, string]> = { 이: ['이', '가'], 가: ['이', '가'], 을: ['을', '를'], 를: ['을', '를'], 은: ['은', '는'], 는: ['은', '는'], 과: ['과', '와'], 와: ['과', '와'], 으로: ['으로', '로'], 로: ['으로', '로'] }

/** The particle a gloss wrote after {column}, re-picked for the substituted text's last syllable; after a non-Hangul end both forms show, as 이(가). */
const particleFor = (text: string, written: string): string => {
  const [consonant, vowel] = PARTICLES[written]!
  const code = text.charCodeAt(text.length - 1) - 0xac00
  if (!(code >= 0 && code < 11172)) return consonant === '으로' ? '(으)로' : `${consonant}(${vowel})`
  const final = code % 28
  return final === 0 || (consonant === '으로' && final === 8) ? vowel : consonant
}

/**
 * One Korean sentence for a fact: the declaration gloss with each {column} replaced by
 * the argument's gloss (or the atom itself); a gloss without placeholders gets the
 * arguments appended so no value is lost.
 */
function sentence(ledger: Ledger, fact: Fact, negated: boolean): string {
  const text = clause(ledger, fact)
  return negated ? `${text} — 아니다.` : /[.!?]$/.test(text) ? text : `${text}.`
}

/** The filled gloss of one fact without closing punctuation; a nested fact argument fills its column with its own clause. */
function clause(ledger: Ledger, fact: Fact): string {
  const decl = declarations(ledger).get(fact.name)
  const glossOf = (atom: string) => ledger.glosses.findLast(item => item.atom === atom)?.gloss ?? atom
  const values = fact.args.map(arg => arg.kind === 'atom' ? glossOf(arg.name)
    : arg.kind === 'fact' ? (declarations(ledger).has(arg.name) ? clause(ledger, arg) : printFact(arg))
    : printArgument(arg))
  let text: string
  if (decl?.gloss) {
    let used = false
    // A particle counts only as a whole word after the placeholder, so 이다/으로써 stay as written.
    text = decl.gloss.replace(/\{(\w+)\}(?:(으로|로|이|가|을|를|은|는|과|와)(?=[\s.,!?)]|$))?/g, (whole, column: string, particle: string | undefined) => {
      const index = decl.columns.indexOf(column)
      if (index < 0 || values[index] === undefined) return whole
      used = true
      const value = values[index]!
      // A trailing parenthetical is read past, as in 방식(과제 76)으로.
      return particle ? value + particleFor(oneLine(value).replace(/\s*\([^()]*\)$/, ''), particle) : value
    })
    if (!used && values.length) text = `${text}: ${values.join(', ')}`
  } else text = values.length ? `${fact.name}: ${values.join(', ')}` : fact.name
  return oneLine(text)
}

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
 * every live user want whose done(p) does not hold (the user's directives, goals and standing
 * preferences, conditional ones as "<premises>면 <conclusion>"; their observations and reports
 * stay facts in the ledger) and every proposal the
 * user accepted that still holds and is not done, then a "## raises" block for conflicts
 * still waiting on a decision and contested facts. Paid on every prompt, so empty
 * blocks are left out.
 */
export function renderInstructions(ledger: Ledger, result: EvalResult): string {
  const instructions: string[] = []
  const live = liveIds(ledger.utterances)
  const holds = (literal: Literal) => result.facts.get(printLiteral(literal))?.value === 'true'
  const done = (fact: Fact): Literal => ({ kind: 'literal', negated: false, fact: { kind: 'fact', name: 'done', args: [fact] } })
  // A user want is a standing instruction: p holding (say an agent's say(p)) does not end it; done(p) or reject(@n) does.
  // Unlike say.openItems, which closes any want once p holds.
  for (const u of ledger.utterances) {
    if (u.speaker !== 'user' || u.act.kind !== 'want' || !live.has(u.id)) continue
    const content = u.act.content
    if (content.kind === 'literal') {
      if (!holds(done(content.fact))) instructions.push(`- ${sentence(ledger, content.fact, content.negated)} ${address([u.id])}`)
      continue
    }
    const conclusion = content.conclusion
    if (conclusion.kind !== 'literal' || holds(done(conclusion.fact))) continue
    const premises = content.premises.map(p => p.kind === 'try' ? `${clause(ledger, p.fact)}를 시도한다` : p.negated ? `${clause(ledger, p.fact)}는 것이 아니라` : clause(ledger, p.fact))
    instructions.push(`- ${premises.join(', ')}면 ${sentence(ledger, conclusion.fact, conclusion.negated)} ${address([u.id])}`)
  }
  // An accepted try is the user's decision; it leaves once done(p) holds, as a want does.
  for (const u of ledger.utterances) {
    if (u.speaker !== 'user' || u.act.kind !== 'accept' || !live.has(u.id)) continue
    const target = u.act.target
    for (const t of ledger.utterances) {
      if (t.id !== target || t.act.kind !== 'try' || t.act.content.kind !== 'literal') continue
      const p = t.act.content
      if (holds(p) && !holds(done(p.fact))) instructions.push(`- ${sentence(ledger, p.fact, p.negated)} ${address([u.id])}`)
    }
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
  const steps = stepLines(ledger, holds)
  const section = (steps: readonly string[]) => [
    '## user instructions', instructions.length ? instructions.join('\n') : '- (none yet)',
    ...(steps.length ? ['## steps', steps.join('\n')] : []),
    ...(raises.length ? ['## raises', raises.join('\n')] : []),
  ].join('\n\n')
  const collapsed = (count: number) => count ? [`- 마친 step ${count}개`] : []
  const full = section([...steps.open, ...(steps.done.length > 3 ? collapsed(steps.done.length) : steps.done)])
  if (full.length <= SECTION_CAP || !steps.open.length && !steps.done.length) return full
  // Over the cap, done steps go first, then unfinished ones from the end; instructions and raises always stay.
  const shortened = section([...steps.open, ...collapsed(steps.done.length)])
  if (shortened.length <= SECTION_CAP) return shortened
  for (let keep = steps.open.length - 1; keep > 0; keep--) {
    const cut = section([...steps.open.slice(0, keep), `- …외 ${steps.open.length - keep + steps.done.length}개`])
    if (cut.length <= SECTION_CAP) return cut
  }
  return section([`- …외 ${steps.open.length + steps.done.length}개`])
}

// Provisional: the section rides every prompt; register.ts logs each delivered length so the cap can be measured.
const SECTION_CAP = 3000

/** One line per step check has a live rubric rule for: its gloss, items passed of the rule's items, and whether done(step) holds. */
function stepLines(ledger: Ledger, holds: (literal: Literal) => boolean): { open: string[]; done: string[] } {
  const open: string[] = [], done: string[] = []
  const atom = (name: string) => ({ kind: 'atom' as const, name })
  const fact = (name: string, args: string[]): Literal => ({ kind: 'literal', negated: false, fact: { kind: 'fact', name, args: args.map(atom) } })
  for (const step of rubricSteps(ledger)) {
    const items = liveRubricItems(ledger, step)
    if (!items) continue
    const passed = items.filter(item => holds(fact('pass', [step, item]))).length
    const finished = holds(fact('done', [step]))
    const gloss = ledger.glosses.findLast(g => g.atom === step)?.gloss
    const line = `- ${gloss ? `${oneLine(gloss)} (step ${step})` : `step ${step}`}: ${passed}/${items.length} 통과${finished ? ', 마쳤다' : ''}`
    ;(finished ? done : open).push(line)
  }
  return { open, done }
}
