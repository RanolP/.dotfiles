import { update } from 'claude-code'
import type { EngineInterface, Register, ToolSpec } from 'claude-code'
import type { Option, Question } from '../types'

const QUESTIONS = { plugin: 'ask-later', key: 'questions' } as const
const TURN = { plugin: 'ask-later', key: 'turnId' } as const

const RESOLVE_TOOL = 'mcp__ask-later__resolve'

const TOOLS = [
  {
    name: 'ask',
    description: 'Queue a question for the user without waiting for the answer. Returns at once; the user answers later with /answers and the answer arrives as a message. Give `assumption` to keep working under it, or `blocks` to name the work that waits for the answer.',
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

// One /answers walk at a time. `current` is the question whose dialog is open;
// `dismiss` closes it (the tool.call hook below races the dialog against it).
type Walk = { current?: Question; chat?: Question; dismiss?: () => void }

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const log = ($: Ctx, text: string) => $.ui.log(`[ask-later] ${text}`, { to: 'debug' })
const toolError = (text: string) => ({ result: text, isError: true as const, text })
const ok = (text: string) => ({ result: text, text })

async function questions($: Ctx): Promise<Question[]> {
  return (await $.state.get(QUESTIONS)).value ?? []
}

async function showStatus($: Ctx) {
  const n = (await questions($)).filter(q => q.status === 'pending').length
  $.ui.status(n ? `질문 ${n}개 대기 · /answers` : undefined)
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

export const register: Register = on => {
  let walk: Walk | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    for (const t of TOOLS) {
      try {
        await $.tool.register(t)
      } catch (err) {
        log($, `tool.register(${t.name}) failed: ${errText(err)}`)
      }
    }
    try {
      await $.command.register({ name: 'answers', description: 'Answer the questions the model queued (Esc skips one)' })
    } catch (err) {
      log($, `command.register(answers) failed: ${errText(err)}`)
    }
    await showStatus($)
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
    await showStatus($)
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
    await showStatus($)
    return ok(`${a.id} resolved: ${a.answer}`)
  })

  on('tool.call', { tool: 'mcp__ask-later__list' }, async $ => {
    const open = (await questions($)).filter(q => q.status === 'pending' || !q.delivered)
    return ok(open.length ? open.map(describe).join('\n') : 'No pending questions or undelivered answers.')
  })

  // Dismissal: a $.ui.ask is a tool.call of AskUserQuestion; returning while
  // `next` is pending aborts the dialog beneath, which rejects that ask.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const asked = (e as unknown as { questions?: { question?: string }[] }).questions?.[0]?.question
    const w = walk
    if (!w?.current || asked !== w.current.question) return next(e)
    const dismissed = new Promise<{ deny: string }>(resolve => {
      w.dismiss = () => resolve({ deny: `ask-later: chat about ${w.current?.id}` })
    })
    return Promise.race([next(e), dismissed])
  })

  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const drawn = await next(e)
    const asked = (e.props.questions[0] as { question?: string } | undefined)?.question
    const w = walk
    const q = w?.current
    if (!w || !q || asked !== q.question) return drawn
    const { Box, Button } = $.ui.resolve(e)
    // The Button goes above the dialog: the engine refuses a tree that draws
    // below AskUserQuestion ("draws below the dialog") and draws its own.
    return (
      <Box flexDirection="column">
        <Button key="chat" label="Chat with this question" hotkey="c" onPress={() => {
          w.chat = q
          if (w.dismiss) w.dismiss()
          else log($, `chat on ${q.id}: no dismiss armed for this dialog`)
        }} />
        {drawn}
      </Box>
    )
  })

  on('command.run', { command: 'answers' }, async $ => {
    if (walk) return { text: '/answers가 이미 열려 있다.' }
    const pending = (await questions($)).filter(q => q.status === 'pending')
    if (!pending.length) return { text: '대기 질문이 없다.' }
    const w: Walk = {}
    walk = w
    void (async () => {
      const answered: Question[] = []
      try {
        for (const queued of pending) {
          // The model may have resolved it while an earlier dialog was open.
          const q = (await questions($)).find(x => x.id === queued.id)
          if (!q || q.status !== 'pending') continue
          w.current = q
          w.dismiss = undefined
          let answer: string
          try {
            answer = await $.ui.ask(q.question, {
              options: q.options.map(o => o.label),
              ...(q.header ? { header: q.header } : {}),
              ...(q.multiSelect ? { multiSelect: true as const } : {}),
            })
          } catch (err) {
            if (w.chat) break
            log($, `${q.id} skipped: ${errText(err)}`)
            continue
          }
          const done: Question = { ...q, status: 'answered', answer }
          await update($, QUESTIONS, qs => (qs ?? []).map(x => (x.id === q.id ? done : x)))
          answered.push(done)
        }
      } catch (err) {
        log($, `/answers walk failed: ${errText(err)}`)
      } finally {
        walk = undefined
      }
      try {
        await deliver($, answered)
        await showStatus($)
        if (w.chat) {
          const filled = await $.prompt.fill({ text: `[${w.chat.id}] ${w.chat.question}\n` })
          if (!filled.isFilled) log($, `prompt.fill for ${w.chat.id} refused: ${filled.refusal ?? 'unknown'}`)
        }
      } catch (err) {
        log($, `/answers delivery of ${answered.map(q => q.id).join(',') || 'nothing'} failed: ${errText(err)}`)
      }
    })()
    return { text: `대기 질문 ${pending.length}개, Esc로 건너뛴다.` }
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
