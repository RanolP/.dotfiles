import type { EngineInterface, PromptOrigin, Register, SessionMessage } from 'claude-code'
import { evaluate } from './eval'
import { extractTurn } from './extract'
import { countUserRows, dropWayseekerTurns, landWayseekerTurn, readWayseekerLedger, readWayseekerTurns, renderInstructions, turnIsLive, wayseekerKey, type QuoteOf } from './render'
import { promptFingerprint, promptsKey, readPromptRows, reconcilePrompts } from './rewind'
import { openItems, SAY_DESCRIPTION, SAY_INPUT_SCHEMA, SAY_TOOL, SAY_TOOL_ID, sayLines, speakerOf, type SayResult } from './say'
import { renderRange } from './evidence'
import { debateRubric, judgeRubric, readSteps, rubricText, STEP_ATOM, writeStepRule, writeVerdicts, type ModelIo } from './stepped'
import { compactedSinceDeliveryKey, nextId, type Ledger } from './store'
import { isHarnessText, isRecord, stripReminders } from './text'
import type { WayseekerInstructionsInput } from '../types'

const isHumanOrigin = (origin: PromptOrigin) => origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
const transcriptKey = (session: string, agentId?: string) => `${session}:${agentId ?? 'main'}`
const nextAddressKey = (key: string) => `next-address:${key}`

// One JSON file per session under ~/.claude-work/plans, so the ledger never grows the plugin-wide 4 MiB store.
async function statePath($: EngineInterface, session: string): Promise<string> {
  return `${(await $.env.get('HOME')) ?? '.'}/.claude-work/plans/wayseeker-${session}.json`
}
async function readState($: EngineInterface, session: string): Promise<Record<string, unknown>> {
  const path = await statePath($, session)
  if (!(await $.fs.exists(path))) return {}
  try {
    const value: unknown = JSON.parse(await $.fs.read(path))
    return isRecord(value) ? value : {}
  } catch (err) {
    $.ui.log(`wayseeker: unreadable state path=${path} error=${JSON.stringify(String(err))}`, { to: 'debug' })
    return {}
  }
}
const sessionStore = ($: EngineInterface, session: string) => ({
  get: async (key: string) => (await readState($, session))[key],
  set: async (key: string, value: unknown) => {
    const state = await readState($, session)
    state[key] = value
    await $.fs.write(await statePath($, session), JSON.stringify(state))
  },
})

// Every read-modify-write of one session's file runs in turn, so a landing extraction and a rewind trim never overwrite each other.
const writes = new Map<string, Promise<void>>()
function serialized<T>(session: string, run: () => Promise<T>): Promise<T> {
  const result = (writes.get(session) ?? Promise.resolve()).then(run, run)
  const tail = result.then(() => undefined, () => undefined)
  writes.set(session, tail)
  void tail.then(() => { if (writes.get(session) === tail) writes.delete(session) })
  return result
}

const promptTexts = (rows: readonly SessionMessage[]) => rows
  .filter(row => row.role === 'user').map(row => stripReminders(row.text))
  .filter(text => text !== '' && !isHarnessText(text))

/**
 * Cuts the turns of prompts a rewind removed, then records the submitted prompt under a fresh turn
 * address. Returns that address, or undefined for a prompt that is not the user's own words.
 *
 * A prompt submitted over a running turn (`overTurn`) skips the cut: prompts queued in that turn have no
 * row yet, and one the engine folds in never gets one until session.append marks it, so the running turn
 * would read as a rewind of them. No rewind lands mid-turn; the next idle submit reconciles.
 */
async function observePrompt($: EngineInterface, session: string, rows: readonly SessionMessage[], userMessage: string | undefined, overTurn: boolean): Promise<string | undefined> {
  const key = transcriptKey(session)
  const store = sessionStore($, session)
  const stored = readPromptRows(await store.get(promptsKey(key)))
  const { rows: prompts, rewound } = overTurn ? { rows: stored, rewound: [] } : reconcilePrompts(stored, promptTexts(rows).map(promptFingerprint))
  if (rewound.length) {
    const trimmed = dropWayseekerTurns(await store.get(wayseekerKey(key)), new Set(rewound))
    if (trimmed) {
      await store.set(wayseekerKey(key), trimmed)
      $.ui.log(`wayseeker: rewind cut ${rewound.length} turn(s)`, { to: 'debug' })
    }
  }
  if (rewound.length) {
    const quotes = readQuotes(await store.get(quotesKey(key)))
    for (const address of rewound) delete quotes[address]
    await store.set(quotesKey(key), quotes)
  }
  let address: string | undefined
  if (userMessage !== undefined) {
    const seq = Number(await store.get(nextAddressKey(key)) ?? 1)
    address = `@w${seq}`
    await store.set(nextAddressKey(key), seq + 1)
    prompts.push({ fp: promptFingerprint(userMessage), address })
    await store.set(quotesKey(key), { ...readQuotes(await store.get(quotesKey(key))), [address]: stripReminders(userMessage).slice(0, 1000) })
  }
  await store.set(promptsKey(key), prompts)
  return address
}

