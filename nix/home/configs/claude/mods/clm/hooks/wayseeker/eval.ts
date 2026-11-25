// wayseeker evaluator: event-calculus initiations, JTMS support sets, rank/recency conflict
// resolution, and well-founded semantics (alternating fixpoint) for self-defeating loops.
import { factKey, parseLiteral, printLiteral, type Argument, type Fact, type Literal, type Premise, type Utterance } from './syntax'
import { declarations, liveIds, type Ledger } from './store'

export type FactValue = 'true' | 'false' | 'unknown' | 'contested'
export type Raise = { kind: 'conflict' | 'contested'; key: string; facts: string[]; winner?: string; loser?: string; mode: 'resolve' | 'raise' | 'ask_model' }
export type ProofNode = { fact: string; support: number[]; rule?: number; appended?: number[]; accepted?: number; premises: ProofNode[] }
export type EvalResult = {
  facts: Map<string, { value: FactValue; support: number[]; defeatedBy?: number }>
  openQuestions: number[]
  flaggedTries: number[]
  raises: Raise[]
  fuelExhausted: boolean
  tryPolicy: Array<{ tryId: number; fact: string; policy: 'report' | 'proceed' }>
  proof(fact: string): unknown
}

type Cand = { literal: Literal; key: string; support: number[]; rank: number; latest: number; derived: boolean; proof: ProofNode }
type Rule = { id: number; premises: Premise[]; conclusion: Literal }
type Env = Map<string, string>
type Store = Map<string, Cand>

class FuelExhausted extends Error {}

const SPEAKER_RANK: Record<string, number> = { user: 3, agent: 2, worker: 1 }
const rankOf = (speaker: string): number => SPEAKER_RANK[speaker] ?? 0 // pasted-material speakers rank last

const complementKey = (literal: Literal): string => printLiteral({ ...literal, negated: !literal.negated })
const isRaiseOn = (literal: Literal): boolean => literal.fact.name === 'raise_on'

