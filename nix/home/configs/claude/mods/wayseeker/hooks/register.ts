import type { EngineInterface, PromptOrigin, Register, SessionMessage } from 'claude-code'
import { evaluate } from './eval'
import { extractTurn } from './extract'
import { countUserRows, dropWayseekerTurns, landWayseekerTurn, readWayseekerLedger, readWayseekerTurns, renderInstructions, turnIsLive, wayseekerKey } from './render'
import { promptFingerprint, promptsKey, readPromptRows, reconcilePrompts } from './rewind'
import { needsSayNudge, openItems, SAY_DESCRIPTION, SAY_INPUT_SCHEMA, SAY_NUDGE, SAY_TOOL, SAY_TOOL_ID, sayLines, speakerOf, type SayResult } from './say'
import { deliveredSectionKey, nextId, readDeliveredSection } from './store'
import { isHarnessText, isRecord, stripReminders } from './text'
import type { WayseekerInstructionsInput } from '../types'

const isHumanOrigin = (origin: PromptOrigin) => origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk'
const transcriptKey = (session: string, agentId?: string) => `${session}:${agentId ?? 'main'}`
const nextAddressKey = (key: string) => `next-address:${key}`

// One JSON file per session, beside clm's own per-session state, so the ledger never grows the plugin-wide 4 MiB store.
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
  let address: string | undefined
  if (userMessage !== undefined) {
    const seq = Number(await store.get(nextAddressKey(key)) ?? 1)
    address = `@w${seq}`
    await store.set(nextAddressKey(key), seq + 1)
    prompts.push({ fp: promptFingerprint(userMessage), address })
  }
  await store.set(promptsKey(key), prompts)
  return address
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
  const acts = landed.flatMap(line => { const m = /^@\d+ [^:\s]+: (.+)$/s.exec(line); return m ? [`wayseeker: ${m[1]}`] : [] })
  return acts.length > MAX_NOTICES ? [...acts.slice(0, MAX_NOTICES), `… 외 ${acts.length - MAX_NOTICES}건`] : acts
}

/** One user-visible line per instruction that entered or left the section, at most three, then a count. */
export function instructionChanges(before: string, after: string): string[] {
  const [was, now] = [instructionLines(before), instructionLines(after)]
  const notices = [
    ...now.filter(line => !was.includes(line)).map(line => `wayseeker: 지시 추가: ${line}`),
    ...was.filter(line => !now.includes(line)).map(line => `wayseeker: 지시 제외: ${line}`),
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
    return { landed: said.landed, rejected: said.rejected, open: openItems(said.ledger) }
  })
}

const EMPTY_LEDGER = readWayseekerLedger(undefined)
// What the section reads with no instruction and no raise; the per-turn attachment skips it.
const EMPTY_SECTION = renderInstructions(EMPTY_LEDGER, evaluate(EMPTY_LEDGER))

async function instructions($: EngineInterface, input: WayseekerInstructionsInput = {}): Promise<string> {
  const session = input.sessionId ?? await $.session.id()
  const stored = await serialized(session, () => sessionStore($, session).get(wayseekerKey(transcriptKey(session, input.agentId))))
  const ledger = readWayseekerLedger(stored)
  return renderInstructions(ledger, evaluate(ledger))
}

const instructionAttachment = async ($: EngineInterface, atSubmit: boolean): Promise<string | undefined> => {
  const session = await $.session.id()
  const key = transcriptKey(session)
  const store = sessionStore($, session)
  return serialized(session, async () => {
    const ledger = readWayseekerLedger(await store.get(wayseekerKey(key)))
    const section = renderInstructions(ledger, evaluate(ledger))
    if (section === EMPTY_SECTION) return undefined
    const fingerprint = promptFingerprint(section)
    const delivered = readDeliveredSection(await store.get(deliveredSectionKey(key)))
    // A tool.call in the turn that submit delivered to trusts the record: the prompt's row may not hold the attachment yet.
    if (delivered?.fingerprint === fingerprint && ((!atSubmit && delivered.atSubmit) || (await $.session.messages()).some(row => row.text.includes(delivered.section)))) return undefined
    await store.set(deliveredSectionKey(key), { fingerprint, section, atSubmit })
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
      await $.tool.register({ name: SAY_TOOL, description: SAY_DESCRIPTION, inputSchema: SAY_INPUT_SCHEMA })
    } catch (err) {
      $.ui.log(`wayseeker: say registration failed (${String(err).slice(0, 160)})`, { to: 'debug' })
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

  // A turn that changed something and recorded nothing gets one nudge; stop_hook_active marks the turn it re-prompted.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (e.stop_hook_active || result.block !== undefined) return result
    try {
      if (needsSayNudge(await $.session.messages())) return { ...result, block: SAY_NUDGE }
    } catch (err) {
      $.ui.log(`wayseeker: say nudge check failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
    return result
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
      // cannot land ahead of this prompt's own row; this prompt's lines reach the next tool call's attachment.
      try {
        attachment = await instructionAttachment($, true)
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

  // The stored transcript keeps rows from before a compaction (a clm fold arrives as this same event), so the
  // delivered-section scan alone would still find the old section; a landed compaction forgets the record instead.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || (result as { skip?: unknown }).skip !== undefined) return result
    try {
      const session = await $.session.id()
      await serialized(session, () => sessionStore($, session).set(deliveredSectionKey(transcriptKey(session)), undefined))
    } catch (err) {
      $.ui.log(`wayseeker: clearing delivered section failed (${String(err).slice(0, 160)})`, { to: 'debug' })
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

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || result.deny !== undefined) return result
    try {
      const attachment = await instructionAttachment($, false)
      return attachment === undefined ? result : { ...result, context: [...(result.context ?? []), attachment] }
    } catch (err) {
      $.ui.log(`wayseeker: instructions render failed (${String(err).slice(0, 160)})`, { to: 'debug' })
      return result
    }
  })
}