/**
 * The user's own text for each ledger address @N: the turn whose firstId is the largest one <= N names its prompt
 * address, whose text observePrompt stored under quotesKey. The transcript is no source: a compaction, the one case
 * the section is delivered in, has already replaced the old prompts there.
 */
const quotesKey = (key: string) => `quotes:${key}`
const readQuotes = (value: unknown): Record<string, string> => isRecord(value)
  ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  : {}
function promptQuotes(stored: unknown, quotes: unknown): QuoteOf {
  const byAddress = readQuotes(quotes)
  const turns = [...readWayseekerTurns(stored)].sort((a, b) => a.firstId - b.firstId)
  return id => {
    const turn = turns.findLast(t => t.firstId <= id)
    return turn && byAddress[turn.address]
  }
}

// One extraction at a time per session, so each appends onto the ledger the one before it wrote.
const chains = new Map<string, Promise<void>>()
/** Extracts this prompt's utterances into the session's wayseeker ledger. */
function recordTurn($: EngineInterface, session: string, userMessage: string, rows: readonly SessionMessage[], address: string, overTurn: boolean): Promise<void> {
  const key = transcriptKey(session)
  const prevAssistant = [...rows].reverse().find(row => row.role === 'assistant' && row.text.trim())?.text ?? ''
  // `rows` was read in prompt.submit before next(e); the engine adds the prompt's row only after the
  // prompt.submit chain settles its text, so it is not in `rows` and +1 counts it.
  const seen = countUserRows(rows, userMessage) + 1
  // Over a running turn the prompt may never get a row of its own (turnIsLive): its liveness is the running turn's prompt's.
  const hostText = overTurn ? promptTexts(rows).at(-1) : undefined
  const host = hostText === undefined ? undefined : { text: hostText, seen: countUserRows(rows, hostText) }
  const store = sessionStore($, session)
  const run = async () => {
    const ledger = readWayseekerLedger(await serialized(session, () => store.get(wayseekerKey(key))))
    const result = await extractTurn({
      complete: async request => {
        const response = await $.model.complete(request)
        return response.isAnswered ? { isAnswered: true, text: response.text, reason: '' } : { isAnswered: false, text: '', reason: response.reason }
      },
    }, ledger, userMessage, prevAssistant)
    for (const { line, errors } of result.rejected) $.ui.log(`wayseeker: rejected ${JSON.stringify(line)} (${errors.join('; ').slice(0, 160)})`, { to: 'debug' })
    // The model call takes seconds; landing re-reads the store so a rewind in that window is not overwritten.
    let before = ''
    let after = ''
    const landed = await serialized(session, async () => {
      const sectionOf = (stored: unknown) => { const l = readWayseekerLedger(stored); return renderInstructions(l, evaluate(l)) }
      before = sectionOf(await store.get(wayseekerKey(key)))
      const landing = await landWayseekerTurn({
      get: store.get, set: store.set,
      isLive: async () => turnIsLive(await $.session.messages(), userMessage, seen, host),
    }, key, result.appended, address)
      after = sectionOf(await store.get(wayseekerKey(key)))
      return landing
    })
    // The attachment is a system-reminder the user cannot see, so a changed instruction list is also shown in the UI.
    for (const line of landedActs(landed.landed)) $.ui.log(line)
    for (const line of instructionChanges(before, after)) $.ui.log(line)
    if (landed.rewound) $.ui.log(`wayseeker: prompt rewound during extraction; ${result.appended.length} line(s) not written`, { to: 'debug' })
    for (const { line, errors } of landed.dropped) $.ui.log(`wayseeker: dropped on replay ${JSON.stringify(line)} (${errors.join('; ').slice(0, 160)})`, { to: 'debug' })
  }
  const job = (chains.get(session) ?? Promise.resolve()).then(run)
  const tail = job.catch(() => undefined)
  chains.set(session, tail)
  void tail.then(() => { if (chains.get(session) === tail) chains.delete(session) })
  return job
}