/** >0 when a beats b. raise_on literals compare by recency only (U2), so rule fights never escalate. */
const compare = (a: Cand, b: Cand): number => {
  if (!(isRaiseOn(a.literal) && isRaiseOn(b.literal)) && a.rank !== b.rank) return a.rank - b.rank
  if (a.latest !== b.latest) return a.latest - b.latest
  // Exact ties (two lines of one @n) need a deterministic winner; the larger printed literal wins.
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

const makeCand = (literal: Literal, support: Iterable<number>, ranks: Map<number, number>, derived: boolean, proof: Omit<ProofNode, 'fact' | 'support'>): Cand => {
  const ids = [...new Set(support)].sort((x, y) => x - y)
  const key = printLiteral(literal)
  return {
    literal, key, support: ids, derived,
    rank: Math.min(...ids.map(id => ranks.get(id) ?? 0)),
    latest: Math.max(...ids),
    proof: { fact: key, support: ids, ...proof },
  }
}

export function evaluate(ledger: Ledger, opts: { atTime?: number; fuel?: number } = {}): EvalResult {
  const atTime = opts.atTime ?? Number.POSITIVE_INFINITY
  const fuel = { left: opts.fuel ?? 10_000 }
  const utterances = ledger.utterances.filter(u => u.id <= atTime)
  const live = liveIds(utterances)
  const decls = declarations(ledger)
  const ranks = new Map<number, number>()
  for (const u of utterances) ranks.set(u.id, Math.min(ranks.get(u.id) ?? 3, rankOf(u.speaker)))
  const linesOf = (id: number) => utterances.filter(u => u.id === id)
  const liveLines = utterances.filter(u => live.has(u.id))

  // Functional-dependency slot: predicate plus the key columns' values; with every column as key this is the fact itself (set semantics).
  const slotOf = (fact: Fact): string => {
    const decl = decls.get(fact.name)
    const columns = decl ? decl.key.map(c => decl.columns.indexOf(c)) : fact.args.map((_, i) => i)
    return fact.name + '/' + columns.map(i => printArg(fact.args[i])).join('|')
  }
  const conflicts = (a: Cand, b: Cand): boolean => {
    if (a.literal.negated !== b.literal.negated) return factKey(a.literal.fact) === factKey(b.literal.fact)
    return !a.literal.negated && a.key !== b.key && slotOf(a.literal.fact) === slotOf(b.literal.fact)
  }
  const routingKey = (fact: Fact): string => {
    const decl = decls.get(fact.name)
    const first = decl?.key[0]
    if (!decl || first === undefined) return fact.name
    return printArg(fact.args[decl.columns.indexOf(first)])
  }

  // Initiations: live say(p), and live accept(@n) of a live try/want.
  const direct: Cand[] = []
  for (const u of liveLines) {
    const act = u.act
    if (act.kind === 'say' && act.content.kind === 'literal') direct.push(makeCand(act.content, [u.id], ranks, false, { premises: [] }))
    if (act.kind === 'accept' && live.has(act.target)) {
      for (const target of linesOf(act.target)) {
        const t = target.act
        if ((t.kind === 'try' || t.kind === 'want') && t.content.kind === 'literal') direct.push(makeCand(t.content, [u.id], ranks, false, { accepted: target.id, premises: [] }))
      }
    }
  }

  // Rules, and premise appends keyed by the conclusion they constrain.
  const accepted = new Set(liveLines.flatMap(u => u.act.kind === 'accept' ? [u.act.target] : []))
  const rules: Rule[] = []
  const appends = new Map<string, { id: number; premises: Premise[] }[]>()
  for (const u of liveLines) {
    const act = u.act
    if (act.kind !== 'condition') continue
    if (act.conclusion.kind === 'literal') rules.push({ id: u.id, premises: act.premises, conclusion: act.conclusion })
  }
  for (const u of liveLines) {
    const act = u.act
    if (act.kind !== 'condition' || act.conclusion.kind !== 'reference') continue
    const target = rules.find(r => r.id === (act.conclusion as { id: number }).id)
    if (!target) continue
    // A lower-ranked speaker's append stays a proposal until accepted.
    if (rankOf(u.speaker) < (ranks.get(target.id) ?? 0) && !accepted.has(u.id)) continue
    const head = printLiteral(target.conclusion)
    appends.set(head, [...(appends.get(head) ?? []), { id: u.id, premises: act.premises }])
  }

  const derive = (store: Store): Cand[] => {
    const index = new Map<string, Cand[]>()
    for (const c of store.values()) {
      const k = (c.literal.negated ? '-' : '+') + c.literal.fact.name
      index.set(k, [...(index.get(k) ?? []), c])
    }
    const out: Cand[] = []
    for (const rule of rules) {
      const extra = appends.get(printLiteral(rule.conclusion)) ?? []
      const premises = [...rule.premises, ...extra.flatMap(a => a.premises)]
      let matches: { env: Env; used: Cand[] }[] = [{ env: new Map(), used: [] }]
      for (const premise of premises) {
        if (premise.kind !== 'literal') { matches = []; break }
        const pool = index.get((premise.negated ? '-' : '+') + premise.fact.name) ?? []
        const next: typeof matches = []
        for (const m of matches) for (const c of pool) {
          const env = unify(premise.fact, c.literal.fact, m.env)
          if (env) next.push({ env, used: [...m.used, c] })
        }
        matches = next
        if (matches.length === 0) break
      }
      for (const m of matches) {
        const fact = instantiate(rule.conclusion.fact, m.env)
        if (!fact) continue
        const support = [rule.id, ...extra.map(a => a.id), ...m.used.flatMap(c => c.support)]
        out.push(makeCand({ kind: 'literal', negated: rule.conclusion.negated, fact }, support, ranks, true, {
          rule: rule.id, ...(extra.length ? { appended: extra.map(a => a.id) } : {}), premises: m.used.map(c => c.proof),
        }))
      }
    }
    return out
  }

  // Γ(P): least fixpoint where a candidate is blocked by any conflicting candidate in P that beats it.
  const gamma = (blockers: Store): Store => {
    const rivals = [...blockers.values()]
    const blocked = (c: Cand) => rivals.some(r => conflicts(r, c) && compare(r, c) > 0)
    const store: Store = new Map()
    for (;;) {
      if (fuel.left <= 0) throw new FuelExhausted()
      fuel.left--
      let changed = false
      for (const c of [...direct, ...derive(store)]) {
        if (blocked(c)) continue
        const current = store.get(c.key)
        if (!current || compare(c, current) > 0) { store.set(c.key, c); changed = true }
      }
      if (!changed) return store
    }
  }

  const sameKeys = (a: Store, b: Store) => a.size === b.size && [...a.keys()].every(k => b.has(k))
  let universe: Store = new Map(direct.map(c => [c.key, c]))
  let truth: Store = new Map()
  let possible: Store = new Map()
  let fuelExhausted = false
  try {
    universe = gamma(new Map())
    possible = universe
    truth = gamma(possible)
    for (;;) {
      const nextPossible = gamma(truth)
      const nextTruth = gamma(nextPossible)
      const stable = sameKeys(nextTruth, truth) && sameKeys(nextPossible, possible)
      possible = nextPossible
      truth = nextTruth
      if (stable) break
    }
  } catch (error) {
    if (!(error instanceof FuelExhausted)) throw error
    fuelExhausted = true
    possible = truth // only the last completed underestimate stays settled
  }
  const undefinedKeys = new Set([...possible.keys()].filter(k => !truth.has(k)))

  // Fact table over every ground literal mentioned or derivable.
  const mentioned = new Map<string, Literal>()
  const mention = (l: Literal) => { if (l.fact.args.every(a => a.kind === 'atom')) mentioned.set(printLiteral(l), l) }
  for (const u of utterances) for (const l of literalsOf(u)) mention(l)
  for (const c of universe.values()) mention(c.literal)
  const strongestBeating = (c: Cand): Cand | undefined => {
    let best: Cand | undefined
    for (const w of truth.values()) if (conflicts(w, c) && compare(w, c) > 0 && (!best || compare(w, best) > 0)) best = w
    return best
  }
  const facts: EvalResult['facts'] = new Map()
  for (const [key, literal] of mentioned) {
    const complement = complementKey(literal)
    const own = truth.get(key)
    const other = truth.get(complement)
    if (own) facts.set(key, { value: 'true', support: own.support })
    else if (other) facts.set(key, { value: 'false', support: other.support })
    else if (undefinedKeys.has(key) || undefinedKeys.has(complement)) facts.set(key, { value: 'contested', support: [] })
    else {
      const loser = universe.get(key)
      const winner = loser && !fuelExhausted ? strongestBeating(loser) : undefined
      facts.set(key, { value: 'unknown', support: [], ...(winner ? { defeatedBy: winner.latest } : {}) })
    }
  }

  const modeFor = (key: string): Raise['mode'] => {
    if (truth.has('raise_on(' + key + ')')) return 'raise'
    if (truth.has('not(raise_on(' + key + '))')) return 'resolve'
    return 'ask_model'
  }
  const raises: Raise[] = []
  if (!fuelExhausted) {
    for (const loser of universe.values()) {
      if (truth.has(loser.key) || undefinedKeys.has(loser.key) || isRaiseOn(loser.literal)) continue
      const winner = strongestBeating(loser)
      if (!winner) continue
      const key = routingKey(winner.literal.fact)
      const mode = modeFor(key)
      // A newer stated value from an equal-or-higher speaker is a plain key update, not a contradiction;
      // it surfaces only when raise_on(K) asks for every change on K.
      const supersession = !winner.derived && !loser.derived && !winner.literal.negated && !loser.literal.negated && winner.latest > loser.latest && winner.rank >= loser.rank
      if (supersession && mode !== 'raise') continue
      raises.push({ kind: 'conflict', key, facts: [winner.key, loser.key], winner: winner.key, loser: loser.key, mode })
    }
    if (undefinedKeys.size > 0) {
      const contested = [...undefinedKeys].sort()
      const first = possible.get(contested[0]!)!
      raises.push({ kind: 'contested', key: routingKey(first.literal.fact), facts: contested, mode: 'raise' })
    }
  }

  const holds = (pattern: Literal): boolean => [...truth.values()].some(c => c.literal.negated === pattern.negated && !!unify(pattern.fact, c.literal.fact, new Map()))
  const openQuestions: number[] = []
  const flaggedTries: number[] = []
  for (const u of liveLines) {
    const act = u.act
    if (act.kind === 'ask' && act.content.kind === 'literal') {
      const q = act.content
      const answered = holds(q) || (q.fact.args.every(a => a.kind === 'atom') && holds({ ...q, negated: !q.negated }))
      if (!answered && !openQuestions.includes(u.id)) openQuestions.push(u.id)
    }
    if (act.kind === 'try' && act.content.kind === 'literal') {
      const probe = makeCand(act.content, [u.id], ranks, false, { premises: [] })
      if (!truth.has(probe.key) && [...truth.values()].some(w => conflicts(w, probe)) && !flaggedTries.includes(u.id)) flaggedTries.push(u.id)
    }
  }

  // try(p) -> report|proceed (R18): newest rule of the highest-ranked speaker wins; no rule means report.
  const policyRules = liveLines.flatMap(u => {
    const act = u.act
    if (act.kind !== 'condition' || act.premises[0]?.kind !== 'try') return []
    const c = act.conclusion
    return c.kind === 'report' || c.kind === 'proceed' ? [{ id: u.id, rank: rankOf(u.speaker), pattern: act.premises[0].fact, policy: c.kind }] : []
  })
  const tryPolicy: EvalResult['tryPolicy'] = []
  for (const u of liveLines) {
    const act = u.act
    if (act.kind !== 'try' || act.content.kind !== 'literal' || act.content.negated || accepted.has(u.id)) continue
    const fact = act.content.fact
    let best: (typeof policyRules)[number] | undefined
    for (const r of policyRules) if (unify(r.pattern, fact, new Map()) && (!best || r.rank > best.rank || (r.rank === best.rank && r.id > best.id))) best = r
    tryPolicy.push({ tryId: u.id, fact: factKey(fact), policy: best?.policy ?? 'report' })
  }

  return {
    facts, openQuestions, flaggedTries, raises, fuelExhausted, tryPolicy,
    proof(fact: string) {
      let key: string
      try { key = printLiteral(parseLiteral(fact)) } catch { return undefined }
      return truth.get(key)?.proof
    },
  }
}

const printArg = (a: Argument | undefined): string => a === undefined ? '' : a.kind === 'atom' ? a.name : '?' + a.name

const unify = (pattern: Fact, ground: Fact, env: Env): Env | undefined => {
  if (pattern.name !== ground.name || pattern.args.length !== ground.args.length) return undefined
  let out = env
  for (let i = 0; i < pattern.args.length; i++) {
    const p = pattern.args[i]!
    const g = ground.args[i]!
    if (g.kind !== 'atom') return undefined
    if (p.kind === 'atom') { if (p.name !== g.name) return undefined; continue }
    const bound = out.get(p.name)
    if (bound !== undefined) { if (bound !== g.name) return undefined; continue }
    out = new Map(out)
    out.set(p.name, g.name)
  }
  return out
}

const instantiate = (fact: Fact, env: Env): Fact | undefined => {
  const args: Argument[] = []
  for (const a of fact.args) {
    if (a.kind === 'atom') { args.push(a); continue }
    const value = env.get(a.name)
    if (value === undefined) return undefined
    args.push({ kind: 'atom', name: value })
  }
  return { kind: 'fact', name: fact.name, args }
}

const literalsOf = (u: Utterance): Literal[] => {
  const act = u.act
  if (act.kind === 'accept' || act.kind === 'reject') return []
  const condition = act.kind === 'condition' ? act : act.content.kind === 'condition' ? act.content : undefined
  if (!condition) return act.kind === 'condition' ? [] : [act.content as Literal]
  return [...condition.premises.flatMap(p => p.kind === 'literal' ? [p] : []), ...(condition.conclusion.kind === 'literal' ? [condition.conclusion] : [])]
}
