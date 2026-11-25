import type { EngineInterface, Register } from 'claude-code'
import { projectSession } from './events'

const project = async ($: EngineInterface): Promise<void> => {
  try {
    await projectSession({
      exists: path => $.fs.exists(path),
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      toolCall: input => $.tool.call(input),
      log: (text, options) => $.ui.log(text, options),
    }, (await $.env.get('HOME')) ?? '.', await $.session.id())
  } catch (error) {
    $.ui.log(`task-panel: projection failed (${String(error).slice(0, 160)})`, { to: 'debug' })
  }
}

export const register: Register = on => {
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && next.origin.plugin !== 'task-panel') await project($)
    return result
  })
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await project($)
    return result
  })
}
