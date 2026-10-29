import { update } from 'claude-code'
import type { EngineInterface, Register, ToolSpec } from 'claude-code'
import type { Alternative, ApprovalRequest, ExecResult } from '../types'

const REQUESTS = { plugin: 'request', key: 'requests' } as const
const TURN = { plugin: 'request', key: 'turnId' } as const

export const RAISE_TOOL = 'mcp__request__raise_approval_request'
// $.process.run's ceiling; an escalated command is often the long one.
export const TIMEOUT_MS = 600_000
// Per stream, in characters, as the model receives it (the Bash tool's own cap).
export const OUTPUT_CAP = 30_000

const TOOLS = [
  {
    name: 'raise_approval_request',
    description: [
      'Escalate one Bash command that the auto-mode permission classifier denied, when that command is the only correct way to do the work.',
      'Returns at once with a request id (R<n>); keep working on what does not depend on it.',
      'The user reviews it with /approvals. On approval this tool\'s mod runs the exact command once in cwd (bash -c) and the stdout, stderr and exit code arrive as a message; on rejection the rejection and its reason arrive. Re-issuing the denied Bash call would be denied again, so wait for that message.',
      'Bash only. Use it only for a classifier denial: a denial, rejection or "stop"/"cancel" from the user still halts that line of work.',
      'Each approval runs the command once; running it again needs a new request.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The exact Bash command the classifier denied, byte for byte' },
        cwd: { type: 'string', description: 'Absolute directory to run it in' },
        why_only_way: { type: 'string', description: 'Why this command is the only correct way to do the work' },
        alternatives: {
          type: 'array', minItems: 1,
          description: 'The other approaches considered and why each was rejected',
          items: {
            type: 'object',
            properties: { approach: { type: 'string' }, rejected_because: { type: 'string' } },
            required: ['approach', 'rejected_because'],
          },
        },
        blocks: { type: 'string', description: 'The work that waits on this command' },
      },
      required: ['command', 'cwd', 'why_only_way', 'alternatives', 'blocks'],
    },
  },
] satisfies ToolSpec[]

type Ctx = EngineInterface

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const log = ($: Ctx, text: string) => $.ui.log(`[request] ${text}`, { to: 'debug' })
const toolError = (text: string) => ({ result: text, isError: true as const, text })
const ok = (text: string) => ({ result: text, text })
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

async function requests($: Ctx): Promise<ApprovalRequest[]> {
  return (await $.state.get(REQUESTS)).value ?? []
}

async function showStatus($: Ctx) {
  const n = (await requests($)).filter(r => r.status === 'pending').length
  $.ui.status(n ? `${n} approval request${n === 1 ? '' : 's'} pending · /approvals` : undefined)
}

function isAlternatives(v: unknown): v is Alternative[] {
  return Array.isArray(v) && v.length >= 1
    && v.every(a => a && typeof a === 'object' && nonEmpty((a as Alternative).approach) && nonEmpty((a as Alternative).rejected_because))
}

// Control characters (other than tab and newline), C1, and bidi/zero-width
// marks can make a terminal show something other than the bytes that run.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/

// The text the user approves. It carries `command` itself, unaltered, so what
// is shown is what runs; a command with hidden characters also gets an escaped copy.
export function reviewText(r: ApprovalRequest): string {
  return [
    `${r.id}: run this Bash command in ${r.cwd}?`,
    '',
    r.command,
    '',
    ...(HIDDEN.test(r.command) ? [`WARNING: the command contains hidden or control characters. Escaped: ${JSON.stringify(r.command)}`, ''] : []),
    `Requested by: ${r.agentId ? `subagent ${r.agentId}` : 'main session'}`,
    `Why only way: ${r.why_only_way}`,
    'Rejected alternatives:',
    ...r.alternatives.map(a => `  - ${a.approach}: ${a.rejected_because}`),
    `Blocks: ${r.blocks}`,
  ].join('\n')
}

function cap(text: string): string {
  if (text.length <= OUTPUT_CAP) return text
  const half = OUTPUT_CAP / 2
  return `${text.slice(0, half)}\n[... ${text.length - OUTPUT_CAP} characters omitted by the request mod ...]\n${text.slice(-half)}`
}

