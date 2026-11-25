export type WayseekerInstructionsInput = {
  /** The session whose ledger renders; absent, the calling session. */
  sessionId?: string
  /** A subagent's transcript; absent, the main thread. */
  agentId?: string
}

export type Wayseeker = {
  /** The "## user instructions" section (with "## raises" when any) rendered from the session's ledger. */
  instructions(input?: WayseekerInstructionsInput): Promise<string>
}

declare module 'claude-code' {
  interface EngineInterface {
    wayseeker: Wayseeker
  }
}
