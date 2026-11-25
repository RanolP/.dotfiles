// The say tool: the agent (or a worker) writes its own wayseeker lines, checked line by line like an extraction,
// plus the Stop-hook nudge for a turn that changed files without one.
import { evaluate } from './eval'
import { L1_KINDS, L1_RULES, l1Forms, WITHDRAWAL_RULE } from './extract'
import { append, liveIds, nextId, type Ledger } from './store'
import { parseLine, printLine, printLiteral, type Utterance } from './syntax'
import { isHarnessText, stripReminders } from './text'

export const SAY_TOOL = 'say'
export const SAY_TOOL_ID = `mcp__wayseeker__${SAY_TOOL}`

export type SaySpeaker = 'agent' | 'worker'
/** The call site fixes the speaker: a subagent's call carries its agentId, the main thread's none. */
export const speakerOf = (agentId: string | undefined): SaySpeaker => agentId === undefined ? 'agent' : 'worker'

const RANK: Record<string, number> = { user: 3, agent: 2, worker: 1 }
const rankOf = (speaker: string) => RANK[speaker] ?? 0

export const SAY_DESCRIPTION = [
  'Record your own utterances in the wayseeker ledger as L1 lines: what you found, did or decided (say), what you propose (try), what you still need or aim at (want), what you ask (ask), and estimates (guess). The user\'s messages are extracted on their own; write only your side.',
  '',
  ...l1Forms('speaker is agent on the main thread and worker in a subagent; the call site fixes it, and a line naming any other speaker is rejected.'),
  '',
  ...L1_KINDS,
  '',
  'Rules:',
  ...L1_RULES,
  '- Number every line of one call with one new id, one above the highest @n in the ledger (the open list and earlier results show ids); a line numbered at or below an existing utterance is rejected with the number to use.',
  '- Offer a choice as try(p) and let the user accept it: accept(@n) of a proposal your own speaker made is rejected, and so is reject(@n) of a line from a higher-ranked speaker (user > agent > worker).',
  WITHDRAWAL_RULE,
  '- Report finished work as say(done(x)), not want.',
  '',
  'Each line is checked on its own, so a rejected line never blocks the valid ones. The result is {landed, rejected: [{line, error}], open: {want, ask}}, where open lists the wants and asks still unresolved.',
].join('\n')

export const SAY_INPUT_SCHEMA = {
  type: 'object',
  properties: { lines: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'L1 lines, one per item' } },
  required: ['lines'],
  additionalProperties: false,
}

export type SayResult = { landed: string[]; rejected: { line: string; error: string }[]; open: { want: string[]; ask: string[] } }

/**
 * What the say tool enforces beyond store.append: the speaker is the caller's; ids never fall to or below an utterance
 * that existed before the call (a shared @n would pull the user's line down to the caller's rank, since eval ranks an id
 * by its lowest speaker); no self-accept; no withdrawal of a higher-ranked line (liveIds kills any reject target).
 */
export function sayCheck(ledger: Ledger, u: Utterance, speaker: SaySpeaker, firstId: number): string[] {
  if (u.speaker !== speaker) return ['speaker ' + u.speaker + ' is not yours; this call speaks as ' + speaker]
  if (u.id < firstId) return ['@' + u.id + ' is taken; number this call\'s lines @' + firstId]
  const act = u.act
  if (act.kind !== 'accept' && act.kind !== 'reject') return []
  const targets = ledger.utterances.filter(x => x.id === act.target)
  if (act.kind === 'accept' && targets.some(x => x.speaker === speaker)) return ['@' + act.target + ' is a proposal ' + speaker + ' made; ' + speaker + ' cannot accept it']
  if (act.kind === 'reject' && targets.some(x => rankOf(x.speaker) > rankOf(speaker))) return ['@' + act.target + ' was said by a higher-ranked speaker; ' + speaker + ' cannot withdraw it']
  return []
}

/** Lands each line on its own: the say checks, then store.append, so a bad line never costs its valid siblings. */
export function sayLines(ledger: Ledger, lines: readonly unknown[], speaker: SaySpeaker): { ledger: Ledger; landed: string[]; rejected: SayResult['rejected'] } {
  const firstId = nextId(ledger)
  let current = ledger
  const landed: string[] = []
  const rejected: SayResult['rejected'] = []
  for (const raw of lines) {
    if (typeof raw !== 'string' || !raw.trim()) { rejected.push({ line: String(raw), error: 'a line must be a non-empty string' }); continue }
    const line = raw.trim()
    const parsed = parseLine(line)
    const errors = parsed.ok && parsed.entry.kind !== 'declaration' && parsed.entry.kind !== 'gloss' ? sayCheck(current, parsed.entry, speaker, firstId) : []
    const result = errors.length ? { ok: false, errors, ledger: current } : append(current, line)
    if (result.ok) { current = result.ledger; landed.push(line) } else rejected.push({ line, error: result.errors.join('; ') })
  }
  return { ledger: current, landed, rejected }
}

