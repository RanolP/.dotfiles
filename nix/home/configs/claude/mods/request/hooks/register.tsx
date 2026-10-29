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
      'A review dialog opens for the user at once, as AskUserQuestion does, and the call returns with a request id (R<n>) once they answer or dismiss it; dismissed, the request waits in the approval band above their prompt (or /approvals), so keep working on what does not depend on it. On approval this tool\'s mod runs the exact command once on the host, outside any sandbox, in cwd (bash -c), and the stdout, stderr and exit code arrive as a message; on rejection the rejection and its reason arrive. Re-issuing the denied command would be denied again, so wait for that message.',
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

const isAlternative = (a: unknown): a is Alternative =>
  typeof a === 'object' && a !== null && 'approach' in a && 'rejected_because' in a
  && nonEmpty(a.approach) && nonEmpty(a.rejected_because)

const isAlternatives = (v: unknown): v is Alternative[] => Array.isArray(v) && v.length >= 1 && v.every(isAlternative)

// Control characters (other than tab and newline), C1, and bidi/zero-width
// marks can make a terminal show something other than the bytes that run.
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/

// A fence longer than any backtick run inside keeps the text literal in the
// preview's Markdown.
const fenced = (text: string, info = '') => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}${info}\n${text}\n${fence}`
}
const inlineCode = (text: string) => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const tick = '`'.repeat(longest + 1)
  return `${tick} ${text} ${tick}`
}

// Prose the model wrote (why, alternatives, blocks) is drawn as text with any
// hidden character spelled out, so nothing it holds can restyle the row.
const HIDDEN_ALL = new RegExp(HIDDEN.source, 'gu')
const visible = (text: string) => text.replace(HIDDEN_ALL, c => `\\u{${c.codePointAt(0)?.toString(16)}}`)

// The command as the dialog shows it: a hidden character escaped (a terminal
// would draw a bidi mark as the reordering it is); the escape is exact.
const shownCommand = (r: ApprovalRequest) => (HIDDEN.test(r.command) ? JSON.stringify(r.command) : r.command)

// The review the dialog draws beside its options, as Markdown in a monospace
// box: the command first in a bash fence, so a box cut short loses prose only.
export const reviewPreview = (r: ApprovalRequest): string => [
  fenced(shownCommand(r), 'bash'),
  ...(HIDDEN.test(r.command) ? ['**Holds hidden or control characters; shown JSON-escaped.**'] : []),
  `in ${inlineCode(r.cwd)} · asked by ${r.agentId ? `subagent ${inlineCode(visible(r.agentId))}` : 'the main session'}`,
  '',
  `**Why** ${visible(r.why_only_way)}`,
  ...r.alternatives.map((a, i) => `**${i === 0 ? 'Not' : '   '}** ${visible(a.approach)} — ${visible(a.rejected_because)}`),
  `**Unblocks** ${visible(r.blocks)}`,
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

// Runs an approved request once: the claim makes it single-use, so a second
// approval of the same id (two dialogs on it) runs nothing.
const approveAndRun = async ($: Ctx, id: string) => {
  const run = await claim($, id)
  if (!run) return
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
}

// `delivered`: the caller hands the rejection over itself (the raise's own result).
const reject = async ($: Ctx, id: string, reason: string | undefined, delivered = false) => {
  const written = await update($, REQUESTS, rs => (rs ?? []).map((x): ApprovalRequest => (x.id === id && x.status === 'pending'
    ? { ...x, status: 'rejected', delivered, ...(reason ? { reason } : {}) } : x)))
  return written.find((x): x is Outcome => x.id === id && x.status === 'rejected')
}

// The dialog's options, the harmless one first: the dialog focuses its first
// option, so a stray Enter keeps the request pending. Text typed under the
// dialog's Other denies with that text as the reason.
const LATER = 'Not now'
const DENY = 'Deny'
const APPROVE = 'Approve and run'
const QUESTION = 'Run this command?'

// Terminal cells a string takes: wide (CJK, emoji) counts 2 and a tab 8, so
// the estimate errs tall, which only ever withholds Approve.
const cells = (text: string) => {
  let n = 0
  for (const ch of text) n += ch === '\t' ? 8 : (ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1
  return n
}
const clip = (text: string, room: number) => {
  if (room <= 1) return ''
  if (cells(text) <= room) return text
  let out = ''
  for (const ch of text) {
    if (cells(out + ch) > room - 1) break
    out += ch
  }
  return `${out}…`
}

// One band row: "● 2 approval requests  R3 git push …  [ Review ]", the
// preview cut to what is left of bodyColumns after the fixed parts.
export const bandPreview = (first: ApprovalRequest, room: number): string =>
  clip(`${first.id} ${visible(first.command.replace(/\s*\n\s*/g, ' ⏎ '))}`, room)

// Rows the dialog needs for the whole command: the fenced block wrapped in
// the preview box, assumed to get half the width less its border and padding
// (the options list takes the other side), plus the dialog's own rows
// (chip, question, box border, the hints line) with slack for the fence's
// lines and the surface's chrome. A guess at the engine's layout, made tall.
const DIALOG_CHROME_ROWS = 10
export const dialogRows = (r: ApprovalRequest, columns: number): number => {
  const inner = Math.max(1, Math.floor(columns / 2) - 4)
  const code = shownCommand(r).split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(cells(line) / inner)), 0)
  return code + (HIDDEN.test(r.command) ? 1 : 0) + DIALOG_CHROME_ROWS
}

