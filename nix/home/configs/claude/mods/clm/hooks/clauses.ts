import { isRecord } from './tracker'

// The user's standing requests as restricted Prolog clauses. A newer clause
// retracts an older one when both define the same key of a predicate: same
// name/arity, leading `key` args unify, and the clauses are not identical.
// Retracted clauses stay in the store so clm_recall can show what replaced them.

export type Term = { atom: string } | { num: number } | { var: string } | { str: string }
  | { list: Term[] } | { fn: string; args: Term[] }
export type Goal = { neg: boolean; name: string; args: Term[] }
export type Clause = {
  id: string; head: { name: string; args: Term[] }; neg: boolean; body: Goal[]
  // `text` is a one-sentence Korean rendering for display; conflicts are decided on the parsed head alone.
  source: string; text: string; quote: string; address: string; promptSeq: number
  issue: string | null; at: string; status: 'live' | 'retracted'
  retraction?: { at: string; by: string; bySource: string; reason: 'conflict' | 'explicit' | 'rewind' }
}
export type ClauseStore = {
  version: 1; nextId: number
  predicates: Record<string, { key: number; example: string }>
  clauses: Clause[]; migratedLegacy?: boolean
}
export type ParsedClause = Pick<Clause, 'head' | 'neg' | 'body'>
/** One clause to apply: parsed, its quote already checked against the prompt it came from. */
export type IncomingClause = ParsedClause & { text: string; quote: string; address: string; issue: string | null; key?: number }
export type BacklogEntry = { address: string; promptSeq: number; text: string }

export const clauseStoreKey = (key: string) => `clauses:${key}`
export const clauseBacklogKey = (key: string) => `clause-backlog:${key}`
export const emptyClauseStore = (): ClauseStore => ({ version: 1, nextId: 1, predicates: {}, clauses: [] })

const MAX_RETRACTED = 500

// --- parse and print ---------------------------------------------------------

type Token = { kind: 'atom' | 'qatom' | 'var' | 'num' | 'str' | 'punct'; text: string }

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const quoted = (close: string) => {
    let text = ''
    for (i++; i < source.length; i++) {
      const c = source[i]!
      if (c === '\\' && i + 1 < source.length) { text += source[++i]; continue }
      if (c === close) {
        if (close === "'" && source[i + 1] === "'") { text += "'"; i++; continue }
        i++
        return text
      }
      text += c
    }
    throw new Error(`unterminated ${close === '"' ? 'string' : 'quoted atom'}`)
  }
  while (i < source.length) {
    const rest = source.slice(i)
    const space = /^(?:\s+|%[^\n]*)/.exec(rest)
    if (space) { i += space[0].length; continue }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (word) { tokens.push({ kind: /^[a-z]/.test(word[0]) ? 'atom' : 'var', text: word[0] }); i += word[0].length; continue }
    const num = /^-?\d+(?:\.\d+)?/.exec(rest)
    if (num) { tokens.push({ kind: 'num', text: num[0] }); i += num[0].length; continue }
    const punct = /^(?::-|\\\+|[(),[\].])/.exec(rest)
    if (punct) { tokens.push({ kind: 'punct', text: punct[0] }); i += punct[0].length; continue }
    if (rest[0] === "'") { tokens.push({ kind: 'qatom', text: quoted("'") }); continue }
    if (rest[0] === '"') { tokens.push({ kind: 'str', text: quoted('"') }); continue }
    throw new Error(`unexpected ${JSON.stringify(rest[0])}`)
  }
  return tokens
}

