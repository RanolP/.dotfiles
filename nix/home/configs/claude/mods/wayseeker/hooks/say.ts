// The say tool: the agent (or a worker) writes its own wayseeker lines, checked line by line like an extraction,
// plus the Stop-hook nudge for a turn that changed files without one.
import { evaluate } from './eval'
import { L1_KINDS, L1_RULES, l1Forms, WITHDRAWAL_RULE } from './extract'
import { append, liveIds, nextId, type Ledger } from './store'
import { parseLine, printLine, printLiteral, type Literal, type Utterance } from './syntax'
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
  '- The tool assigns ids and the speaker: write each line bare, as kind(content) or a condition, with no "@n speaker:" prefix; every line of one call shares the call\'s id (the next field of the latest say result). A prefixed line whose @n is at or below an existing utterance is renumbered to the call\'s id, and the renumbering is reported in landed. Call with lines: [] to read next and the open list without writing anything.',
  '- Offer a choice as try(p) and let the user accept it: accept(@n) of a proposal your own speaker made is rejected, and so is reject(@n) of a line from a higher-ranked speaker (user > agent > worker).',
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
    let line = raw.trim()
    let note = ''
    // The tool owns numbering: a bare line gets the call's id and speaker, a stale @n the call's id.
    const bare = parseLine(line)
    if (!(bare.ok && (bare.entry.kind === 'declaration' || bare.entry.kind === 'gloss'))) {
      const prefix = /^@(\d+)\s+(\w+):\s*/.exec(line)
      if (!prefix) line = '@' + firstId + ' ' + speaker + ': ' + line
      else if (Number(prefix[1]) < firstId) { note = '  (renumbered from @' + prefix[1] + ')'; line = '@' + firstId + line.slice(prefix[0].indexOf(' ')) }
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

const READERS = new Set(['ls', 'cat', 'head', 'tail', 'rg', 'grep', 'find', 'fd', 'wc', 'jq', 'bat', 'eza', 'echo', 'pwd', 'which', 'tput', 'readlink', 'realpath', 'tr', 'sort', 'uniq', 'cut', 'basename', 'dirname', 'stat', 'date', 'true'])
const GIT_READERS = new Set(['status', 'log', 'diff', 'show'])
// Reader options that run or delete something.
const RUNS = /^(?:-exec|-execdir|-ok|-okdir|-delete|-fprint\w*|-x|--exec|-X|--exec-batch)$/

/** Splits a command on | || && ; & and newlines outside quotes, adding each $(...) body as segments of its own; undefined when it uses backticks or redirects into a file. */
function segments(command: string): string[] | undefined {
  const out: string[] = []
  let current = ''
  let quote: string | undefined
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote !== "'" && c === '\x60') return undefined
    if (quote !== "'" && c === '$' && command[i + 1] === '(') {
      let depth = 0
      let end = i + 1
      for (; end < command.length; end++) {
        if (command[end] === '(') depth++
        else if (command[end] === ')' && --depth === 0) break
      }
      const inner = segments(command.slice(i + 2, end))
      if (!inner) return undefined
      out.push(...inner)
      current += 'SUB'
      i = end
      continue
    }
    if (quote) { if (c === quote) quote = undefined; current += c; continue }
    if (c === '"' || c === "'") { quote = c; current += c; continue }
    if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      const redirect = /^&?>>?\s*(&\d|[^\s;|&)]+)/.exec(command.slice(i))
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
  // A leading `cd <dir> &&` only moves where the readers after it look.
  const parts = segments(command.replace(/^\s*cd\s+\S+\s*&&/, ''))
  if (!parts?.length) return false
  return parts.every(part => {
    const words = part.split(/\s+/).map(w => w.replace(/^['"]|['"]$/g, ''))
    // Leading NAME=value words only set a variable for what follows.
    while (words.length && /^\w+=/.test(words[0]!)) words.shift()
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
// The REPL tool's file and tool globals that change something.
const REPL_WRITES = /(?<![\w$.])(?:edit|write)\s*\(|\btools\.(?:Edit|Write|Bash|NotebookEdit)\b/

/**
 * The shell commands a REPL script runs: each $\`...\` template's text with every \${...} replaced by a placeholder word
 * (so an interpolated argument keeps its literal head, an interpolated head reads as unknown), and each $(...) call's
 * string-literal first argument; a $(...) with a computed argument yields undefined, which counts as not read-only.
 */
export function replShellCommands(code: string): (string | undefined)[] {
  const commands: (string | undefined)[] = []
  let rest = ''
  for (let i = 0; i < code.length; i++) {
    const starts = code[i] === '$' && code[i + 1] === '\x60' && !/[\w$]/.test(code[i - 1] ?? '')
    if (!starts) { rest += code[i]; continue }
    let text = ''
    for (i += 2; i < code.length && code[i] !== '\x60'; i++) {
      if (code[i] === '\\') { text += code[i + 1] ?? ''; i++; continue }
      if (code[i] === '$' && code[i + 1] === '{') {
        let depth = 0
        for (; i < code.length; i++) {
          if (code[i] === '{') depth++
          else if (code[i] === '}' && --depth === 0) break
        }
        text += 'ARG'
        continue
      }
      text += code[i]
    }
    commands.push(text)
    rest += ' '
  }
  for (const m of rest.matchAll(/(?<![\w$.])\$\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([^)]*))/g)) commands.push(m[3] === undefined ? (m[1] ?? m[2]) : undefined)
  return commands
}

/** Whether a REPL script edits, writes, calls a mutating tool, or runs a shell command outside the read-only allowlist. */
export function replDoesWork(code: string): boolean {
  return REPL_WRITES.test(code) || replShellCommands(code).some(command => command === undefined || !isReadOnlyBash(command))
}

/** Whether the turn since the last human message changed something and never called say. */
export function needsSayNudge(rows: readonly Row[]): boolean {
  let start = rows.length
  while (start > 0 && !isHumanRow(rows[start - 1]!)) start--
  const uses = rows.slice(start).flatMap(row => row.role === 'assistant' ? row.toolUses : [])
  const text = (value: unknown) => typeof value === 'string' ? value : ''
  // A REPL script reaches say as tools.mcp__wayseeker__say, so its code naming the tool counts as the call.
  if (uses.some(use => use.tool === SAY_TOOL_ID || (use.tool === 'REPL' && text(use.input.code).includes(SAY_TOOL_ID)))) return false
  return uses.some(use => MUTATORS.has(use.tool)
    || (use.tool === 'Bash' && !isReadOnlyBash(text(use.input.command)))
    || (use.tool === 'REPL' && replDoesWork(text(use.input.code))))
}

export const SAY_NUDGE = `This turn changed files or ran a mutating command and recorded nothing in wayseeker. Call ${SAY_TOOL_ID} once with what you did and decided (say(done(x)), try(p) for a choice the user should make, want(p) for what is still open), then stop.`