// The review dialogs open now, by request id (the dialog's chip). The hooks
// below know one by its chip, question and labels: the tool.call hook adds
// the review as each option's preview on the way to the engine, the render
// hook records whether the last drawing could show the whole command; an
// Approve answer counts only when both happened. A module value: a reload
// forgets it, and an answer to a forgotten dialog leaves the request pending.
type OpenDialog = { id: string; position: string; isApprovable: boolean; hasPreview?: true; idleMs?: number }
const openDialogs = new Map<string, OpenDialog>()

type Decision = { kind: 'approve' } | { kind: 'deny'; reason?: string } | { kind: 'none'; why: string }

// One review dialog: the engine's AskUserQuestion through $.ui.ask (a plugin's
// own $.tool.call of it is refused by the host). $.ui.ask takes labels only;
// the tool.call hook below fills in descriptions and the preview. The caller's
// hook awaits it: a $.ui.ask made after that hook returned skips this mod's
// own hooks (seen in the plugin test kit), and with them the preview.
const askOne = async ($: Ctx, r: ApprovalRequest, position: string): Promise<Decision> => {
  const open: OpenDialog = { id: r.id, position, isApprovable: false }
  openDialogs.set(r.id, open)
  try {
    const answer = await $.ui.ask(QUESTION, { options: [LATER, DENY, APPROVE], header: r.id })
      .catch((err: unknown) => { throw new Error(`dismissed: ${errText(err)}`) })
    if (open.idleMs !== undefined) return { kind: 'none', why: `auto-answered after ${open.idleMs} ms idle` }
    if (answer.trim() === '' || answer === LATER) return { kind: 'none', why: 'kept for later' }
    if (answer === APPROVE) {
      if (!open.hasPreview) return { kind: 'none', why: 'Approve was answered on a dialog asked without the review' }
      if (!open.isApprovable) return { kind: 'none', why: 'Approve was answered but the last drawing could not show the whole command' }
      return { kind: 'approve' }
    }
    return { kind: 'deny', ...(answer === DENY ? {} : { reason: answer.trim() }) }
  } finally {
    if (openDialogs.get(r.id) === open) openDialogs.delete(r.id)
  }
}

// The open review an AskUserQuestion carries, if it is one of ours: one
// single-select question with our question, a request's chip, and our labels.
const ourDialog = (questions: readonly unknown[]): OpenDialog | undefined => {
  if (questions.length !== 1) return undefined
  const q = questions[0]
  if (typeof q !== 'object' || q === null) return undefined
  const { header, question, options } = q as { header?: unknown; question?: unknown; options?: unknown }
  if (typeof header !== 'string' || question !== QUESTION || !Array.isArray(options)) return undefined
  const labels = options.map((o: unknown) => (typeof o === 'object' && o !== null && 'label' in o ? o.label : undefined))
  if (!labels.every(l => l === LATER || l === DENY || l === APPROVE) || !labels.includes(LATER)) return undefined
  return openDialogs.get(header)
}

