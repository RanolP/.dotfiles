import { update } from 'claude-code'
import type { EngineInterface, Register, ToolSpec } from 'claude-code'
import type { Option, Question } from '../types'

const QUESTIONS = { plugin: 'ask-later', key: 'questions' } as const
const TURN = { plugin: 'ask-later', key: 'turnId' } as const
const WALKING = { plugin: 'ask-later', key: 'isWalking' } as const

const RESOLVE_TOOL = 'mcp__ask-later__resolve'

const TOOLS = [
  {
    name: 'ask',
    description: 'Queue a question for the user without waiting for the answer. Returns at once; the user answers later from the 답하기 button and the answer arrives as a message. Give `assumption` to keep working under it, or `blocks` to name the work that waits for the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The complete question, ending in a question mark' },
        header: { type: 'string', maxLength: 12, description: 'A short chip label (12 characters at most)' },
        options: {
          type: 'array', minItems: 2, maxItems: 4,
          items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'] },
        },
        multiSelect: { type: 'boolean' },
        assumption: { type: 'string', description: 'The answer you proceed under until the user replies' },
        blocks: { type: 'string', description: 'The work that waits for this answer' },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'resolve',
    description: 'Close a queued question that was settled in chat, recording the answer.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The question id, e.g. Q3' }, answer: { type: 'string' } },
      required: ['id', 'answer'],
    },
  },
  {
    name: 'list',
    description: 'List queued questions still pending and answers not yet delivered.',
    inputSchema: { type: 'object', properties: {} },
  },
] satisfies ToolSpec[]

type Ctx = EngineInterface

// `chat` is the question the user dropped out of the walk on, through the
// dialog's native "Chat about this" row.
type Walk = { chat?: Question; chatNotes?: string }

// The native "Chat about this" row resolves the AskUserQuestion permission as a
// deny whose feedback opens with this sentence (claude 2.1.288, M3e), so
// $.ui.ask rejects with it; Esc rejects without it.
const CHAT_MARK = 'The user wants to clarify these questions'

/** Reads a $.ui.ask rejection: undefined for a plain dismissal, else the chat request and any "User notes:" text. */
export function chatRequest(reason: string): { notes?: string } | undefined {
  if (!reason.includes(CHAT_MARK)) return undefined
  // $.ui.ask wraps the deny text as "...: no answer (<first 120 chars>)", so a
  // notes line that ends the text carries the wrapper's closing parenthesis.
  const m = /User notes:[ \t]*([^\n]*)/.exec(reason)
  if (!m) return {}
  const atEnd = m.index + m[0].length === reason.length
  const notes = (atEnd ? m[1].replace(/\)$/, '') : m[1]).trim()
  return notes ? { notes } : {}
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const log = ($: Ctx, text: string) => $.ui.log(`[ask-later] ${text}`, { to: 'debug' })
const toolError = (text: string) => ({ result: text, isError: true as const, text })
const ok = (text: string) => ({ result: text, text })

async function questions($: Ctx): Promise<Question[]> {
  return (await $.state.get(QUESTIONS)).value ?? []
}

function isOptions(v: unknown): v is Option[] {
  return Array.isArray(v) && v.length >= 2 && v.length <= 4
    && v.every(o => o && typeof o === 'object' && typeof (o as Option).label === 'string'
      && ((o as Option).description === undefined || typeof (o as Option).description === 'string'))
}

const optionalString = (v: unknown) => v === undefined || typeof v === 'string'

function describe(q: Question): string {
  const lines = [`${q.id} [${q.status}${q.status !== 'pending' && !q.delivered ? ', undelivered' : ''}] ${q.question}`]
  lines.push(`  options: ${q.options.map(o => o.label).join(' | ')}${q.multiSelect ? ' (multi-select)' : ''}`)
  if (q.assumption) lines.push(`  assumption: ${q.assumption}`)
  if (q.blocks) lines.push(`  blocks: ${q.blocks}`)
  if (q.answer !== undefined) lines.push(`  answer: ${q.answer}`)
  return lines.join('\n')
}

function deliveryText(answered: Question[]): string {
  const items = answered.map(q => [
    `${q.id}: ${q.question}`,
    `  answer: ${q.answer}`,
    `  asked under assumption: ${q.assumption ?? '(none)'}`,
    ...(q.blocks ? [`  parked work: ${q.blocks}`] : []),
  ].join('\n'))
  return [
    'The user answered queued questions (ask-later):',
    ...items,
    'Where an answer differs from the assumption it was asked under, revisit the work done under that assumption. Resume the parked work.',
  ].join('\n\n')
}