async function execute($: Ctx, r: ApprovalRequest): Promise<ExecResult> {
  const started = Date.now()
  try {
    const out = await $.process.run(['bash', '-c', r.command], { cwd: r.cwd, timeoutMs: TIMEOUT_MS })
    const cut = (s: string, isTruncated: boolean) => `${cap(s)}${isTruncated ? '\n[... output past 4 MiB dropped by the host ...]' : ''}`
    return {
      exitCode: out.exitCode,
      stdout: cut(out.stdout, out.isStdoutTruncated),
      stderr: cut(out.stderr, out.isStderrTruncated),
      durationMs: Date.now() - started,
    }
  } catch (err) {
    const durationMs = Date.now() - started
    const failure = durationMs >= TIMEOUT_MS - 1000
      ? `timed out after ${TIMEOUT_MS / 1000} s and was killed (${errText(err)})`
      : `could not run: ${errText(err)}`
    return { exitCode: null, stdout: '', stderr: '', failure, durationMs }
  }
}

function outcomeText(r: ApprovalRequest): string {
  const head = `Approval request ${r.id} (request mod) for: ${r.command}\n  cwd: ${r.cwd}`
  if (r.status === 'rejected') {
    return `${head}\nThe user REJECTED it${r.reason ? `: ${r.reason}` : ' (no reason given)'}. Nothing was run. Treat this as the user's denial: halt that line of work.`
  }
  const x = r.result!
  return [
    `${head}\nThe user approved it and the request mod ran it once (${x.durationMs} ms). The approval is spent; running it again needs a new request.`,
    x.failure ? `Run failure: ${x.failure}` : `Exit code: ${x.exitCode}`,
    `stdout:\n${x.stdout || '(empty)'}`,
    `stderr:\n${x.stderr || '(empty)'}`,
    `Resume the blocked work: ${r.blocks}`,
  ].join('\n\n')
}

async function toMain($: Ctx, text: string, ids: string): Promise<boolean> {
  const turnId = (await $.state.get(TURN)).value ?? null
  if (turnId) {
    try {
      const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (!r.deny) return true
      log($, `session.append denied for ${ids} during turn ${turnId}: ${r.deny}; falling back to prompt.submit`)
    } catch (err) {
      log($, `session.append failed for ${ids} during turn ${turnId}: ${errText(err)}; falling back to prompt.submit`)
    }
  }
  try {
    const r = await $.prompt.submit({ text })
    if (!('drop' in r && r.drop)) return true
    log($, `prompt.submit dropped ${ids}: ${r.drop}`)
  } catch (err) {
    log($, `prompt.submit failed for ${ids}: ${errText(err)}`)
  }
  return false
}

// A subagent's request goes back to that subagent (a finished one is resumed,
// as SendMessage does); if that fails, main gets it with the requester named.
async function deliverOne($: Ctx, r: ApprovalRequest): Promise<boolean> {
  const text = outcomeText(r)
  if (r.agentId) {
    try {
      const sent = await $.session.send({ to: { agentId: r.agentId }, text })
      if (sent.isDelivered) return true
      log($, `session.send to ${r.agentId} for ${r.id} not delivered: ${sent.reason}; delivering to main`)
    } catch (err) {
      log($, `session.send to ${r.agentId} for ${r.id} failed: ${errText(err)}; delivering to main`)
    }
    return toMain($, `${text}\n\nThis outcome is for subagent ${r.agentId}, which raised ${r.id}; the request mod could not reach it. Relay this message to it with SendMessage.`, r.id)
  }
  return toMain($, text, r.id)
}

async function deliverUndelivered($: Ctx) {
  const due = (await requests($)).filter(r => (r.status === 'executed' || r.status === 'rejected') && !r.delivered)
  for (const r of due) {
    if (!(await deliverOne($, r))) continue
    await update($, REQUESTS, rs => (rs ?? []).map(x => (x.id === r.id ? { ...x, delivered: true } : x)))
  }
}

const APPROVE = 'Approve and run'
const REJECT = 'Reject'