const instructionLines = (section: string) => (section.split('\n\n## raises')[0] ?? '').split('\n').filter(line => line.startsWith('- ') && line !== '- (none yet)').map(line => line.slice(2))
const MAX_NOTICES = 3
/** One user-visible line per utterance that landed (declarations and glosses are not utterances), at most three, then a count. */
export function landedActs(landed: readonly string[]): string[] {
  const acts = landed.flatMap(line => { const m = /^@\d+ [^:\s]+: (.+)$/s.exec(line); return m ? [m[1]!] : [] })
  return acts.length > MAX_NOTICES ? [...acts.slice(0, MAX_NOTICES), `… 외 ${acts.length - MAX_NOTICES}건`] : acts
}

/** One user-visible line per instruction that entered or left the section, at most three, then a count. */
export function instructionChanges(before: string, after: string): string[] {
  const [was, now] = [instructionLines(before), instructionLines(after)]
  const notices = [
    ...now.filter(line => !was.includes(line)).map(line => `지시 추가: ${line}`),
    ...was.filter(line => !now.includes(line)).map(line => `지시 제외: ${line}`),
  ]
  return notices.length > MAX_NOTICES ? [...notices.slice(0, MAX_NOTICES), `… 외 ${notices.length - MAX_NOTICES}건`] : notices
}

// Prompts submitted over a running turn and not yet folded into it, per session, oldest first: what session.append matches
// a `queued_command` attachment against. Module memory: a reload in that window leaves the prompt unmarked, read as before.
const awaitingFold = new Map<string, { address: string; text: string }[]>()

/** Marks the prompt a `queued_command` attachment carries as midTurn, so reconcilePrompts rides it with its host row. */
async function markFolded($: EngineInterface, session: string, attachmentText: string): Promise<void> {
  const waiting = awaitingFold.get(session) ?? []
  const index = waiting.findIndex(item => attachmentText.includes(item.text))
  if (index < 0) return
  const [{ address }] = waiting.splice(index, 1) as [{ address: string; text: string }]
  if (!waiting.length) awaitingFold.delete(session)
  const key = transcriptKey(session)
  const store = sessionStore($, session)
  await serialized(session, async () => {
    const prompts = readPromptRows(await store.get(promptsKey(key)))
    if (!prompts.some(row => row.address === address)) return
    await store.set(promptsKey(key), prompts.map(row => row.address === address ? { ...row, midTurn: true as const } : row))
  })
}

/**
 * The say tool's call: lands the caller's own lines in the session's main ledger, where its speaker (agent or worker)
 * ranks against the user's. Waits for the session's pending extraction first, so the user's lines take their @n before
 * the caller's and the two never share one. The lines join the latest prompt's turn, so rewinding that prompt cuts them.
 */
async function say($: EngineInterface, lines: readonly unknown[], agentId: string | undefined): Promise<SayResult> {
  const session = await $.session.id()
  await chains.get(session)
  const key = transcriptKey(session)
  const store = sessionStore($, session)
  return serialized(session, async () => {
    const stored = await store.get(wayseekerKey(key))
    const ledger = readWayseekerLedger(stored)
    const said = sayLines(ledger, lines, speakerOf(agentId))
    if (said.landed.length) {
      const firstId = nextId(ledger)
      const address = readPromptRows(await store.get(promptsKey(key))).findLast(row => row.address !== undefined)?.address
      const turns = readWayseekerTurns(stored)
      const added = said.ledger.utterances.some(u => u.id >= firstId)
      await store.set(wayseekerKey(key), { ...said.ledger, turns: added && address ? [...turns, { address, firstId }] : turns })
    }
    return { landed: said.landed, rejected: said.rejected, open: openItems(said.ledger), next: nextId(said.ledger) }
  })
}

const STEP_TOOL = 'step'
const CHECK_TOOL = 'check'
const STEP_TOOL_ID = `mcp__wayseeker__${STEP_TOOL}`
const CHECK_TOOL_ID = `mcp__wayseeker__${CHECK_TOOL}`
const stepsKey = (key: string) => `steps:${key}`