/** Parses one clause (`head.`, `\+ head.`, `head :- goal, \+ goal.`) and checks it is range-restricted. */
export function parseClause(source: string): ParsedClause {
  const tokens = tokenize(source)
  let at = 0
  const peek = () => tokens[at]
  const isPunct = (text: string) => peek()?.kind === 'punct' && peek()?.text === text
  const expect = (text: string) => {
    if (!isPunct(text)) throw new Error(`expected ${text}${peek() ? ` before ${peek()!.text}` : ' at the end'}`)
    at++
  }
  const args = (): Term[] => {
    expect('(')
    const out = [term()]
    while (isPunct(',')) { at++; out.push(term()) }
    expect(')')
    return out
  }
  const term = (): Term => {
    const token = tokens[at++]
    if (!token) throw new Error('clause ends inside a term')
    if (token.kind === 'var') return { var: token.text }
    if (token.kind === 'num') return { num: Number(token.text) }
    if (token.kind === 'str') return { str: token.text }
    if (token.kind === 'atom' || token.kind === 'qatom') return isPunct('(') ? { fn: token.text, args: args() } : { atom: token.text }
    if (token.text === '[') {
      const items: Term[] = []
      if (!isPunct(']')) {
        items.push(term())
        while (isPunct(',')) { at++; items.push(term()) }
      }
      expect(']')
      return { list: items }
    }
    throw new Error(`unexpected ${token.text}`)
  }
  const goal = (): Goal => {
    const neg = isPunct('\\+')
    if (neg) at++
    const token = tokens[at++]
    if (!token || (token.kind !== 'atom' && token.kind !== 'qatom')) throw new Error('a goal must start with a predicate name')
    return { neg, name: token.text, args: isPunct('(') ? args() : [] }
  }
  const head = goal()
  const body: Goal[] = []
  if (isPunct(':-')) {
    at++
    body.push(goal())
    while (isPunct(',')) { at++; body.push(goal()) }
  }
  expect('.')
  if (at !== tokens.length) throw new Error('text after the clause end')
  const clause = { head: { name: head.name, args: head.args }, neg: head.neg, body }
  const unbound = unrestrictedVars(clause)
  if (unbound.length) throw new Error(`variables ${unbound.join(', ')} appear in no positive body goal`)
  return clause
}

function varsOf(terms: readonly Term[], out = new Set<string>()): Set<string> {
  for (const t of terms) {
    if ('var' in t) out.add(t.var)
    else if ('list' in t) varsOf(t.list, out)
    else if ('fn' in t) varsOf(t.args, out)
  }
  return out
}

/** Head variables and negated-goal variables must be bound by a positive body goal; `_` in a negated goal stays anonymous. */
function unrestrictedVars(clause: ParsedClause): string[] {
  const bound = varsOf(clause.body.filter(goal => !goal.neg).flatMap(goal => goal.args))
  const needed = varsOf(clause.head.args)
  for (const goal of clause.body.filter(goal => goal.neg)) for (const v of varsOf(goal.args)) if (!v.startsWith('_')) needed.add(v)
  return [...needed].filter(v => !bound.has(v))
}

