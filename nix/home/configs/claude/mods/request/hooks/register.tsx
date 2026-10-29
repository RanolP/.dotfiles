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
      'Escalate one shell command that was denied, when that command is the only correct way to do the work: for Claude, a Bash call the auto-mode permission classifier denied; for a codex worker, a command its sandbox blocked.',
      'Returns at once with a request id (R<n>); keep working on what does not depend on it.',
      'The user reviews it with /approvals. On approval this tool\'s mod runs the exact command once on the host, outside any sandbox, in cwd (bash -c), and the stdout, stderr and exit code arrive as a message; on rejection the rejection and its reason arrive. Re-issuing the denied command would be denied again, so wait for that message.',
      'Use it only for a classifier or sandbox denial: a denial, rejection or "stop"/"cancel" from the user still halts that line of work.',
      'Each approval runs the command once; running it again needs a new request.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The exact command that was denied, byte for byte, as bash -c will run it' },
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
type Outcome = Extract<ApprovalRequest, { status: 'executed' | 'rejected' }>

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))
const log = ($: Ctx, text: string) => $.ui.log(`[request] ${text}`, { to: 'debug' })
const toolError = (text: string) => ({ result: text, isError: true as const, text })
const ok = (text: string) => ({ result: text, text })
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const isUndelivered = (r: ApprovalRequest): r is Outcome =>
  (r.status === 'executed' || r.status === 'rejected') && !r.delivered

const requests = async ($: Ctx): Promise<ApprovalRequest[]> => (await $.state.get(REQUESTS)).value ?? []

const showStatus = async ($: Ctx) => {
  const all = await requests($)
  const pending = all.filter(r => r.status === 'pending').length
  const undelivered = all.filter(isUndelivered).length
  const parts = [
    ...(pending ? [`${plural(pending, 'approval request')} pending`] : []),
    ...(undelivered ? [`${plural(undelivered, 'result')} undelivered`] : []),
  ]
  $.ui.status(parts.length ? `${parts.join(' · ')} · /approvals` : undefined)
}

const isAlternative = (a: unknown): a is Alternative =>
  typeof a === 'object' && a !== null && 'approach' in a && 'rejected_because' in a
  && nonEmpty(a.approach) && nonEmpty(a.rejected_because)

const isAlternatives = (v: unknown): v is Alternative[] => Array.isArray(v) && v.length >= 1 && v.every(isAlternative)

// Control characters (other than tab and newline), C1, and bidi/zero-width
// marks can make a terminal show something other than the bytes that run.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/

// A fence longer than any backtick run inside keeps the text literal whether
// the dialog renders Markdown or plain text.
const fenced = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

// The text the user approves. It carries `command` itself, unaltered, so what
// is shown is what runs; a command with hidden characters also gets an escaped copy.
export const reviewText = (r: ApprovalRequest): string => [
  `${r.id}: run this Bash command?`,
  'cwd:',
  fenced(r.cwd),
  'command:',
  fenced(r.command),
  ...(HIDDEN.test(r.command) ? ['WARNING: the command contains hidden or control characters. Escaped:', fenced(JSON.stringify(r.command))] : []),
  `Requested by: ${r.agentId ? `subagent ${r.agentId}` : 'main session'}`,
  `Why only way: ${r.why_only_way}`,
  'Rejected alternatives:',
  ...r.alternatives.map(a => `  - ${a.approach}: ${a.rejected_because}`),
  `Blocks: ${r.blocks}`,
].join('\n')

const cap = (text: string): string => {
  if (text.length <= OUTPUT_CAP) return text
  const half = OUTPUT_CAP / 2
  return `${text.slice(0, half)}\n[... ${text.length - OUTPUT_CAP} characters omitted by the request mod ...]\n${text.slice(-half)}`
}