const STEP_DESCRIPTION = [
  'Record one planned step of a goal with a rubric: a drafter and an adversarial reviewer settle the checks that prove the step done (commands that must exit 0, and evidence criteria a quoted tool result or user message must show).',
  'The step lands in the wayseeker ledger as a check rule pass(step, item1), pass(step, item2), ... -> done(step). Group steps under a goal with say: done(s1), done(s2) -> ready(goal) and ready(goal) -> done(goal).',
  'step is a lowercase snake_case atom; cwd is the absolute repository path commands run in. Calling it again for the same step replaces its rubric. When the work is finished, call ' + CHECK_TOOL_ID + ' for the step.',
].join('\n')
const STEP_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    goal: { type: 'string', description: 'the goal this step belongs to, in a sentence' },
    step: { type: 'string', description: 'the step as a lowercase snake_case atom, e.g. parser_handles_unicode' },
    cwd: { type: 'string', description: 'absolute path of the repository the step works in' },
    notes: { type: 'array', items: { type: 'string' }, description: 'what the step must achieve, one point per item' },
  },
  required: ['goal', 'step', 'cwd'],
  additionalProperties: false,
}
const CHECK_DESCRIPTION = [
  'Judge a step recorded with ' + STEP_TOOL_ID + ' against its rubric now: each command item runs, and each evidence item is judged on the quote you cite for it.',
  'For every evidence item, cite {item, ref, quote}: ref is a tool_use_id of a tool result or m<n> of a user message, and quote is copied verbatim from that row.',
  'A passing item lands as check: say(pass(step, item)); a pass whose item now fails is withdrawn. The result lists each item\'s verdict and reason and whether done(step) holds.',
].join('\n')
const CHECK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    step: { type: 'string', description: 'the step atom given to ' + STEP_TOOL_ID },
    evidence: {
      type: 'array', description: 'one citation per evidence item',
      items: { type: 'object', properties: { item: { type: 'string' }, ref: { type: 'string' }, quote: { type: 'string' } }, required: ['item', 'ref', 'quote'], additionalProperties: false },
    },
  },
  required: ['step'],
  additionalProperties: false,
}

/** Lands lines check writes onto the main ledger, joining the latest prompt's turn so rewinding that prompt cuts them. */
async function landAsCheck($: EngineInterface, session: string, write: (ledger: Ledger) => { ledger: Ledger; landed: string[]; errors: string[] }): Promise<{ ledger: Ledger; landed: string[]; errors: string[] }> {
  await chains.get(session)
  const key = transcriptKey(session)
  const store = sessionStore($, session)
  return serialized(session, async () => {
    const stored = await store.get(wayseekerKey(key))
    const ledger = readWayseekerLedger(stored)
    const firstId = nextId(ledger)
    const written = write(ledger)
    if (written.landed.length) {
      const address = readPromptRows(await store.get(promptsKey(key))).findLast(row => row.address !== undefined)?.address
      const turns = readWayseekerTurns(stored)
      const added = written.ledger.utterances.some(u => u.id >= firstId)
      await store.set(wayseekerKey(key), { ...written.ledger, turns: added && address ? [...turns, { address, firstId }] : turns })
    }
    return written
  })
}

const modelIo = ($: EngineInterface): ModelIo => ({
  complete: async request => {
    const response = await $.model.complete(request)
    return response.isAnswered ? { isAnswered: true, text: response.text, reason: '' } : { isAnswered: false, text: '', reason: response.reason }
  },
})

async function recordStep($: EngineInterface, input: { goal: string; step: string; cwd: string; notes: string[] }): Promise<{ result: string; isError?: boolean }> {
  const session = await $.session.id()
  const key = transcriptKey(session)
  const store = sessionStore($, session)
  const steps = readSteps(await store.get(stepsKey(key)))
  const siblings = Object.entries(steps).filter(([name, s]) => name !== input.step && s.goal === input.goal).map(([name]) => name)
  const rubric = await debateRubric(modelIo($), { ...input, siblings })
  if (typeof rubric === 'string') return { result: 'No rubric settled for ' + input.step + ': ' + rubric + '. Call ' + STEP_TOOL_ID + ' again.', isError: true }
  await serialized(session, async () => {
    const fresh = readSteps(await store.get(stepsKey(key)))
    await store.set(stepsKey(key), { ...fresh, [input.step]: { goal: input.goal, cwd: input.cwd, notes: input.notes, items: rubric } })
  })
  const written = await landAsCheck($, session, ledger => writeStepRule(ledger, input.step, rubric))
  if (written.errors.length) $.ui.log('wayseeker: step rule rejected (' + written.errors.join('; ').slice(0, 160) + ')', { to: 'debug' })
  return { result: JSON.stringify({ step: input.step, rubric: rubricText(rubric), landed: written.landed, rejected: written.errors }), ...(written.errors.length ? { isError: true } : {}) }
}

