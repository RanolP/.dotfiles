import type { EngineInterface, PromptOrigin, Register, SessionMessage } from 'claude-code'
import { evaluate } from './eval'
import { extractTurn } from './extract'
import { countUserRows, dropWayseekerTurns, landWayseekerTurn, readWayseekerLedger, renderInstructions, turnIsLive, wayseekerKey } from './render'
import { promptFingerprint, promptsKey, readPromptRows, reconcilePrompts } from './rewind'
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
 */
async function observePrompt($: EngineInterface, session: string, rows: readonly SessionMessage[], userMessage: string | undefined): Promise<string | undefined> {
  const key = transcriptKey(session)
  const store = sessionStore($, session)
  const { rows: prompts, rewound } = reconcilePrompts(readPromptRows(await store.get(promptsKey(key))), promptTexts(rows).map(promptFingerprint))
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
function recordTurn($: EngineInterface, session: string, userMessage: string, rows: readonly SessionMessage[], address: string): Promise<void> {
  const key = transcriptKey(session)
  const prevAssistant = [...rows].reverse().find(row => row.role === 'assistant' && row.text.trim())?.text ?? ''
  // `rows` was read in prompt.submit before next(e); the engine adds the prompt's row only after the
  // prompt.submit chain settles its text, so it is not in `rows` and +1 counts it.
  const seen = countUserRows(rows, userMessage) + 1
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
    const landed = await serialized(session, () => landWayseekerTurn({
      get: store.get, set: store.set,
      isLive: async () => turnIsLive(await $.session.messages(), userMessage, seen),
    }, key, result.appended, address))
    if (landed.rewound) $.ui.log(`wayseeker: prompt rewound during extraction; ${result.appended.length} line(s) not written`, { to: 'debug' })
    for (const { line, errors } of landed.dropped) $.ui.log(`wayseeker: dropped on replay ${JSON.stringify(line)} (${errors.join('; ').slice(0, 160)})`, { to: 'debug' })
  }
  const job = (chains.get(session) ?? Promise.resolve()).then(run)
  const tail = job.catch(() => undefined)
  chains.set(session, tail)
  void tail.then(() => { if (chains.get(session) === tail) chains.delete(session) })
  return job
}

async function instructions($: EngineInterface, input: WayseekerInstructionsInput = {}): Promise<string> {
  const session = input.sessionId ?? await $.session.id()
  const stored = await serialized(session, () => sessionStore($, session).get(wayseekerKey(transcriptKey(session, input.agentId))))
  const ledger = readWayseekerLedger(stored)
  return renderInstructions(ledger, evaluate(ledger))
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

  on('prompt.submit', async ($, e, next) => {
    if (!isHumanOrigin(e.origin)) return next(e)
    try {
      const session = await $.session.id()
      const rows = await $.session.messages()
      const text = stripReminders(e.text)
      const userMessage = text && !isHarnessText(text) ? text : undefined
      const address = await serialized(session, () => observePrompt($, session, rows, userMessage))
      if (userMessage !== undefined && address !== undefined) {
        void recordTurn($, session, userMessage, rows, address).catch(err => {
          $.ui.log(`wayseeker: extraction failed stderr=${JSON.stringify(String(err))}`, { to: 'debug' })
        })
      }
    } catch (err) {
      $.ui.log(`wayseeker: prompt observation failed (${String(err).slice(0, 160)})`, { to: 'debug' })
    }
    return next(e)
  })
}
