// wayseeker L1/L2 syntax: one ledger line in, one AST entry out. See the design page, sections L1, L2, L6.
export type Atom = { kind: 'atom'; name: string }
export type Variable = { kind: 'variable'; name: string }
// A fact argument is a proposition with its own arguments, e.g. want(review(replace(wayseeker, clm_ledger))).
export type Argument = Atom | Variable | Fact

export type Fact = { kind: 'fact'; name: string; args: Argument[] }
export type Literal = { kind: 'literal'; negated: boolean; fact: Fact }
export type Marker = { kind: 'report' | 'proceed' }
export type Reference = { kind: 'reference'; id: number }
export type Conclusion = Literal | Marker | Reference
export type Premise = Literal | { kind: 'try'; fact: Fact }
export type Condition = { kind: 'condition'; premises: Premise[]; conclusion: Conclusion }

export type ContentKind = 'say' | 'ask' | 'try' | 'want' | 'guess'
export type UtteranceKind = ContentKind | 'accept' | 'reject' | 'cond'
export type ContentAct =
  | { kind: ContentKind; content: Literal | Condition }
  | { kind: 'accept' | 'reject'; target: number }
  | Condition

// kind/content/source are the shared contract; act is the same AST in discriminated form.
export type Utterance = { id: number; speaker: string; kind: UtteranceKind; content: Literal | Condition | Reference; source: string; act: ContentAct }
export type Decl = { kind: 'declaration'; name: string; columns: string[]; key: string[]; gloss: string }
export type Declaration = Decl
export type Gloss = { kind: 'gloss'; atom: string; gloss: string }
export type Line = Utterance | Decl | Gloss

type Punct = '(' | ')' | ',' | ':' | ':=' | '->'
type Token =
  | { kind: 'identifier' | 'variable' | 'string'; text: string }
  | { kind: 'reference'; id: number }
  | { kind: 'punctuation'; text: Punct }

const CONTENT_KINDS = new Set<string>(['say', 'ask', 'try', 'want', 'guess'])
const KINDS = new Set<string>([...CONTENT_KINDS, 'accept', 'reject'])
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.]*/