// The review of `ids`, one dialog per request in order, from the calling hook,
// which awaits it. A dialog left undecided (Esc, Not now, idle) ends the walk
// and what is left waits in the band. An approved command runs on after the
// walk and its outcome arrives as a message, as does a rejection, except the
// one for `inBand`, which the walk returns for the raise to answer with: a
// message submitted from inside that tool call would wait for the turn.
type InBand = { kind: 'approved' } | { kind: 'rejected'; outcome: Outcome } | undefined
const walkDialogs = async ($: Ctx, ids: readonly string[], inBand?: string): Promise<InBand> => {
  let answered: InBand
  try {
    for (const id of ids) {
      const all = await requests($)
      const q = all.find(x => x.id === id)
      if (!q || q.status !== 'pending' || openDialogs.has(id)) continue
      const rest = all.filter(x => x.status === 'pending' && x.id !== id).length
      const decision = await askOne($, q, rest ? ` with ${plural(rest, 'other')}` : '').catch((err: unknown): Decision => ({ kind: 'none', why: errText(err) }))
      if (decision.kind === 'none') {
        log($, `${q.id} left pending: ${decision.why}`)
        break
      }
      if (decision.kind === 'approve') {
        if (q.id === inBand) answered = { kind: 'approved' }
        void approveAndRun($, q.id).then(() => deliverUndelivered($))
          .catch((err: unknown) => log($, `${q.id} run failed: ${errText(err)}`))
      } else {
        const rejected = await reject($, q.id, decision.reason, q.id === inBand)
        if (q.id === inBand && rejected) answered = { kind: 'rejected', outcome: rejected }
        else void deliverUndelivered($).catch((err: unknown) => log($, `delivery failed: ${errText(err)}`))
      }
    }
  } catch (err) {
    log($, `review failed: ${errText(err)}`)
  } finally {
    log($, 'review ended')
  }
  return answered
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
    try {
      await $.command.register({ name: 'approvals', description: 'Review the Bash commands the model escalated, one dialog each' })
    } catch (err) {
      log($, `command.register(approvals) failed: ${errText(err)}`)
    }
    // Delivery may submit a prompt, so the session's start never waits on it.
    void settleInterrupted($).catch((err: unknown) => log($, `settling interrupted runs failed: ${errText(err)}`))
    // The band replaced the status line entry; clear one an older version left.
    $.ui.status(undefined)
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
    // The review opens now and this call waits on it, as AskUserQuestion does.
    const answered = await walkDialogs($, [id], id)
    if (answered?.kind === 'rejected') return ok(outcomeText(answered.outcome))
    if (!answered) {
      return ok(`${id} is waiting for the user's review: they closed the dialog, and it stays in the approval band (or /approvals). The outcome arrives as a message; until then continue with work that does not depend on it (${blocks}).`)
    }
    return ok(`${id} was approved by the user and runs once now. Its stdout, stderr and exit code arrive as a message; wait for it before work that depends on it (${blocks}).`)
  })

  on('command.run', { command: 'approvals' }, async $ => {
    // The engine prefixes the plugin's name to this text, so it carries none of its own.
    if (openDialogs.size) return { text: 'the review dialog is already open.' }
    const pending = (await requests($)).filter(r => r.status === 'pending')
    if (!pending.length) {
      void deliverUndelivered($).catch((err: unknown) => log($, `redelivery failed: ${errText(err)}`))
      return { text: 'no pending approval requests.' }
    }
    await walkDialogs($, pending.map(r => r.id))
    return { text: `reviewed ${plural(pending.length, 'pending approval request')}; Esc or Not now left the rest in the band.` }
  })

  // Our review dialog on its way to the engine: $.ui.ask passes labels only,
  // so the options get their descriptions and the review as each option's
  // preview here, in the asked input (a ui.render rewrite may not add previews
  // or drop options). Every other AskUserQuestion passes untouched. On the way
  // back, an idle auto-answer (afkTimeoutMs) is marked so it decides nothing.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const open = ourDialog(e.questions)
    if (!open) return next(e)
    const r = (await requests($)).find(x => x.id === open.id && x.status === 'pending')
    if (!r) return next(e)
    const preview = reviewPreview(r)
    const described: Record<string, string> = {
      [LATER]: `Keep it pending in the band above the prompt${open.position}`,
      [DENY]: 'Tell the model no; type under Other to give the reason',
      [APPROVE]: `Run it once, exactly as shown, with bash -c in ${r.cwd}`,
    }
    // Every option carries the review, so whichever is focused shows the command.
    const q = e.questions[0]
    if (!q) return next(e)
    const options = q.options.map(o => ({ ...o, description: described[o.label] ?? '', preview }))
    open.hasPreview = true
    const out = await next({ ...e, questions: [{ ...q, options }] })
    if ('result' in out && out.result && typeof out.result === 'object') {
      const idle = (out.result as { afkTimeoutMs?: unknown }).afkTimeoutMs
      if (typeof idle === 'number') open.idleMs = idle
    }
    return out
  })

  // Our review dialog as drawn: Approve counts only while the whole command
  // fits the surface. A rewrite may change descriptions but not the options,
  // so when it does not fit Approve stays listed and its description says it
  // will not run and why.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const open = ourDialog(e.props.questions)
    if (!open) return next(e)
    const r = (await requests($)).find(x => x.id === open.id && x.status === 'pending')
    const needs = r && e.viewport ? dialogRows(r, e.viewport.columns) : undefined
    const fits = needs !== undefined && e.viewport !== undefined && needs <= e.viewport.rows
    open.isApprovable = fits
    if (fits) return next(e)
    const why = !r ? 'it is no longer pending'
      : !e.viewport || needs === undefined ? 'this surface did not report its size'
        : `it needs ${needs} rows and the window has ${e.viewport.rows}; enlarge it, then Review from the band`
    const q = e.props.questions[0] as { options: { label: string; description?: string }[] }
    const options = q.options.map(o => (o.label === APPROVE ? { ...o, description: `Unavailable, runs nothing: ${why}` } : o))
    return next({ ...e, props: { ...e.props, questions: [{ ...q, options }] } })
  })

  // Review opens the dialogs from this press hook, which awaits them, rather
  // than from the Button's closure, whose $ outlives its drawing's hook (see
  // askOne).
  on('ui.press', { plugin: 'request', element: 'review' }, async ($, e, next) => {
    const pending = (await requests($)).filter(r => r.status === 'pending')
    if (!openDialogs.size) await walkDialogs($, pending.map(r => r.id))
    return next(e)
  })

  // The band: one row while anything waits on the user, composed above what
  // the plugins beneath draw (ask-later's row) rather than hiding it. Review
  // reopens the dialogs.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const all = await requests($)
    const pending = all.filter(r => r.status === 'pending')
    const undelivered = all.filter(isUndelivered).length
    if (!pending.length && !undelivered) return next(e)
    const below = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const first = pending[0]
    const row = first
      ? (() => {
        const head = `● ${plural(pending.length, 'approval request')}  `
        // "[ Review ]" plus the gaps around the preview.
        const room = e.props.bodyColumns - cells(head) - ('Review'.length + 4) - 2
        return (
          <Box key="request-band" flexDirection="row">
            <Text color="yellow" bold>{head}</Text>
            <Text dimColor wrap="truncate-end">{bandPreview(first, room)}</Text>
            <Text>  </Text>
            <Button key="review" label="Review" hotkey="r" variant="primary" onPress={() => {}} />
          </Box>
        )
      })()
      : (
        <Box key="request-band" flexDirection="row">
          <Text color="yellow" bold>{`● ${plural(undelivered, 'result')} undelivered  `}</Text>
          <Button key="redeliver" label="Redeliver" onPress={() => void deliverUndelivered($).catch((err: unknown) => log($, `redelivery failed: ${errText(err)}`))} />
        </Box>
      )
    return (
      <Box flexDirection="column">
        {row}
        {below}
      </Box>
    )
  })
}