async function deliver($: Ctx, answered: Question[]) {
  if (!answered.length) return
  const text = deliveryText(answered)
  const turnId = (await $.state.get(TURN)).value ?? null
  let isDelivered = false
  if (turnId) {
    try {
      const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (r.deny) log($, `session.append denied during turn ${turnId}: ${r.deny}; falling back to prompt.submit`)
      else isDelivered = true
    } catch (err) {
      log($, `session.append failed during turn ${turnId}: ${errText(err)}; falling back to prompt.submit`)
    }
  }
  if (!isDelivered) {
    try {
      const r = await $.prompt.submit({ text })
      if ('drop' in r && r.drop) log($, `prompt.submit dropped answers ${answered.map(q => q.id).join(',')}: ${r.drop}`)
      else isDelivered = true
    } catch (err) {
      log($, `prompt.submit failed for answers ${answered.map(q => q.id).join(',')}: ${errText(err)}`)
    }
  }
  if (!isDelivered) return
  const ids = new Set(answered.map(q => q.id))
  await update($, QUESTIONS, qs => (qs ?? []).map(q => (ids.has(q.id) ? { ...q, delivered: true } : q)))
}

/** Walks the pending questions through $.ui.ask, one dialog each, then delivers the answers. One walk at a time. */
export async function answerPending($: Ctx) {
  let isStarted = false
  await update($, WALKING, w => {
    isStarted = !w
    return true
  })
  if (!isStarted) return
  const w: Walk = {}
  const answered: Question[] = []
  try {
    const pending = (await questions($)).filter(q => q.status === 'pending')
    for (const queued of pending) {
      // The model may have resolved it while an earlier dialog was open.
      const q = (await questions($)).find(x => x.id === queued.id)
      if (!q || q.status !== 'pending') continue
      let answer: string
      try {
        answer = await $.ui.ask(q.question, {
          options: q.options.map(o => o.label),
          ...(q.header ? { header: q.header } : {}),
          ...(q.multiSelect ? { multiSelect: true as const } : {}),
        })
      } catch (err) {
        const reason = errText(err)
        const chat = chatRequest(reason)
        if (chat) {
          w.chat = q
          if (chat.notes) w.chatNotes = chat.notes
          break
        }
        log($, `${q.id} skipped: ${reason}`)
        $.ui.toast(`${q.id} 건너뜀: ${reason.replace(/^.*?\$\.ui\.ask: no answer \(/, '').slice(0, 80)}`)
        continue
      }
      const done: Question = { ...q, status: 'answered', answer }
      await update($, QUESTIONS, qs => (qs ?? []).map(x => (x.id === q.id ? done : x)))
      answered.push(done)
    }
  } catch (err) {
    log($, `answer walk failed: ${errText(err)}`)
  } finally {
    try {
      await $.state.set(WALKING, false)
    } catch (err) {
      log($, `answer walk: clearing isWalking failed: ${errText(err)}`)
    }
  }
  try {
    await deliver($, answered)
    if (w.chat) {
      const filled = await $.prompt.fill({ text: `[${w.chat.id}] ${w.chat.question}\n${w.chatNotes ? `${w.chatNotes}\n` : ''}` })
      if (!filled.isFilled) log($, `prompt.fill for ${w.chat.id} refused: ${filled.refusal ?? 'unknown'}`)
    }
  } catch (err) {
    log($, `delivery of answers ${answered.map(q => q.id).join(',') || 'nothing'} failed: ${errText(err)}`)
  }
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    for (const t of TOOLS) {
      try {
        await $.tool.register(t)
      } catch (err) {
        log($, `tool.register(${t.name}) failed: ${errText(err)}`)
      }
    }
    // A walk cut short (a reload) would leave isWalking true and the 답하기 button hidden all session.
    await $.state.set(WALKING, false)
    return started
  })

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    await $.state.set(TURN, r.turnId)
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    // A subagent's turn ending leaves the main turn running.
    if (!e.agentId) await $.state.set(TURN, null)
    return r
  })

  on('tool.call', { tool: 'mcp__ask-later__ask' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    if (typeof a.question !== 'string' || !a.question.trim()) return toolError('Call ask with question as a non-empty string.')
    if (!isOptions(a.options)) return toolError('Call ask with options as 2-4 objects of {label, description?}.')
    if (!optionalString(a.header) || (typeof a.header === 'string' && a.header.length > 12)) return toolError('header must be a string of 12 characters at most.')
    if (!optionalString(a.assumption) || !optionalString(a.blocks)) return toolError('assumption and blocks must be strings when given.')
    if (a.multiSelect !== undefined && typeof a.multiSelect !== 'boolean') return toolError('multiSelect must be a boolean when given.')
    let id = ''
    try {
      await update($, QUESTIONS, qs => {
        const list = qs ?? []
        const n = list.reduce((max, q) => Math.max(max, Number(q.id.slice(1)) || 0), 0) + 1
        id = `Q${n}`
        const q: Question = {
          id, question: a.question as string, options: a.options as Option[], status: 'pending',
          ...(a.header ? { header: a.header as string } : {}),
          ...(a.multiSelect ? { multiSelect: true } : {}),
          ...(a.assumption ? { assumption: a.assumption as string } : {}),
          ...(a.blocks ? { blocks: a.blocks as string } : {}),
        }
        return [...list, q]
      })
    } catch (err) {
      log($, `ask: state write failed for "${a.question}": ${errText(err)}`)
      return toolError(`ask failed to queue the question: ${errText(err)}`)
    }
    $.ui.toast(`${id} 대기: ${a.question}`)
    const how = a.assumption
      ? `Proceed under the assumption "${a.assumption}" and note which work depends on it.`
      : `Park only the work this blocks${a.blocks ? ` (${a.blocks})` : ''} and continue with other work.`
    return ok(`${id} queued. The user answers it later; the answer arrives as a message. ${how}`)
  })

  on('tool.call', { tool: 'mcp__ask-later__resolve' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    if (typeof a.id !== 'string' || typeof a.answer !== 'string') return toolError('Call resolve with id (e.g. Q3) and answer as strings.')
    let found: Question | undefined
    try {
      await update($, QUESTIONS, qs => (qs ?? []).map(q => {
        if (q.id !== a.id) return q
        found = q
        return { ...q, status: 'resolved', answer: a.answer as string, delivered: true }
      }))
    } catch (err) {
      log($, `resolve ${a.id}: state write failed: ${errText(err)}`)
      return toolError(`resolve failed: ${errText(err)}`)
    }
    if (!found) return toolError(`No queued question ${a.id}.`)
    return ok(`${a.id} resolved: ${a.answer}`)
  })

  on('tool.call', { tool: 'mcp__ask-later__list' }, async $ => {
    const open = (await questions($)).filter(q => q.status === 'pending' || !q.delivered)
    return ok(open.length ? open.map(describe).join('\n') : 'No pending questions or undelivered answers.')
  })

  // 질문 N개 대기  [답하기] above the prompt while questions wait; the state reads subscribe it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const n = (await questions($)).filter(q => q.status === 'pending').length
    if (!n) return next(e)
    const isWalking = (await $.state.get(WALKING)).value ?? false
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box key="ask-later-band" flexDirection="row">
          <Text color="yellow" bold>{`질문 ${n}개 대기`}</Text>
          {isWalking ? <Text dimColor>  답하는 중</Text> : <Text>  </Text>}
          {isWalking ? null : <Button key="answer" label="답하기" variant="primary" onPress={() => void answerPending($)} />}
        </Box>
        {below}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    const id = /^\[(Q\d+)\]/.exec(e.text)?.[1]
    if (!id) return next(e)
    const q = (await questions($)).find(x => x.id === id && x.status === 'pending')
    if (!q) return next(e)
    const ctx = [
      `This prompt is about queued question ${q.id}: ${q.question}`,
      `Options: ${q.options.map(o => (o.description ? `${o.label} (${o.description})` : o.label)).join('; ')}${q.multiSelect ? ' [multi-select]' : ''}`,
      `Assumption it was asked under: ${q.assumption ?? '(none)'}`,
      ...(q.blocks ? [`Parked work: ${q.blocks}`] : []),
      `Settle this with the user, then call ${RESOLVE_TOOL} with id ${q.id} and the answer.`,
    ].join('\n')
    return next({ ...e, context: [...(e.context ?? []), ctx] })
  })
}
