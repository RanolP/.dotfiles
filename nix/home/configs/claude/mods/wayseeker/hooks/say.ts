// The say tool: the agent (or a worker) writes its own wayseeker lines, checked line by line like an extraction.
import { evaluate } from './eval'
import { L1_KINDS, L1_RULES, l1Forms, WITHDRAWAL_RULE } from './extract'
import { rubricClaimError } from './stepped'
import { append, liveIds, nextId, type Ledger } from './store'
import { parseLine, printLine, printLiteral, type Literal, type Utterance } from './syntax'

export const SAY_TOOL = 'say'
export const SAY_TOOL_ID = `mcp__wayseeker__${SAY_TOOL}`

export type SaySpeaker = 'agent' | 'worker'
/** The call site fixes the speaker: a subagent's call carries its agentId, the main thread's none. */
export const speakerOf = (agentId: string | undefined): SaySpeaker => agentId === undefined ? 'agent' : 'worker'

const RANK: Record<string, number> = { user: 4, check: 3, agent: 2, worker: 1 }
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
  '- The tool assigns ids and the speaker: write each line bare, as kind(content) or a condition, with no "@n speaker:" prefix; every line of one call shares the call\'s id (the next field of the latest say result). A prefixed line whose @n is at or below an existing utterance is renumbered to the call\'s id, and the renumbering is reported in landed. Call with lines: [] to read next and the open list without writing anything.',
  '- Offer a choice as try(p) and let the user accept it: accept(@n) of a proposal your own speaker made is rejected, and so is reject(@n) of a line from a higher-ranked speaker (user > check > agent > worker; check is the rubric verdict the step and check tools write).',
  '- A step recorded with the step tool is done when check says so: call the check tool for it, and write done(goal) rules over its done(step) as usual.',
  WITHDRAWAL_RULE,
  '- Report finished work as say(done(x)), not want.',
  '',
  'Each line is checked on its own, so a rejected line never blocks the valid ones. The result is {landed, rejected: [{line, error}], open: {want, ask}, next}, where open lists the wants and asks still unresolved and next is the id your next lines take.',
].join('\n')

export const SAY_INPUT_SCHEMA = {
  type: 'object',
  properties: { lines: { type: 'array', items: { type: 'string' }, description: 'L1 lines, one per item; [] only reads next and the open list' } },
  required: ['lines'],
  additionalProperties: false,
}

export type SayResult = { landed: string[]; rejected: { line: string; error: string }[]; open: { want: string[]; ask: string[] }; next: number }

/**
 * What the say tool enforces beyond store.append: the speaker is the caller's; ids never fall to or below an utterance
 * that existed before the call (a shared @n would pull the user's line down to the caller's rank, since eval ranks an id
 * by its lowest speaker); no self-accept; no withdrawal of a higher-ranked line (liveIds kills any reject target); no
 * done or pass of a step that has a rubric, which only check asserts.
 */
export function sayCheck(ledger: Ledger, u: Utterance, speaker: SaySpeaker, firstId: number): string[] {
  if (u.speaker !== speaker) return ['speaker ' + u.speaker + ' is not yours; this call speaks as ' + speaker]
  if (u.id < firstId) return ['@' + u.id + ' is taken; number this call\'s lines @' + firstId]
  const claim = rubricClaimError(ledger, u)
  if (claim) return [claim]
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
    let line = raw.trim()
    let note = ''
    // The tool owns numbering: a bare line gets the call's id and speaker, a stale @n the call's id.
    const bare = parseLine(line)
    if (!(bare.ok && (bare.entry.kind === 'declaration' || bare.entry.kind === 'gloss'))) {
      const prefix = /^@(\d+)\s+(\w+):\s*/.exec(line)
      if (!prefix) line = '@' + firstId + ' ' + speaker + ': ' + line
      else if (Number(prefix[1]) < firstId) { note = '  (renumbered from @' + prefix[1] + ')'; line = '@' + firstId + ' ' + prefix[2] + ': ' + line.slice(prefix[0].length) }
    }
    const parsed = parseLine(line)
    const errors = parsed.ok && parsed.entry.kind !== 'declaration' && parsed.entry.kind !== 'gloss' ? sayCheck(current, parsed.entry, speaker, firstId) : []
    const result = errors.length ? { ok: false, errors, ledger: current } : append(current, line)
    if (result.ok) { current = result.ledger; landed.push(line + note) }
    else rejected.push({ line, error: result.errors.map(e => e.includes('arguments are atoms') ? 'an argument must be an atom: write an atom and add a gloss line, name := "<text>"' : e).join('; ') })
  }
  return { ledger: current, landed, rejected }
}

/** The unresolved wants (live want(p) whose p does not hold) and asks (eval's openQuestions), as ledger lines. */
export function openItems(ledger: Ledger): SayResult['open'] {
  const result = evaluate(ledger)
  const live = liveIds(ledger.utterances)
  const holds = (literal: Literal) => result.facts.get(printLiteral(literal))?.value === 'true'
  const done = (literal: Literal): Literal => ({ ...literal, fact: { kind: 'fact', name: 'done', args: [literal.fact] } })
  const want = ledger.utterances.filter(u => live.has(u.id) && u.act.kind === 'want' && u.act.content.kind === 'literal'
    && !holds(u.act.content) && !holds(done(u.act.content))).map(u => printLine(u))
  const ask = ledger.utterances.filter(u => result.openQuestions.includes(u.id) && u.act.kind === 'ask').map(u => printLine(u))
  return { want, ask }
}
