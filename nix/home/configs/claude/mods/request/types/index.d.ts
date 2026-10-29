export type Alternative = { approach: string; rejected_because: string }

export type ExecResult = {
  /** null when the child did not exit on its own (timeout, start failure, interruption). */
  exitCode: number | null
  stdout: string
  stderr: string
  /** Why the run ended abnormally: the timeout, the start failure, or an interruption. */
  failure?: string
  durationMs: number
}

export type RequestBase = {
  /** `R<n>`, unique within the session. */
  id: string
  /** The exact Bash command; shown to the user and executed byte-for-byte. */
  command: string
  /** Absolute directory the command runs in. */
  cwd: string
  why_only_way: string
  alternatives: Alternative[]
  blocks: string
  /** The loop that raised it: a subagent's id; absent for main. */
  agentId?: string
}

/**
 * `running`: approved and claimed for its single execution; `runId` names the claim that may run it.
 * `executed`: `runId` names the run that produced `result`; absent when settled as interrupted.
 * `delivered`: the outcome reached the requester (or main, as the fallback).
 */
export type ApprovalRequest = RequestBase & (
  | { status: 'pending' }
  | { status: 'running'; runId: string }
  | { status: 'executed'; result: ExecResult; delivered: boolean; runId?: string }
  | { status: 'rejected'; reason?: string; delivered: boolean }
)

declare module 'claude-code' {
  interface PluginState {
    /** `turnId`: the running main turn, null while idle; picks session.append vs prompt.submit for delivery. */
    /**
     * `viewing`: the pending request the expanded band shows; null (or a decided id) shows the first pending.
     * `expanded`: the band is the review rather than its one collapsed row.
     */
    request: { requests: ApprovalRequest[]; turnId: string | null; viewing: string | null; expanded: boolean }
  }
}
