import type { EngineInterface, Register } from 'claude-code'
import { PreCompactor, preIo, preSettings } from './precompact'

function log($: EngineInterface, text: string) {
  return $.ui.log(`[bg-compact] ${text}`, { to: 'debug' })
}

export const register: Register = (on, options) => {
  // Any failure in the pre-compaction hooks leaves the engine's behaviour as it was, with one debug line.
  const pre = new PreCompactor(preSettings(options as Record<string, unknown>))
  on('turn.complete', async ($, e, next) => {
    const res = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      try { await pre.turnEnd(preIo($)) }
      catch (err) { try { await log($, `pre-compaction check failed (${String(err).slice(0, 200)})`) } catch {} }
    }
    return res
  })
  on('session.compact', async ($, e, next) => {
    let handed: Promise<Awaited<ReturnType<typeof next>>> | undefined
    const once = (input: typeof e) => handed ??= next(input)
    try { return await pre.compact(preIo($), e, once) }
    catch (err) {
      try { await log($, `session.compact fell through (${String(err).slice(0, 200)})`) } catch {}
      return handed ?? next(e)
    }
  })
}
