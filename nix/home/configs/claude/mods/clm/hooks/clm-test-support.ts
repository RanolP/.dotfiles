import { mock } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, SessionMessage, SessionStartInput, ToolCallInput, TurnCompleteInput } from 'claude-code'

import { boardHtml } from './board'
import { chooseContinuation, clmStatus, register, resetUserWorkflow, restoreFailedContinuation, sessionIssues, submitWithRecovery, trackIssue, TASK_TOOL } from './register'
import { INTENT_SYSTEM } from './intent'
import type { ClmWorkflow } from '../types'

import { focusOf, isRecord, parseLog, snapshot, toEvents, type Issue, type Payload } from './tracker'

export const M = (role: 'user' | 'assistant', text: string, extra: Partial<SessionMessage> = {}): SessionMessage =>
  ({ ...extra, role, text, toolUses: extra.toolUses ?? [] } satisfies SessionMessage)
export const intentReply = (fields: Record<string, unknown> = {}) => JSON.stringify({
  intent: 'continue', target: null, title: null, rule: null, deferred: [], raised: [], resolved: [], plan: 'none', ...fields,
})
export const use = (id: string, tool: string) => M('assistant', '', { toolUses: [{ tool_use_id: id, tool, input: { id }, text: 'ok' }] })
export const res = (id: string, text: string) => M('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] })
const BIG = 'x'.repeat(4000) // ~1667 tokens
const MID = 'y'.repeat(800) // ~334 tokens

export const ROWS = [
  M('user', 'please investigate the build'), use('tu_a', 'Bash'), res('tu_a', 'log: make fails at a.ts:12 ' + BIG), M('assistant', 'make fails at a.ts:12'),
  M('user', 'now fix it'), use('tu_b', 'Edit'), res('tu_b', 'edited ' + MID), M('assistant', 'fixed a.ts:12'),
  M('user', 'run tests'), use('tu_c', 'Bash'), res('tu_c', 'pass: all 12 tests passed ' + BIG), M('assistant', 'tests pass'),
  M('user', 'commit it'), M('assistant', 'done'),
]
export const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } satisfies TurnCompleteInput
export const OPTS = { options: {} }
export const LOG_FILE = '/home/t/.claude-work/plans/clm-s1.log.jsonl'
export const promptInput = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false } satisfies PromptSubmitInput)
export const turnInput = (turnId: string, extra: Partial<TurnCompleteInput> = {}) => ({ ...TURN, ...extra, turnId } satisfies TurnCompleteInput)
export const commandInput = (command: string, args = '') => ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } satisfies CommandRunInput)
export const workflow = (fields: Partial<ClmWorkflow> = {}): ClmWorkflow => ({
  resumeRequest: null, lastSubmittedTurn: null, activeTurnId: null,
  promptSeq: 0, focusAppliedSeq: 0, ...fields,
})
export type State = { rows: SessionMessage[]; agentRows?: Record<string, SessionMessage[]>; sessionMessagesBlock?: () => Promise<void>; turnReplies?: string[]; intentReplies?: (string | Error)[]; intentBlocks?: (() => Promise<void>)[]; usage?: any; sessionId?: string; nextSessionId?: string; storeKeysBlock?: () => Promise<void>; env?: Record<string, string | undefined>; cwd?: string; processRun?: (argv: string[], options?: { cwd?: string; timeoutMs?: number }) => { exitCode: number; stdout: string; stderr: string } | undefined; fsWriteBlock?: (path: string, text: string) => Promise<void>; promptDrops?: string[]; sendResult?: (to: unknown) => { isDelivered: true } | { isDelivered: false; reason: string } }
const readFixtureState = (files: Record<string, string>, path: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(files[path] ?? '{}')
    return isRecord(value) ? value : {}
  } catch { return {} }
}
export function bottoms(on: any, s: State) {
  const clock = mock.clock(on, { now: Date.parse('2026-10-06T00:00:00Z') })
  const engineStore: Record<string, unknown> = {}
  const files: Record<string, string> = {}
  const sessionStorePrefixes = new Set(['address-index', 'agent-task-roots', 'agent-task-step-claims', 'headAttachments', 'held', 'issue-addresses', 'ledger', 'ledger-snapshots', 'pending', 'request-prompt-seq', 'requests', 'stepped', 'topics', 'transcript-path', 'transcript-rows'])
  const sessionStorePath = (key: string) => {
    const separator = key.indexOf(':')
    if (separator < 0 || !sessionStorePrefixes.has(key.slice(0, separator))) return undefined
    const session = key.slice(separator + 1).split(':', 1)[0]
    return session ? `/home/t/.claude-work/plans/clm-${session}.state.json` : undefined
  }
  const store = new Proxy(engineStore, {
    get(target, property) {
      if (typeof property !== 'string') return Reflect.get(target, property)
      const path = sessionStorePath(property)
      if (path) {
        const state = readFixtureState(files, path)
        return Object.prototype.hasOwnProperty.call(state, property) ? state[property] : undefined
      }
      return Reflect.get(target, property)
    },
    set(target, property, value) {
      if (typeof property !== 'string') return Reflect.set(target, property, value)
      const path = sessionStorePath(property)
      if (!path) return Reflect.set(target, property, value)
      const state = readFixtureState(files, path)
      state[property] = value
      files[path] = JSON.stringify(state)
      delete target[property]
      return true
    },
    deleteProperty(target, property) {
      if (typeof property !== 'string') return Reflect.deleteProperty(target, property)
      const path = sessionStorePath(property)
      if (!path) return Reflect.deleteProperty(target, property)
      const state = readFixtureState(files, path)
      delete state[property]
      files[path] = JSON.stringify(state)
      delete target[property]
      return true
    },
  })
  const seen = { clock, store, engineStore, files, dirs: new Set<string>(), fileReads: {} as Record<string, number>, sessionMessageReads: 0, usageReads: 0, intentPrompts: [] as string[], submissions: [] as { text: string; asUser?: true }[], turnPrompts: [] as string[], logs: [] as string[], taskCalls: [] as ToolCallInput[], runs: [] as string[][], sends: [] as { to: unknown; text: string }[] }
  on('store.get', (_$: any, e: any) => ({ value: seen.engineStore[e.key] }))
  on('store.set', (_$: any, e: any) => { seen.engineStore[e.key] = e.value; return { value: undefined } })
  on('store.delete', (_$: any, e: any) => { delete seen.engineStore[e.key]; return { value: undefined } })
  on('store.keys', async () => { await s.storeKeysBlock?.(); return { value: Object.keys(seen.engineStore) } })
  on('session.id', () => ({ value: s.sessionId ?? 's1' }))
  on('session.messages', async (_$: any, e: any) => { seen.sessionMessageReads++; await s.sessionMessagesBlock?.(); return { value: e.agentId === undefined ? s.rows : s.agentRows?.[e.agentId] ?? [] } })
  on('session.usage', () => { seen.usageReads++; return { value: s.usage ?? { startedAt: 0, context: { window: 200000, tokens: 6000 }, rateLimits: [] } } })
  on('env.get', (_$: any, e: any) => ({ value: s.env?.[e.name] ?? (e.name === 'HOME' ? '/home/t' : undefined) }))
  on('fs.exists', (_$: any, e: any) => ({ value: seen.dirs.has(e.path) || e.path in seen.files || Object.keys(seen.files).some(f => f.startsWith(`${e.path}/`)) }))
  on('fs.list', (_$: any, e: any) => ({
    value: [
      ...[...seen.dirs].filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/')).map(f => ({ name: f.slice(e.path.length + 1), kind: 'dir', size: 0, mtimeMs: 0, isLink: false })),
      ...Object.keys(seen.files).filter(f => f.startsWith(`${e.path}/`) && !f.slice(e.path.length + 1).includes('/')).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: seen.files[f]!.length, mtimeMs: 0, isLink: false })),
    ],
  }))
  on('session.cwd', () => ({ value: s.cwd ?? '/work/repo' }))
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv]
    seen.runs.push(argv)
    const custom = s.processRun?.(argv, e.options)
    if (custom) return { value: custom }
    const mkdirs = (path: string) => {
      let current = ''
      for (const part of path.split('/').filter(Boolean)) { current += `/${part}`; seen.dirs.add(current) }
    }
    const move = (from: string, to: string) => {
      for (const path of [...seen.dirs].filter(path => path === from || path.startsWith(`${from}/`))) {
        seen.dirs.delete(path)
        seen.dirs.add(`${to}${path.slice(from.length)}`)
      }
      for (const [path, value] of Object.entries(seen.files)) if (path === from || path.startsWith(`${from}/`)) {
        delete seen.files[path]
        seen.files[`${to}${path.slice(from.length)}`] = value
      }
    }
    if (argv[0] === 'mkdir' && argv[1] === '-p') mkdirs(argv.at(-1)!)
    if (argv[0] === 'mkdir' && argv[1] !== '-p') {
      if (seen.dirs.has(argv[1]!)) return { value: { exitCode: 1, stdout: '', stderr: 'File exists' } }
      mkdirs(argv[1]!)
    }
    if (argv[0] === 'mv') {
      if (!seen.dirs.has(argv[1]!) && !(argv[1]! in seen.files)) return { value: { exitCode: 1, stdout: '', stderr: 'No such file' } }
      move(argv[1]!, argv[2]!)
    }
    if (argv[0] === 'ln') {
      if (!(argv[1]! in seen.files) || argv[2]! in seen.files) return { value: { exitCode: 1, stdout: '', stderr: 'File exists' } }
      seen.files[argv[2]!] = seen.files[argv[1]!]!
    }
    if (argv[0] === 'rm') {
      const path = argv.at(-1)!
      for (const dir of [...seen.dirs]) if (dir === path || dir.startsWith(`${path}/`)) seen.dirs.delete(dir)
      for (const key of Object.keys(seen.files)) if (key === path || key.startsWith(`${path}/`)) delete seen.files[key]
    }
    const gitArgs = argv[0] === 'git' && argv[1] === '-C' ? argv.slice(3) : argv[0] === 'git' ? argv.slice(1) : []
    let stdout = ''
    if (argv[0] === 'realpath') stdout = `${argv[1]}\n`
    else if (gitArgs[0] === 'remote' && gitArgs[1] === 'get-url') stdout = 'git@github.com:o/repo.git\n'
    else if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--show-toplevel') stdout = '/work/repo\n'
    else if (gitArgs[0] === 'rev-parse' && gitArgs[1] === '--abbrev-ref') stdout = 'main\n'
    else if (gitArgs[0] === 'rev-parse' && gitArgs[1] === 'HEAD') stdout = `${'a'.repeat(40)}\n`
    else if (gitArgs[0] === 'merge-base') stdout = `${'b'.repeat(40)}\n`
    else if (argv[0] === 'sysctl' && argv.includes('vm.loadavg')) stdout = '{ 1.0 1.0 1.0 }\n'
    else if (argv[0] === 'sysctl' && argv.includes('hw.ncpu')) stdout = '8\n'
    return { value: { exitCode: 0, stdout, stderr: '' } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('fs.read', (_$: any, e: any) => { seen.fileReads[e.path] = (seen.fileReads[e.path] ?? 0) + 1; return { value: seen.files[e.path] } })
  on('fs.write', async (_$: any, e: any) => { await s.fsWriteBlock?.(e.path, e.text); seen.files[e.path] = e.text; return { value: undefined } })
  on('model.complete', async (_$: any, e: any) => {
    if (e.system === INTENT_SYSTEM) {
      seen.intentPrompts.push(e.prompt)
      const text = s.intentReplies?.shift() ?? intentReply()
      await s.intentBlocks?.shift()?.()
      if (text instanceof Error) return { value: { isAnswered: false, reason: text.message } }
      return { value: { isAnswered: true, text, usage: {} } }
    }
    seen.turnPrompts.push(e.prompt)
    return { value: { isAnswered: true, text: s.turnReplies?.shift() ?? '<changes></changes>', usage: {} } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', (_$: any, e: any) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('session.send', (_$: any, e: any) => {
    seen.sends.push({ to: e.to, text: e.text })
    return s.sendResult?.(e.to) ?? { isDelivered: true }
  })
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('tool.register', (_$: any, e: any) => ({ value: { tool: e.name } }))
  on('prompt.submit', (_$: any, e: any) => {
    seen.submissions.push({ text: e.text, ...(e.origin?.asUser ? { asUser: true as const } : {}) })
    const drop = s.promptDrops?.shift()
    if (drop !== undefined) return { drop }
    return { text: e.text, context: e.context }
  })
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.end', (_$: any, e: any) => {
    if (e.reason === 'clear' && s.nextSessionId) s.sessionId = s.nextSessionId
    return { sessionId: e.sessionId }
  })
  on('turn.complete', async ($: any) => {
    return { text: '' }
  })
  return seen
}
export const logEvents = (seen: { files: Record<string, string> }) => (seen.files[LOG_FILE] ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))


