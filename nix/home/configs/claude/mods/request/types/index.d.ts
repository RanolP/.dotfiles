export type Alternative = { approach: string; rejected_because: string }

export type ExecResult = {
  /** null when the child did not exit on its own (timeout, or it could not start). */
  exitCode: number | null
  stdout: string
  stderr: string
  /** Why the run ended abnormally: the timeout, or the start failure. */
  failure?: string
  durationMs: number
}

export type ApprovalRequest = {
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
  /** `running`: approved and claimed for its single execution. */
  status: 'pending' | 'running' | 'executed' | 'rejected'
  reason?: string
  result?: ExecResult
  /** The outcome has reached the requester (or main, as the fallback). */
  delivered?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    /** `turnId`: the running main turn, null while idle; picks session.append vs prompt.submit for delivery. */
    request: { requests: ApprovalRequest[]; turnId: string | null }
  }
}