const execute = async ($: Ctx, r: ApprovalRequest): Promise<ExecResult> => {
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

const outcomeText = (r: Outcome): string => {
  const head = `Approval request ${r.id} (request mod) for: ${r.command}\n  cwd: ${r.cwd}`
  if (r.status === 'rejected') {
    return `${head}\nThe user REJECTED it${r.reason ? `: ${r.reason}` : ' (no reason given)'}. Nothing was run. Treat this as the user's denial: halt that line of work.`
  }
  const x = r.result
  return [
    `${head}\nThe user approved it and the request mod ran it once (${x.durationMs} ms). The approval is spent; running it again needs a new request.`,
    x.failure ? `Run failure: ${x.failure}` : `Exit code: ${x.exitCode}`,
    `stdout:\n${x.stdout || '(empty)'}`,
    `stderr:\n${x.stderr || '(empty)'}`,
    `Resume the blocked work: ${r.blocks}`,
  ].join('\n\n')
}

const toMain = async ($: Ctx, text: string, ids: string): Promise<boolean> => {
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
const deliverOne = async ($: Ctx, r: Outcome): Promise<boolean> => {
  const text = outcomeText(r)
  if (!r.agentId) return toMain($, text, r.id)
  try {
    const sent = await $.session.send({ to: { agentId: r.agentId }, text })
    if (sent.isDelivered) return true
    log($, `session.send to ${r.agentId} for ${r.id} not delivered: ${sent.reason}; delivering to main`)
  } catch (err) {
    log($, `session.send to ${r.agentId} for ${r.id} failed: ${errText(err)}; delivering to main`)
  }
  return toMain($, `${text}\n\nThis outcome is for subagent ${r.agentId}, which raised ${r.id}; the request mod could not reach it. Relay this message to it with SendMessage.`, r.id)
}

const deliveryPass = async ($: Ctx) => {
  for (const r of (await requests($)).filter(isUndelivered)) {
    if (!(await deliverOne($, r))) continue
    await update($, REQUESTS, rs => (rs ?? []).map(x => (x.id === r.id && isUndelivered(x) ? { ...x, delivered: true } : x)))
  }
}

// Passes run one at a time: two overlapping passes (a walk and a session
// start's settling) would both read an outcome as undelivered and send it twice.
let deliveries: Promise<void> = Promise.resolve()
const deliverUndelivered = ($: Ctx): Promise<void> => {
  const pass = deliveries.then(() => deliveryPass($))
  deliveries = pass.catch(() => undefined)
  return pass
}

const INTERRUPTED = 'interrupted (session ended or mod reloaded) while running; it may or may not have completed'

// runIds this module instance is executing right now. A reload starts it empty,
// so a session.start mid-run (a /clear) leaves a live run alone while an orphan
// from a reload or exit is still settled.
const liveRuns = new Set<string>()
const withoutRun = ({ runId: _, ...rest }: ApprovalRequest & { runId?: string }) => rest
const isOrphan = (r: ApprovalRequest) => r.status === 'running' && !liveRuns.has(r.runId)

// A run cut off by a reload or exit is settled as interrupted, never re-run.
const settleInterrupted = async ($: Ctx) => {
  const rs = await requests($)
  if (!rs.some(isOrphan)) return
  await update($, REQUESTS, list => (list ?? []).map((x): ApprovalRequest => (isOrphan(x)
    ? { ...withoutRun(x), status: 'executed', delivered: false, result: { exitCode: null, stdout: '', stderr: '', failure: INTERRUPTED, durationMs: 0 } }
    : x)))
  await deliverUndelivered($)
}

// Single use: only the walk whose runId lands on the pending request runs it.
const claim = async ($: Ctx, id: string): Promise<ApprovalRequest | undefined> => {
  const runId = `${id}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const written = await update($, REQUESTS, rs => (rs ?? []).map((x): ApprovalRequest => (x.id === id && x.status === 'pending' ? { ...x, status: 'running', runId } : x)))
  const claimed = written.find(x => x.id === id && x.status === 'running' && x.runId === runId)
  if (claimed) liveRuns.add(runId)
  return claimed
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
    // Delivery may submit a prompt, so the session's start never waits on it.
    void settleInterrupted($).then(() => showStatus($)).catch((err: unknown) => log($, `settling interrupted runs failed: ${errText(err)}`))
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
    const { command, cwd, why_only_way, alternatives, blocks } = e
    if (!nonEmpty(command)) return toolError('Call raise_approval_request with command as the exact denied Bash command.')
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || /[\n\r]/.test(cwd) || HIDDEN.test(cwd)) {
      return toolError('cwd must be an absolute directory path with no control, bidi or zero-width characters.')
    }
    if (!nonEmpty(why_only_way)) return toolError('why_only_way must say why this command is the only correct way.')
    if (!isAlternatives(alternatives)) return toolError('alternatives must be one or more {approach, rejected_because} objects with non-empty strings.')
    if (!nonEmpty(blocks)) return toolError('blocks must name the work that waits on this command.')
    const base = {
      command, cwd, why_only_way, blocks,
      alternatives: alternatives.map(a => ({ approach: a.approach, rejected_because: a.rejected_because })),
      ...(e.agentId ? { agentId: e.agentId } : {}),
    }
    const written = await update($, REQUESTS, rs => {
      const list = rs ?? []
      const n = list.reduce((max, r) => Math.max(max, Number(r.id.slice(1)) || 0), 0) + 1
      return [...list, { ...base, id: `R${n}`, status: 'pending' as const }]
    }).catch((err: unknown) => new Error(errText(err)))
    if (written instanceof Error) {
      log($, `raise: state write failed for "${command}": ${written.message}`)
      return toolError(`raise_approval_request failed to queue: ${written.message}`)
    }
    // The change appends last, so the written list ends with this request.
    const id = written.at(-1)?.id ?? '(unknown)'
    $.ui.toast(`${id} approval requested: ${command}`)
    await showStatus($)
    return ok(`${id} queued for the user's review (/approvals). The outcome arrives as a message; until then continue with work that does not depend on it (${blocks}).`)
  })

  on('command.run', { command: 'approvals' }, async $ => {
    if (walking) return { text: 'request: /approvals is already open.' }
    const pending = (await requests($)).filter(r => r.status === 'pending')
    if (!pending.length) {
      void deliverUndelivered($).then(() => showStatus($), err => log($, `redelivery failed: ${errText(err)}`))
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
          const answer = await $.ui.ask(text, { options: [APPROVE, REJECT], header: q.id }).catch((err: unknown) => {
            log($, `${q.id} skipped: ${errText(err)}`)
            return undefined
          })
          if (answer === undefined) continue
          if (answer === APPROVE) {
            const run = await claim($, q.id)
            if (!run) continue
            const runId = run.status === 'running' ? run.runId : ''
            try {
              $.ui.toast(`${run.id} running: ${run.command}`)
              const result = await execute($, run)
              // Only the run that claimed it completes it; a settled entry keeps its report, sent once.
              const written = await update($, REQUESTS, rs => (rs ?? []).map((x): ApprovalRequest => (x.id === run.id && x.status === 'running' && x.runId === runId
                ? { ...x, status: 'executed', result, delivered: false } : x)))
              if (!written.some(x => x.id === run.id && x.status === 'executed' && x.runId === runId)) {
                log($, `${run.id} finished after it was settled as interrupted (exit ${result.exitCode ?? result.failure}); its result was not delivered`)
              }
            } finally {
              liveRuns.delete(runId)
            }
          } else {
            const reason = answer === REJECT ? undefined : answer
            await update($, REQUESTS, rs => (rs ?? []).map((x): ApprovalRequest => (x.id === q.id && x.status === 'pending'
              ? { ...x, status: 'rejected', delivered: false, ...(reason ? { reason } : {}) } : x)))
          }
          await deliverUndelivered($)
        }
      } catch (err) {
        log($, `/approvals walk failed: ${errText(err)}`)
      } finally {
        walking = false
        await showStatus($)
      }
    })()
    return { text: `request: ${plural(pending.length, 'pending approval request')}; Esc skips one, text under Other rejects with that reason.` }
  })
}