async function checkStep($: EngineInterface, step: string, evidence: readonly unknown[]): Promise<{ result: string; isError?: boolean }> {
  const session = await $.session.id()
  const key = transcriptKey(session)
  const stored = readSteps(await serialized(session, () => sessionStore($, session).get(stepsKey(key))))[step]
  if (!stored) return { result: 'Step ' + step + ' has no rubric; record it with ' + STEP_TOOL_ID + ' first.', isError: true }
  const cited: Record<string, { ref: string; quote: string }> = {}
  for (const e of evidence) if (isRecord(e) && typeof e.item === 'string' && typeof e.ref === 'string' && typeof e.quote === 'string') cited[e.item] = { ref: e.ref, quote: e.quote }
  const verdicts = await judgeRubric(stored.items, {
    ...modelIo($),
    run: (argv, options) => $.process.run(argv, options),
    sources: async () => renderRange(await $.session.messages()).sources,
  }, cited, stored.cwd)
  for (const v of verdicts) if (v.internal) $.ui.log('wayseeker: check internal error step=' + step + ' item=' + v.id + ' ' + v.reason.slice(0, 300), { to: 'debug' })
  const written = await landAsCheck($, session, ledger => writeVerdicts(ledger, step, verdicts))
  const done = evaluate(written.ledger).facts.get('done(' + step + ')')?.value === 'true'
  return { result: JSON.stringify({ step, done, verdicts: verdicts.map(v => ({ item: v.id, pass: v.pass, reason: v.reason })), landed: written.landed, rejected: written.errors }) }
}

const EMPTY_LEDGER = readWayseekerLedger(undefined)
// What the section reads with no instruction and no raise; the post-compaction attachment skips it.
const EMPTY_SECTION = renderInstructions(EMPTY_LEDGER, evaluate(EMPTY_LEDGER))

async function instructions($: EngineInterface, input: WayseekerInstructionsInput = {}): Promise<string> {
  const session = input.sessionId ?? await $.session.id()
  const stored = await serialized(session, () => sessionStore($, session).get(wayseekerKey(transcriptKey(session, input.agentId))))
  const ledger = readWayseekerLedger(stored)
  return renderInstructions(ledger, evaluate(ledger))
}

const instructionAttachment = async ($: EngineInterface): Promise<string | undefined> => {
  const session = await $.session.id()
  const key = transcriptKey(session)
  const store = sessionStore($, session)
  return serialized(session, async () => {
    // The user's own prompts are already in context verbatim; the section only carries instructions across a compaction.
    if (await store.get(compactedSinceDeliveryKey(key)) !== true) return undefined
    const storedLedger = await store.get(wayseekerKey(key))
    const ledger = readWayseekerLedger(storedLedger)
    const quoteOf = promptQuotes(storedLedger, await store.get(quotesKey(key)))
    const section = renderInstructions(ledger, evaluate(ledger), quoteOf)
    if (section === EMPTY_SECTION) return undefined // keep the flag: the next prompt tries again
    await store.set(compactedSinceDeliveryKey(key), undefined)
    $.ui.log(`wayseeker: section delivered chars=${section.length}`, { to: 'debug' })
    return `<system-reminder>\n${section}\n</system-reminder>`
  })
}