/** The unresolved wants (live want(p) whose p does not hold) and asks (eval's openQuestions), as ledger lines. */
export function openItems(ledger: Ledger): SayResult['open'] {
  const result = evaluate(ledger)
  const live = liveIds(ledger.utterances)
  const want = ledger.utterances.filter(u => live.has(u.id) && u.act.kind === 'want' && u.act.content.kind === 'literal'
    && result.facts.get(printLiteral(u.act.content))?.value !== 'true').map(u => printLine(u))
  const ask = ledger.utterances.filter(u => result.openQuestions.includes(u.id) && u.act.kind === 'ask').map(u => printLine(u))
  return { want, ask }
}

const READERS = new Set(['ls', 'cat', 'head', 'tail', 'rg', 'grep', 'find', 'fd', 'wc', 'jq', 'bat', 'eza', 'echo', 'pwd', 'which'])
const GIT_READERS = new Set(['status', 'log', 'diff', 'show'])
// Reader options that run or delete something.
const RUNS = /^(?:-exec|-execdir|-ok|-okdir|-delete|-fprint\w*|-x|--exec|-X|--exec-batch)$/

/** Splits a command on | || && ; & and newlines outside quotes; undefined when it substitutes a command or redirects into a file. */
function segments(command: string): string[] | undefined {
  const out: string[] = []
  let current = ''
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote !== "'" && (c === '\x60' || (c === '$' && command[i + 1] === '('))) return undefined
    if (quote) { if (c === quote) quote = undefined; current += c; continue }
    if (c === '"' || c === "'") { quote = c; current += c; continue }
    if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      const redirect = /^&?>>?\s*(\S+)/.exec(command.slice(i))
      const target = redirect?.[1] ?? ''
      if (target !== '/dev/null' && !/^&\d$/.test(target)) return undefined
      current += redirect![0]
      i += redirect![0].length - 1
      continue
    }
    if (c === '|' || c === ';' || c === '&' || c === '\n') { out.push(current); current = ''; continue }
    current += c
  }
  out.push(current)
  return out.map(s => s.trim()).filter(Boolean)
}

/** Whether every pipeline segment starts with an allowlisted reader. */
export function isReadOnlyBash(command: string): boolean {
  const parts = segments(command)
  if (!parts?.length) return false
  return parts.every(part => {
    const words = part.split(/\s+/).map(w => w.replace(/^['"]|['"]$/g, ''))
    const [head] = words
    if (head === undefined) return true
    if (words.some(w => RUNS.test(w))) return false
    if (READERS.has(head)) return true
    if (head === 'git') {
      let i = 1
      while (words[i]?.startsWith('-')) i += words[i] === '-C' || words[i] === '-c' ? 2 : 1
      return GIT_READERS.has(words[i] ?? '')
    }
    return head === 'claude' && words[1] === 'plugin' && words[2] === 'test'
  })
}

type Row = { role: string; text: string; toolUses: readonly { tool: string; input: Record<string, unknown> }[]; toolResults?: readonly unknown[] }
const isHumanRow = (row: Row) => row.role === 'user' && !row.toolResults?.length && (text => text !== '' && !isHarnessText(text))(stripReminders(row.text))
const MUTATORS = new Set(['Edit', 'Write', 'NotebookEdit'])

/** Whether the turn since the last human message changed something and never called say. */
export function needsSayNudge(rows: readonly Row[]): boolean {
  let start = rows.length
  while (start > 0 && !isHumanRow(rows[start - 1]!)) start--
  const uses = rows.slice(start).flatMap(row => row.role === 'assistant' ? row.toolUses : [])
  if (uses.some(use => use.tool === SAY_TOOL_ID)) return false
  return uses.some(use => MUTATORS.has(use.tool) || (use.tool === 'Bash' && !isReadOnlyBash(typeof use.input.command === 'string' ? use.input.command : '')))
}

export const SAY_NUDGE = `This turn changed files or ran a mutating command and recorded nothing in wayseeker. Call ${SAY_TOOL_ID} once with what you did and decided (say(done(x)), try(p) for a choice the user should make, want(p) for what is still open), then stop.`