const tokenize = (source: string): Token[] => {
  const tokens: Token[] = []
  let offset = 0
  while (offset < source.length) {
    const rest = source.slice(offset)
    const space = /^\s+/.exec(rest)
    if (space) { offset += space[0].length; continue }
    const op = /^(?::=|->|[(),:])/.exec(rest)
    if (op) { tokens.push({ kind: 'punctuation', text: op[0] as Punct }); offset += op[0].length; continue }
    const ref = /^@(\d+)/.exec(rest)
    if (ref) { tokens.push({ kind: 'reference', id: Number(ref[1]) }); offset += ref[0].length; continue }
    if (rest.startsWith('?')) {
      const variable = /^\?([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
      if (!variable) throw new Error('a variable needs a name after ? (bare ? is not allowed)')
      tokens.push({ kind: 'variable', text: variable[1]! })
      offset += variable[0].length
      continue
    }
    if (rest.startsWith('"')) {
      let text = ''
      let index = 1
      let closed = false
      for (; index < rest.length; index++) {
        const char = rest[index]!
        if (char === '\\') { const next = rest[index + 1]; if (next === undefined) break; text += next; index++; continue }
        if (char === '"') { closed = true; index++; break }
        text += char
      }
      if (!closed) throw new Error('unterminated string')
      tokens.push({ kind: 'string', text })
      offset += index
      continue
    }
    const name = NAME.exec(rest)
    if (name) { tokens.push({ kind: 'identifier', text: name[0] }); offset += name[0].length; continue }
    throw new Error('unexpected ' + JSON.stringify(rest[0]) + ': arguments are atoms, never sentences')
  }
  return tokens
}

type Hoisted = { kind: 'hoisted'; inner: ContentKind; literal: Literal }

class Parser {
  private offset = 0
  constructor(private readonly tokens: Token[]) {}

  done(): boolean { return this.offset === this.tokens.length }
  peek(): Token | undefined { return this.tokens[this.offset] }
  take(): Token {
    const token = this.tokens[this.offset]
    if (!token) throw new Error('unexpected end of line')
    this.offset++
    return token
  }
  is(text: Punct): boolean { const t = this.peek(); return t?.kind === 'punctuation' && t.text === text }
  expect(text: Punct): void { if (!this.is(text)) throw new Error('expected ' + text); this.offset++ }
  identifier(): string {
    const token = this.take()
    if (token.kind !== 'identifier') throw new Error('expected a name')
    return token.text
  }
  peekName(): string | undefined { const t = this.peek(); return t?.kind === 'identifier' ? t.text : undefined }
  reference(): number {
    const token = this.take()
    if (token.kind !== 'reference') throw new Error('expected an utterance reference @n')
    return token.id
  }
  names(): string[] {
    this.expect('(')
    const out: string[] = []
    if (!this.is(')')) { out.push(this.identifier()); while (this.is(',')) { this.take(); out.push(this.identifier()) } }
    this.expect(')')
    return out
  }

  argument(): Argument {
    const token = this.take()
    if (token.kind === 'variable') return { kind: 'variable', name: token.text }
    if (token.kind === 'identifier') {
      if (this.is('(')) { this.offset--; return this.fact() }
      return { kind: 'atom', name: token.text }
    }
    throw new Error('fact arguments must be atoms or named variables, not strings or sentences')
  }

  fact(): Fact {
    const name = this.identifier()
    if (name === 'retract') throw new Error('retract is reserved; cancel with reject(@n)')
    if (KINDS.has(name)) throw new Error('kind ' + name + ' cannot appear inside content')
    if (name === 'not' || name === 'report' || name === 'proceed') throw new Error(name + ' is not a predicate name')
    if (!this.is('(')) return { kind: 'fact', name, args: [] }
    this.expect('(')
    const args: Argument[] = []
    if (!this.is(')')) { args.push(this.argument()); while (this.is(',')) { this.take(); args.push(this.argument()) } }
    this.expect(')')
    return { kind: 'fact', name, args }
  }

  literal(): Literal {
    if (this.peekName() === 'not') {
      this.take()
      this.expect('(')
      const fact = this.fact()
      this.expect(')')
      return { kind: 'literal', negated: true, fact }
    }
    return { kind: 'literal', negated: false, fact: this.fact() }
  }

  conclusion(): Conclusion | Hoisted {
    const token = this.peek()
    if (token?.kind === 'reference') return { kind: 'reference', id: this.reference() }
    const name = this.peekName()
    if (name === 'report' || name === 'proceed') { this.take(); return { kind: name } }
    // say(a -> guess(b)) and a -> guess(b): one inner kind is hoisted outward.
    if (name !== undefined && CONTENT_KINDS.has(name)) {
      this.take()
      this.expect('(')
      const literal = this.literal()
      this.expect(')')
      return { kind: 'hoisted', inner: name as ContentKind, literal }
    }
    return this.literal()
  }

  condition(first: Premise): Condition | { kind: 'hoisted-condition'; inner: ContentKind; condition: Condition } {
    const premises: Premise[] = [first]
    while (this.is(',')) { this.take(); premises.push(this.literal()) }
    this.expect('->')
    const conclusion = this.conclusion()
    if (conclusion.kind === 'hoisted') return { kind: 'hoisted-condition', inner: conclusion.inner, condition: { kind: 'condition', premises, conclusion: conclusion.literal } }
    return { kind: 'condition', premises, conclusion }
  }

  body(): ContentAct {
    const name = this.peekName()
    if (name !== undefined && KINDS.has(name) && this.tokens[this.offset + 1]?.kind === 'punctuation') {
      this.take()
      this.expect('(')
      if (name === 'accept' || name === 'reject') {
        const target = this.reference()
        this.expect(')')
        return { kind: name, target }
      }
      const kind = name as ContentKind
      const first = this.literal()
      if (!this.is(',') && !this.is('->')) {
        this.expect(')')
        if (kind === 'try' && this.is('->')) {
          const condition = this.condition({ kind: 'try', fact: first.fact })
          if (condition.kind !== 'condition' || first.negated) throw new Error('try(p) -> takes a positive p and report or proceed')
          return condition
        }
        return { kind, content: first }
      }
      const condition = this.condition(first)
      this.expect(')')
      if (condition.kind === 'hoisted-condition') {
        if (kind !== 'say') throw new Error('a kind nested inside ' + kind + '(...) is not allowed')
        return condition.inner === 'say' ? condition.condition : { kind: condition.inner, content: condition.condition }
      }
      // say(p -> q) is the plain conditional.
      return kind === 'say' ? condition : { kind, content: condition }
    }
    const first = this.literal()
    if (!this.is(',') && !this.is('->')) throw new Error('a bare fact is not an utterance; wrap it in a kind such as say(...)')
    const condition = this.condition(first)
    if (condition.kind === 'hoisted-condition') return condition.inner === 'say' ? condition.condition : { kind: condition.inner, content: condition.condition }
    return condition
  }
}

const variablesOf = (fact: Fact): string[] => fact.args.flatMap(a => a.kind === 'variable' ? [a.name] : a.kind === 'fact' ? variablesOf(a) : [])

const checkAct = (act: ContentAct): void => {
  if (act.kind === 'accept' || act.kind === 'reject') return
  const condition = act.kind === 'condition' ? act : act.content.kind === 'condition' ? act.content : undefined
  if (!condition) {
    if (act.kind !== 'condition' && act.kind !== 'ask' && act.content.kind === 'literal' && variablesOf(act.content.fact).length > 0) throw new Error('only ask(...) and conditionals may hold variables')
    return
  }
  const tries = condition.premises.filter(p => p.kind === 'try')
  const marker = condition.conclusion.kind === 'report' || condition.conclusion.kind === 'proceed'
  if (tries.length > 0 && (condition.premises.length !== 1 || !marker)) throw new Error('try(p) may only appear as try(p) -> report|proceed')
  if (condition.conclusion.kind === 'literal') {
    // Datalog safety: every head variable is bound by a premise.
    const bound = new Set(condition.premises.flatMap(p => variablesOf(p.fact)))
    const free = variablesOf(condition.conclusion.fact).filter(v => !bound.has(v))
    if (free.length > 0) throw new Error('head variable ?' + free[0] + ' does not appear in any premise')
  }
}

const termSize = (argument: Argument): number => argument.kind === 'fact' ? 1 + argument.args.reduce((sum, a) => sum + termSize(a), 0) : 1
const argVariables = (argument: Argument): string[] => argument.kind === 'variable' ? [argument.name] : argument.kind === 'fact' ? variablesOf(argument) : []
const count = (names: string[]) => names.reduce((m, n) => m.set(n, (m.get(n) ?? 0) + 1), new Map<string, number>())

/** Whether every instance of head is no larger than the same instance of premise: size(head) <= size(premise) and no variable occurs more often in head. */
const noLarger = (head: Argument, premise: Argument): boolean => {
  const have = count(argVariables(premise))
  return termSize(head) <= termSize(premise) && [...count(argVariables(head))].every(([name, n]) => (have.get(name) ?? 0) >= n)
}

/**
 * Whether a rule's conclusion can build a term larger than its premises hold: some conclusion argument with a variable
 * is not bounded in size by a single premise argument. Copying (a(?x) -> b(?x)) and destructuring
 * (a(f(g(?x))) -> b(f(?x))) keep every derived term within the size of terms already stated, so the term set stays
 * finite; a term-building rule is safe only off a dependency cycle, which store.ts checks across the whole rule set.
 */
export const buildsTerms = (condition: Condition): boolean => {
  if (condition.conclusion.kind !== 'literal') return false
  const premiseArgs = condition.premises.flatMap(p => p.fact.args)
  return condition.conclusion.fact.args.some(a => argVariables(a).length > 0 && !premiseArgs.some(p => noLarger(a, p)))
}

const contentOf = (act: ContentAct): Utterance['content'] => act.kind === 'accept' || act.kind === 'reject' ? { kind: 'reference', id: act.target } : act.kind === 'condition' ? act : act.content
const kindOf = (act: ContentAct): UtteranceKind => act.kind === 'condition' ? 'cond' : act.kind

export const makeUtterance = (id: number, speaker: string, act: ContentAct, source: string): Utterance =>
  ({ id, speaker, kind: kindOf(act), content: contentOf(act), source, act })

const parseOrThrow = (source: string): Line => {
  const parser = new Parser(tokenize(source))
  const first = parser.peek()
  const finish = () => { if (!parser.done()) throw new Error('unexpected text after the line') }
  if (first?.kind === 'reference') {
    const id = parser.reference()
    const speaker = parser.identifier()
    parser.expect(':')
    const act = parser.body()
    finish()
    checkAct(act)
    return makeUtterance(id, speaker, act, source.trim())
  }
  if (first?.kind === 'identifier' && first.text === 'decl') {
    parser.take()
    const name = parser.identifier()
    if (name === 'retract' || name === 'not' || KINDS.has(name)) throw new Error(name + ' is reserved')
    const columns = parser.names()
    if (parser.identifier() !== 'key') throw new Error('expected key(...)')
    const key = parser.names()
    const gloss = parser.take()
    if (gloss.kind !== 'string') throw new Error('expected a quoted gloss')
    finish()
    if (new Set(columns).size !== columns.length) throw new Error('declaration columns must be unique')
    if (key.some(column => !columns.includes(column))) throw new Error('key columns must be declared columns')
    return { kind: 'declaration', name, columns, key, gloss: gloss.text }
  }
  const atom = parser.identifier()
  parser.expect(':=')
  const gloss = parser.take()
  if (gloss.kind !== 'string') throw new Error('expected a quoted gloss')
  finish()
  return { kind: 'gloss', atom, gloss: gloss.text }
}

export function parseLine(line: string): { ok: true; entry: Line } | { ok: false; error: string } {
  try { return { ok: true, entry: parseOrThrow(line) } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
}

/** Parses one fact such as "use(lang, python)"; throws on anything else. */
export const parseFact = (source: string): Fact => {
  const parser = new Parser(tokenize(source))
  const fact = parser.fact()
  if (!parser.done()) throw new Error('unexpected text after the fact')
  return fact
}

/** Parses "p" or "not(p)". */
export const parseLiteral = (source: string): Literal => {
  const parser = new Parser(tokenize(source))
  const literal = parser.literal()
  if (!parser.done()) throw new Error('unexpected text after the literal')
  return literal
}

export const printArgument = (argument: Argument): string => argument.kind === 'atom' ? argument.name : argument.kind === 'variable' ? '?' + argument.name : printFact(argument)
export const printFact = (fact: Fact): string => fact.args.length === 0 ? fact.name : fact.name + '(' + fact.args.map(printArgument).join(', ') + ')'
export const printLiteral = (literal: Literal): string => literal.negated ? 'not(' + printFact(literal.fact) + ')' : printFact(literal.fact)
const printPremise = (premise: Premise): string => premise.kind === 'try' ? 'try(' + printFact(premise.fact) + ')' : printLiteral(premise)
const printConclusion = (conclusion: Conclusion): string =>
  conclusion.kind === 'literal' ? printLiteral(conclusion) : conclusion.kind === 'reference' ? '@' + conclusion.id : conclusion.kind
export const printCondition = (condition: Condition): string => condition.premises.map(printPremise).join(', ') + ' -> ' + printConclusion(condition.conclusion)

export function printUtterance(u: Utterance): string {
  const act = u.act
  const body = act.kind === 'condition' ? printCondition(act)
    : act.kind === 'accept' || act.kind === 'reject' ? act.kind + '(@' + act.target + ')'
    : act.kind + '(' + (act.content.kind === 'condition' ? printCondition(act.content) : printLiteral(act.content)) + ')'
  return '@' + u.id + ' ' + u.speaker + ': ' + body
}

export const printLine = (line: Line): string => {
  if (line.kind === 'declaration') return 'decl ' + line.name + '(' + line.columns.join(', ') + ') key(' + line.key.join(', ') + ') ' + JSON.stringify(line.gloss)
  if (line.kind === 'gloss') return line.atom + ' := ' + JSON.stringify(line.gloss)
  return printUtterance(line)
}

export const isGroundFact = (fact: Fact): boolean => fact.args.every(argument => argument.kind === 'atom' || (argument.kind === 'fact' && isGroundFact(argument)))
export const factKey = (fact: Fact): string => printFact(fact)
