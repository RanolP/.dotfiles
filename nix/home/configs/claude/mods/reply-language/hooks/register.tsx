import type { Register } from 'claude-code'

const INSTRUCTION = 'Write every reply to the user in Korean (한국어), even when the context, tool results or subagent reports are in English; code, commands, identifiers and quotes stay as written.'

export const register: Register = on => {
  // A prompt, typed or a mod's $.prompt.submit, only reaches the main loop.
  on('prompt.submit', async ($, e, next) => {
    $.ui.log(`reply-language: instruction added to prompt.submit origin=${e.origin.kind}`, { to: 'debug' })
    return next({ ...e, context: [...(e.context ?? []), INSTRUCTION] })
  })

  // A mod's $.session.append (door `note`) bypasses prompt.submit, so the row itself carries the instruction.
  on('session.append', async ($, e, next) => {
    if (e.agentId || e.door !== 'note' || e.origin.kind !== 'plugin' || e.message.type !== 'user') return next(e)
    $.ui.log(`reply-language: instruction added to session.append from ${e.origin.name}`, { to: 'debug' })
    return next({ ...e, message: { ...e.message, content: [...e.message.content, { type: 'text', text: INSTRUCTION }] } })
  })
}