export type On = Parameters<TestBody>[1]
export type Seen = ReturnType<typeof bottoms>
export type PanelReply = { success: boolean; error?: string }
// Panel tasks numbered panel-1, panel-2, ...; each TaskUpdate is answered by `reply`.
export function panelHandlers(on: On, seen: Seen, reply: (taskId: string) => PanelReply = () => ({ success: true })) {
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => {
    seen.taskCalls.push(e)
    return { result: { task: { id: `panel-${++n}`, subject: e.subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => {
    seen.taskCalls.push(e)
    return { result: { taskId: e.taskId, updatedFields: [], ...reply(e.taskId) } }
  })
}
export const TRACKER = '/home/t/.claude-work/tracker/events/s1.jsonl'
export function seedTracker(seen: { files: Record<string, string> }, payloads: Payload[]) {
  const events = toEvents(payloads, { session: 's1', repo: 'github.com/o/repo', cwd: '/work/repo' }, 0, '2026-10-06T00:00:00.000Z')
  seen.files[TRACKER] = `${events.map(event => JSON.stringify(event)).join('\n')}\n`
}
// --- quote matching, drops, directive noise, KST ------------------------------

export const issueAt = (issues: readonly { id: string }[], n: number): string => {
  const issue = issues[n]
  if (!issue) throw new Error(`no issue at ${n}; the tracker holds ${issues.length}`)
  return issue.id
}

// Regression caught: a quote copied from a clipped tool result kept the clip's `…`, or came from text past the clip, and was rejected, so 핵심 사실·경로 stayed empty.

export const runClm = ($: { command: { run(e: { command: string; args: string }): Promise<unknown> } }, args: string) => $.command.run({ command: 'clm', args })
export const waitForLog = async (seen: { logs: string[] }, message: string) => {
  for (let i = 0; i < 50 && !seen.logs.includes(message); i++)
    await new Promise(resolve => setTimeout(resolve, 5))
}
