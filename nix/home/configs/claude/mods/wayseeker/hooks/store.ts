// Append-only wayseeker ledger. append validates one line against everything before it and returns a new Ledger.
import { parseLine, type Condition, type Decl, type Fact, type Gloss, type Line, type Utterance } from './syntax'
import { isRecord } from './text'

export type Ledger = { utterances: Utterance[]; decls: Decl[]; glosses: Gloss[] }

export const deliveredSectionKey = (key: string) => `delivered-section:${key}`
/** atSubmit: the section rode this turn's prompt.submit, whose row may not carry it by the first tool.call. */
export const readDeliveredSection = (value: unknown): { fingerprint: string; section: string; atSubmit: boolean } | undefined =>
  isRecord(value) && typeof value.fingerprint === 'string' && typeof value.section === 'string'
    ? { fingerprint: value.fingerprint, section: value.section, atSubmit: value.atSubmit === true } : undefined

export const BASE_SPEAKERS = ['user', 'agent', 'worker'] as const

// raise_on(K) routes conflicts (design page U2); usable without a decl line.
export const BUILTIN_DECLS: Decl[] = [{ kind: 'declaration', name: 'raise_on', columns: ['key'], key: ['key'], gloss: 'conflicts on this key are raised to the user' }]

export function emptyLedger(): Ledger { return { utterances: [], decls: [], glosses: [] } }

export function nextId(ledger: Ledger): number { return ledger.utterances.reduce((max, u) => Math.max(max, u.id), 0) + 1 }

/** Latest declaration per predicate, builtins first so a ledger decl overrides them. */
export const declarations = (ledger: Ledger): Map<string, Decl> => new Map([...BUILTIN_DECLS, ...ledger.decls].map(d => [d.name, d]))

/** Ids whose lines are still live: not the target of a live reject. Rejects point backward, so one reverse pass settles it. */
export const liveIds = (utterances: readonly Utterance[]): Set<number> => {
  const dead = new Set<number>()
  const ordered = [...utterances].sort((a, b) => b.id - a.id)
  for (const u of ordered) if (u.act.kind === 'reject' && !dead.has(u.id)) dead.add(u.act.target)
  return new Set(utterances.map(u => u.id).filter(id => !dead.has(id)))
}

const conditionFacts = (condition: Condition): Fact[] => [...condition.premises.map(p => p.fact), ...(condition.conclusion.kind === 'literal' ? [condition.conclusion.fact] : [])]

// Every fact of a line, nested argument facts included, so each one is checked against its own decl.
const withNested = (fact: Fact): Fact[] => [fact, ...fact.args.flatMap(a => a.kind === 'fact' ? withNested(a) : [])]

const factsOf = (u: Utterance): Fact[] => {
  const act = u.act
  if (act.kind === 'accept' || act.kind === 'reject') return []
  const top = act.kind === 'condition' ? conditionFacts(act) : act.content.kind === 'condition' ? conditionFacts(act.content) : [act.content.fact]
  return top.flatMap(withNested)
}

const validateUtterance = (ledger: Ledger, u: Utterance): string[] => {
  const errors: string[] = []
  const latest = nextId(ledger) - 1
  // One user message may emit several lines under the same @n, so an equal id is another line of it.
  if (u.id < latest) errors.push('@' + u.id + ' is earlier than the latest @' + latest)
  if (u.id < 1) errors.push('utterance ids start at @1')
  const pasted = new Set(ledger.glosses.map(g => g.atom))
  if (!(BASE_SPEAKERS as readonly string[]).includes(u.speaker) && !pasted.has(u.speaker)) errors.push('speaker ' + u.speaker + ' is neither user, agent, worker nor a glossed pasted-material atom')

  const decls = declarations(ledger)
  for (const fact of factsOf(u)) {
    const decl = decls.get(fact.name)
    if (!decl) errors.push('predicate ' + fact.name + ' is not declared')
    else if (decl.columns.length !== fact.args.length) errors.push(fact.name + ' takes ' + decl.columns.length + ' arguments, got ' + fact.args.length)
  }

  const act = u.act
  const target = act.kind === 'accept' || act.kind === 'reject' ? act.target : act.kind === 'condition' && act.conclusion.kind === 'reference' ? act.conclusion.id : undefined
  if (target !== undefined) {
    const lines = ledger.utterances.filter(x => x.id === target)
    if (target >= u.id || lines.length === 0) errors.push('@' + target + ' must refer to an earlier utterance')
    else if (act.kind === 'condition') {
      const rule = lines.find(x => x.act.kind === 'condition' && x.act.conclusion.kind === 'literal')
      if (!rule) errors.push('@' + target + ' is not a conditional with a fact conclusion (appending to an append is not allowed)')
      else if (!liveIds(ledger.utterances).has(target)) errors.push('@' + target + ' was rejected and is no longer live')
    }
  }
  return errors
}

export function append(ledger: Ledger, line: string): { ok: boolean; errors: string[]; ledger: Ledger } {
  const parsed = parseLine(line)
  if (!parsed.ok) return { ok: false, errors: [parsed.error], ledger }
  const entry: Line = parsed.entry
  if (entry.kind === 'declaration') {
    const previous = declarations(ledger).get(entry.name)
    if (previous && previous.columns.length !== entry.columns.length) return { ok: false, errors: ['cannot change the arity of ' + entry.name], ledger }
    return { ok: true, errors: [], ledger: { ...ledger, decls: [...ledger.decls, entry] } }
  }
  if (entry.kind === 'gloss') {
    if ((BASE_SPEAKERS as readonly string[]).includes(entry.atom)) return { ok: false, errors: [entry.atom + ' is a reserved speaker'], ledger }
    return { ok: true, errors: [], ledger: { ...ledger, glosses: [...ledger.glosses, entry] } }
  }
  const errors = validateUtterance(ledger, entry)
  if (errors.length > 0) return { ok: false, errors, ledger }
  return { ok: true, errors: [], ledger: { ...ledger, utterances: [...ledger.utterances, entry] } }
}

/** Builds a ledger from lines, throwing on the first rejected one (tests and fixtures). */
export const appendAll = (lines: readonly string[], start: Ledger = emptyLedger()): Ledger => {
  let ledger = start
  for (const line of lines) {
    const result = append(ledger, line)
    if (!result.ok) throw new Error(line + ': ' + result.errors.join('; '))
    ledger = result.ledger
  }
  return ledger
}
