import type { Register } from 'claude-code'

const NOT_KOREAN = { plugin: 'reply-language', key: 'isNotKorean' } as const

const REMINDER = 'Your previous answer to the user was not in Korean. Write every reply to the user in Korean (한국어), as the output style requires, even when the surrounding context, a tool result or a subagent report is in English; code, commands, identifiers and quotes stay as written.'

export const register: Register = on => {
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    // A subagent's report is meant for the model, not the user.
    if (!e.agentId && !e.isAborted && e.answer.trim() && !/[가-힣]/.test(e.answer)) await $.state.set(NOT_KOREAN, true)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const isReminding = (await $.state.get(NOT_KOREAN)).value ?? false
    if (!isReminding) return next(e)
    await $.state.set(NOT_KOREAN, false)
    return next({ ...e, context: [...(e.context ?? []), REMINDER] })
  })
}