export const register: Register = on => {
  on('engine.create', async ($, e, next) => {
    const beneath = await next(e)
    return {
      ...beneath,
      wayseeker: {
        instructions: () => { throw new Error('wayseeker.instructions is handled by the wayseeker plugin') },
      },
    }
  })

  on('wayseeker.instructions', async ($, e) => ({ value: await instructions($, e ?? {}) }))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    try {
      await $.tool.register({ name: SAY_TOOL, description: SAY_DESCRIPTION, inputSchema: SAY_INPUT_SCHEMA, isDeferred: false })
      await $.tool.register({ name: STEP_TOOL, description: STEP_DESCRIPTION, inputSchema: STEP_INPUT_SCHEMA, isDeferred: false })
      await $.tool.register({ name: CHECK_TOOL, description: CHECK_DESCRIPTION, inputSchema: CHECK_INPUT_SCHEMA, isDeferred: false })
    } catch (err) {
      $.ui.log(`wayseeker: tool registration failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
    return started
  })

  on('tool.call', { tool: SAY_TOOL_ID }, async ($, e) => {
    const lines = (e as unknown as { lines?: unknown }).lines
    if (!Array.isArray(lines)) return { result: `Call ${SAY_TOOL_ID} with lines: an array of L1 lines.`, isError: true }
    const result = await say($, lines, e.agentId)
    for (const line of landedActs(result.landed)) $.ui.log(line)
    for (const { line, error } of result.rejected) $.ui.log(`wayseeker: say rejected ${JSON.stringify(line)} (${error.slice(0, 160)})`, { to: 'debug' })
    return { result: JSON.stringify(result) }
  })

  on('tool.call', { tool: STEP_TOOL_ID }, async ($, e) => {
    const input = e as unknown as { goal?: unknown; step?: unknown; cwd?: unknown; notes?: unknown }
    if (typeof input.goal !== 'string' || !input.goal.trim() || typeof input.step !== 'string' || !STEP_ATOM.test(input.step) || typeof input.cwd !== 'string' || !input.cwd.startsWith('/'))
      return { result: `Call ${STEP_TOOL_ID} with goal (a sentence), step (a lowercase snake_case atom) and cwd (an absolute path).`, isError: true }
    const notes = Array.isArray(input.notes) ? input.notes.filter((n): n is string => typeof n === 'string') : []
    return recordStep($, { goal: input.goal, step: input.step, cwd: input.cwd, notes })
  })

  on('tool.call', { tool: CHECK_TOOL_ID }, async ($, e) => {
    const input = e as unknown as { step?: unknown; evidence?: unknown }
    if (typeof input.step !== 'string' || !STEP_ATOM.test(input.step)) return { result: `Call ${CHECK_TOOL_ID} with step: the atom given to ${STEP_TOOL_ID}.`, isError: true }
    return checkStep($, input.step, Array.isArray(input.evidence) ? input.evidence : [])
  })

  on('prompt.submit', async ($, e, next) => {
    if (!isHumanOrigin(e.origin)) return next(e)
    let attachment: string | undefined
    try {
      const session = await $.session.id()
      const rows = await $.session.messages()
      const text = stripReminders(e.text)
      const userMessage = text && !isHarnessText(text) ? text : undefined
      const overTurn = e.turnId !== undefined
      const address = await serialized(session, () => observePrompt($, session, rows, userMessage, overTurn))
      if (overTurn && address !== undefined && userMessage !== undefined) awaitingFold.set(session, [...(awaitingFold.get(session) ?? []), { address, text: userMessage }])
      // Rendered after observePrompt so a rewind's cuts are already gone, and before the extraction starts so it
      // cannot land ahead of this prompt's own row; this prompt's lines reach the next prompt's attachment.
      try {
        attachment = await instructionAttachment($)
      } catch (err) {
        $.ui.log(`wayseeker: instructions render failed (${String(err).slice(0, 160)})`, { to: 'debug' })
      }
      if (userMessage !== undefined && address !== undefined) {
        void recordTurn($, session, userMessage, rows, address, overTurn).catch(err => {
          $.ui.log(`wayseeker: extraction failed stderr=${JSON.stringify(String(err))}`, { to: 'debug' })
        })
      }
    } catch (err) {
      $.ui.log(`wayseeker: prompt observation failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
    // Wrapped as a system-reminder so stripReminders keeps the prompt text equal to what was typed, if the engine folds context into the row.
    return next(attachment === undefined ? e : { ...e, context: [...(e.context ?? []), attachment] })
  })

  // A landed main-session compaction arms the one-shot delivery of the section on the next human prompt.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || (result as { skip?: unknown }).skip !== undefined) return result
    try {
      const session = await $.session.id()
      await serialized(session, () => sessionStore($, session).set(compactedSinceDeliveryKey(transcriptKey(session)), true))
    } catch (err) {
      $.ui.log(`wayseeker: arming section delivery failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
    return result
  })

  // A prompt typed mid-turn reaches the transcript as a `queued_command` attachment, a row $.session.messages() never lists.
  on('session.append', { door: 'attachment' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.message.name !== 'queued_command') return result
    try {
      const session = await $.session.id()
      if (!awaitingFold.has(session)) return result
      const text = stripReminders(e.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
      await markFolded($, session, text)
    } catch (err) {
      $.ui.log(`wayseeker: marking a mid-turn prompt failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
    return result
  })
}