export const register: Register = on => {
  let walking = false

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
      await $.command.register({ name: 'approvals', description: 'Review the Bash commands the model escalated (Esc skips one; type under Other to reject with a reason)' })
    } catch (err) {
      log($, `command.register(approvals) failed: ${errText(err)}`)
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
    if (!e.agentId) await $.state.set(TURN, null)
    return r
  })

  on('tool.call', { tool: RAISE_TOOL }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    if (!nonEmpty(a.command)) return toolError('Call raise_approval_request with command as the exact denied Bash command.')
    if (typeof a.cwd !== 'string' || !a.cwd.startsWith('/')) return toolError('cwd must be an absolute directory path.')
    if (!nonEmpty(a.why_only_way)) return toolError('why_only_way must say why this command is the only correct way.')
    if (!isAlternatives(a.alternatives)) return toolError('alternatives must be one or more {approach, rejected_because} objects with non-empty strings.')
    if (!nonEmpty(a.blocks)) return toolError('blocks must name the work that waits on this command.')
    let id = ''
    try {
      await update($, REQUESTS, rs => {
        const list = rs ?? []
        id = `R${list.reduce((max, r) => Math.max(max, Number(r.id.slice(1)) || 0), 0) + 1}`
        const r: ApprovalRequest = {
          id, command: a.command as string, cwd: a.cwd as string, why_only_way: a.why_only_way as string,
          alternatives: (a.alternatives as Alternative[]).map(x => ({ approach: x.approach, rejected_because: x.rejected_because })),
          blocks: a.blocks as string, status: 'pending',
          ...(e.agentId ? { agentId: e.agentId } : {}),
        }
        return [...list, r]
      })
    } catch (err) {
      log($, `raise: state write failed for "${a.command}": ${errText(err)}`)
      return toolError(`raise_approval_request failed to queue: ${errText(err)}`)
    }
    $.ui.toast(`${id} approval requested: ${a.command}`)
    await showStatus($)
    return ok(`${id} queued for the user's review (/approvals). The outcome arrives as a message; until then continue with work that does not depend on it (${a.blocks}).`)
  })

  on('command.run', { command: 'approvals' }, async $ => {
    if (walking) return { text: 'request: /approvals is already open.' }
    const pending = (await requests($)).filter(r => r.status === 'pending')
    if (!pending.length) {
      void deliverUndelivered($).catch(err => log($, `redelivery failed: ${errText(err)}`))
      return { text: 'request: no pending approval requests.' }
    }
    walking = true
    void (async () => {
      try {
        for (const queued of pending) {
          const q = (await requests($)).find(x => x.id === queued.id)
          if (!q || q.status !== 'pending') continue
          const text = reviewText(q)
          $.ui.log(text)
          let answer: string
          try {
            answer = await $.ui.ask(text, { options: [APPROVE, REJECT], header: q.id })
          } catch (err) {
            log($, `${q.id} skipped: ${errText(err)}`)
            continue
          }
          if (answer === APPROVE) {
            // Single use: only the walk that moves it out of pending runs it.
            let claimed: ApprovalRequest | undefined
            await update($, REQUESTS, rs => (rs ?? []).map(x => {
              if (x.id !== q.id || x.status !== 'pending') return x
              claimed = { ...x, status: 'running' }
              return claimed
            }))
            if (!claimed) continue
            const run = claimed
            $.ui.toast(`${run.id} running: ${run.command}`)
            const result = await execute($, run)
            await update($, REQUESTS, rs => (rs ?? []).map(x => (x.id === run.id ? { ...x, status: 'executed', result } : x)))
          } else {
            const reason = answer === REJECT ? undefined : answer
            await update($, REQUESTS, rs => (rs ?? []).map(x => (x.id === q.id && x.status === 'pending'
              ? { ...x, status: 'rejected', ...(reason ? { reason } : {}) } : x)))
          }
          await showStatus($)
          await deliverUndelivered($)
        }
      } catch (err) {
        log($, `/approvals walk failed: ${errText(err)}`)
      } finally {
        walking = false
        await showStatus($)
      }
    })()
    return { text: `request: ${pending.length} pending approval request${pending.length === 1 ? '' : 's'}; Esc skips one, text under Other rejects with that reason.` }
  })
}