const printAtom = (name: string) => /^[a-z][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
export function printTerm(t: Term): string {
  if ('atom' in t) return printAtom(t.atom)
  if ('num' in t) return String(t.num)
  if ('var' in t) return t.var
  if ('str' in t) return `"${t.str.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  if ('list' in t) return `[${t.list.map(printTerm).join(', ')}]`
  return `${printAtom(t.fn)}(${t.args.map(printTerm).join(', ')})`
}
const printGoal = (goal: Goal) => `${goal.neg ? '\\+ ' : ''}${printAtom(goal.name)}${goal.args.length ? `(${goal.args.map(printTerm).join(', ')})` : ''}`
export const printClause = (clause: ParsedClause) =>
  `${printGoal({ neg: clause.neg, ...clause.head })}${clause.body.length ? ` :- ${clause.body.map(printGoal).join(', ')}` : ''}.`

// --- conflict ------------------------------------------------------------------

/** Unifies two argument lists, renaming the right side's variables apart. */
export function unifyTerms(left: readonly Term[], right: readonly Term[]): boolean {
  const bindings = new Map<string, Term>()
  const tag = (t: Term, side: string): Term => 'var' in t ? { var: `${side}${t.var}` }
    : 'list' in t ? { list: t.list.map(item => tag(item, side)) }
      : 'fn' in t ? { fn: t.fn, args: t.args.map(arg => tag(arg, side)) } : t
  const walk = (t: Term): Term => {
    while ('var' in t && bindings.has(t.var)) t = bindings.get(t.var)!
    return t
  }
  // `_` is a fresh variable at every occurrence and never binds.
  const anonymous = (t: Term) => 'var' in t && /^[lr]:_$/.test(t.var)
  const unify = (a: Term, b: Term): boolean => {
    a = walk(a); b = walk(b)
    if (anonymous(a) || anonymous(b)) return true
    if ('var' in a) { if (!('var' in b && b.var === a.var)) bindings.set(a.var, b); return true }
    if ('var' in b) { bindings.set(b.var, a); return true }
    if ('atom' in a) return 'atom' in b && a.atom === b.atom
    if ('num' in a) return 'num' in b && a.num === b.num
    if ('str' in a) return 'str' in b && a.str === b.str
    if ('list' in a) return 'list' in b && a.list.length === b.list.length && a.list.every((item, i) => unify(item, b.list[i]!))
    return 'fn' in b && a.fn === b.fn && a.args.length === b.args.length && a.args.every((arg, i) => unify(arg, b.args[i]!))
  }
  return left.length === right.length && left.every((t, i) => unify(tag(t, 'l:'), tag(right[i]!, 'r:')))
}

const predicateOf = (clause: ParsedClause) => `${clause.head.name}/${clause.head.args.length}`
const defaultKey = (arity: number) => arity >= 2 ? arity - 1 : arity

function conflicts(a: ParsedClause & { source: string }, b: ParsedClause & { source: string }, key: number): boolean {
  return predicateOf(a) === predicateOf(b) && a.source !== b.source
    && unifyTerms(a.head.args.slice(0, key), b.head.args.slice(0, key))
}

function capRetracted(clauses: Clause[]): Clause[] {
  const retracted = clauses.filter(clause => clause.status === 'retracted')
  if (retracted.length <= MAX_RETRACTED) return clauses
  const drop = new Set(retracted.slice(0, retracted.length - MAX_RETRACTED))
  return clauses.filter(clause => !drop.has(clause))
}

/**
 * Lands a prompt's clauses. The higher promptSeq wins a conflict, so a clause
 * from an older prompt applied late lands already retracted; equal promptSeq
 * lets the later clause win. An identical live clause is refreshed in place.
 */
export function applyClauses(
  store: ClauseStore, incoming: readonly IncomingClause[], promptSeq: number, now: string,
): { next: ClauseStore; added: Clause[]; retracted: Clause[] } {
  const predicates = { ...store.predicates }
  let clauses = store.clauses.map(clause => ({ ...clause }))
  let nextId = store.nextId
  const added: Clause[] = []
  const retracted: Clause[] = []
  for (const item of incoming) {
    const parsed = { head: item.head, neg: item.neg, body: item.body }
    const source = printClause(parsed)
    const name = predicateOf(parsed)
    const arity = parsed.head.args.length
    const registered = predicates[name]
    const key = registered?.key ?? (item.key !== undefined && Number.isInteger(item.key) && item.key >= 0 && item.key <= arity ? item.key : defaultKey(arity))
    if (!registered) predicates[name] = { key, example: source }
    const same = clauses.find(clause => clause.status === 'live' && clause.source === source)
    if (same) {
      if (promptSeq >= same.promptSeq) Object.assign(same, { text: item.text, quote: item.quote, address: item.address, promptSeq, issue: item.issue, at: now })
      continue
    }
    const clause: Clause = {
      id: `C${nextId++}`, ...parsed, source, text: item.text, quote: item.quote, address: item.address, promptSeq, issue: item.issue, at: now, status: 'live',
    }
    const rivals = clauses.filter(other => other.status === 'live' && conflicts(clause, other, key))
    const newer = rivals.filter(other => other.promptSeq > promptSeq).sort((a, b) => b.promptSeq - a.promptSeq)[0]
    if (newer) {
      clause.status = 'retracted'
      clause.retraction = { at: now, by: newer.id, bySource: newer.source, reason: 'conflict' }
      retracted.push(clause)
    } else {
      for (const rival of rivals) {
        rival.status = 'retracted'
        rival.retraction = { at: now, by: clause.id, bySource: source, reason: 'conflict' }
        retracted.push(rival)
      }
    }
    clauses.push(clause)
    added.push(clause)
  }
  clauses = capRetracted(clauses)
  return { next: { ...store, nextId, predicates, clauses }, added, retracted }
}

/** Retracts live clauses the user withdrew by name; each request needs a quote `supported` by the prompt. */
export function applyRetract(
  store: ClauseStore, requests: readonly { id: string; quote: string }[], supported: (quote: string) => boolean, address: string, now: string,
): { next: ClauseStore; retracted: Clause[] } {
  const retracted: Clause[] = []
  const clauses = store.clauses.map(clause => {
    const request = requests.find(item => item.id === clause.id)
    if (!request || clause.status !== 'live' || !supported(request.quote)) return clause
    const next: Clause = { ...clause, status: 'retracted', retraction: { at: now, by: address, bySource: request.quote, reason: 'explicit' } }
    retracted.push(next)
    return next
  })
  return { next: { ...store, clauses: capRetracted(clauses) }, retracted }
}

/**
 * Removes the clauses of rewound prompts and revives what they retracted,
 * unless another live clause still outranks the revived one.
 */
export function dropClauses(store: ClauseStore, addresses: ReadonlySet<string>, now: string): { next: ClauseStore; dropped: Clause[]; revived: Clause[] } {
  const dropped = store.clauses.filter(clause => addresses.has(clause.address))
  const removed = new Set([...dropped.map(clause => clause.id), ...addresses])
  const clauses = store.clauses.filter(clause => !addresses.has(clause.address)).map(clause => ({ ...clause }))
  const revived: Clause[] = []
  for (const clause of clauses.toSorted((a, b) => b.promptSeq - a.promptSeq)) {
    if (clause.status !== 'retracted' || !clause.retraction || !removed.has(clause.retraction.by)) continue
    const key = store.predicates[predicateOf(clause)]?.key ?? defaultKey(clause.head.args.length)
    const outranked = clauses.find(other => other.status === 'live' && other.promptSeq >= clause.promptSeq && conflicts(clause, other, key))
    if (outranked) {
      clause.retraction = { at: now, by: outranked.id, bySource: outranked.source, reason: 'conflict' }
      continue
    }
    clause.status = 'live'
    delete clause.retraction
    revived.push(clause)
  }
  return { next: { ...store, clauses }, dropped, revived }
}

// --- store and views -------------------------------------------------------------

function isTerm(value: unknown): value is Term {
  if (!isRecord(value)) return false
  if (typeof value.atom === 'string' || typeof value.num === 'number' || typeof value.var === 'string' || typeof value.str === 'string') return true
  if (Array.isArray(value.list)) return value.list.every(isTerm)
  return typeof value.fn === 'string' && Array.isArray(value.args) && value.args.every(isTerm)
}
const isGoal = (value: unknown): value is Goal => isRecord(value) && typeof value.neg === 'boolean' && typeof value.name === 'string'
  && Array.isArray(value.args) && value.args.every(isTerm)
function isClause(value: unknown): value is Clause {
  return isRecord(value) && typeof value.id === 'string' && isRecord(value.head) && typeof value.head.name === 'string'
    && Array.isArray(value.head.args) && value.head.args.every(isTerm) && typeof value.neg === 'boolean'
    && Array.isArray(value.body) && value.body.every(isGoal) && typeof value.source === 'string' && typeof value.text === 'string' && typeof value.quote === 'string'
    && typeof value.address === 'string' && typeof value.promptSeq === 'number' && (typeof value.issue === 'string' || value.issue === null)
    && typeof value.at === 'string' && (value.status === 'live' || value.status === 'retracted')
}

/** The stored clause store, or undefined when the session has none yet. */
export function readClauseStore(value: unknown): ClauseStore | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  const clauses = Array.isArray(value.clauses) ? value.clauses.filter(isClause) : []
  const predicates = isRecord(value.predicates)
    ? Object.fromEntries(Object.entries(value.predicates).filter(([, p]) => isRecord(p) && typeof p.key === 'number' && typeof p.example === 'string')) as ClauseStore['predicates']
    : {}
  const highest = clauses.reduce((max, clause) => Math.max(max, Number(/^C(\d+)$/.exec(clause.id)?.[1] ?? 0)), 0)
  const nextId = typeof value.nextId === 'number' && value.nextId > highest ? value.nextId : highest + 1
  return { version: 1, nextId, predicates, clauses, ...(value.migratedLegacy === true ? { migratedLegacy: true } : {}) }
}

export const isBacklogEntry = (value: unknown): value is BacklogEntry => isRecord(value)
  && typeof value.address === 'string' && typeof value.promptSeq === 'number' && typeof value.text === 'string'

/** Heads of predicates with a live clause, newest first, each with one live example. */
export function livePredicates(store: ClauseStore, cap = 40): string[] {
  const latest = new Map<string, Clause>()
  for (const clause of store.clauses) if (clause.status === 'live') latest.set(predicateOf(clause), clause)
  return [...latest].reverse().slice(0, cap)
    .map(([name, clause]) => `${name} key=${store.predicates[name]?.key ?? defaultKey(clause.head.args.length)} e.g. ${clause.source}`)
}

/** Live clauses in scope as `- text (Cn @addr)`, capped with a pointer to clm_recall. */
export function renderClauses(store: ClauseStore, inScope: (issue: string | null) => boolean, cap = 40): string[] {
  const live = store.clauses.filter(clause => clause.status === 'live' && inScope(clause.issue))
  const lines = live.slice(-cap).map(clause => `- ${clause.text} (${clause.id} ${clause.address})`)
  if (live.length > cap) lines.push(`- ${live.length - cap} more: clm_recall clauses`)
  return lines
}

/** Whether two instruction quotes substantially describe the same request. */
export function clauseQuoteOverlaps(left: string, right: string): boolean {
  const grams = (text: string) => {
    const chars = [...text.replace(/\s/gu, '').toLocaleLowerCase()]
    const counts = new Map<string, number>()
    for (let i = 0; i + 1 < chars.length; i++) {
      const first = chars[i], second = chars[i + 1]
      if (first === undefined || second === undefined) continue
      const gram = first + second
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
    }
    return counts
  }
  const leftGrams = grams(left), rightGrams = grams(right)
  if (!leftGrams.size) return right.replace(/\s/gu, '').toLocaleLowerCase().includes(left.replace(/\s/gu, '').toLocaleLowerCase())
  let matched = 0
  let total = 0
  for (const [gram, count] of leftGrams) {
    total += count
    matched += Math.min(count, rightGrams.get(gram) ?? 0)
  }
  return matched / total >= 0.5
}

export function describeClause(clause: Clause): string {
  const lines = [`${clause.id} ${clause.status} ${clause.source}  % ${clause.address} ${clause.at}`, `  text: ${clause.text}`, `  quote: ${clause.quote}`]
  const r = clause.retraction
  if (r) lines.push(`  retracted ${r.at} (${r.reason}) by ${r.by}: ${r.bySource}`)
  return lines.join('\n')
}

/** clm_recall's view: `#C12` for one clause, `clauses` for every stored clause. */
export function recallClauses(store: ClauseStore | undefined, query: string): { text?: string; error?: string } {
  const clauses = store?.clauses ?? []
  if (query.trim().toLowerCase() === 'clauses') return { text: clauses.length ? clauses.map(describeClause).join('\n') : '(no clauses)' }
  const id = /^#(C\d+)$/i.exec(query.trim())?.[1]?.toUpperCase()
  const clause = id ? clauses.find(item => item.id === id) : undefined
  return clause ? { text: describeClause(clause) } : { error: `clause ${query.trim()} was not found` }
}
