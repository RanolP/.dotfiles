export type ClmBoardIssue = {
  id: string
  title: string
  status: 'todo' | 'doing' | 'done' | 'question' | 'dropped'
  repo: string
  branch?: string
  updated: string
}

export type ClmIssueStatus = ClmBoardIssue['status']

export type ClmIssue = {
  id: string
  title: string
  status: ClmIssueStatus
  updated: string
}

export type ClmTrackInput = {
  title: string
  status: ClmIssueStatus
  issue?: string
}

export type ClmIssueQuery = {
  issue?: string
  status?: ClmIssueStatus
}

export type ClmWorkflow = {
  later: string[]
  resumeRequest: { text: string } | null
  lastSubmittedTurn: string | null
  activeTurnId: string | null
}

export type ClmStatus = {
  later: string[]
  resumeRequest: { text: string } | null
  lastFoldAt: number | null
  ledgerPath: string
  openIssues: number
}

export type Clm = {
  /** Create an issue in this session, or set an existing issue's status. */
  track(input: ClmTrackInput): Promise<ClmIssue>
  /** Read this session's issues, optionally filtered by id and status. */
  issues(query?: ClmIssueQuery): Promise<ClmIssue[]>
  /** Queue a continuation prompt for clm's turn-end arbiter. */
  resume(input: { text: string }): Promise<'submitted' | 'queued'>
  /** Read the queue, pending resume request, last fold, ledger path, and open issue count. */
  status(): Promise<ClmStatus>
}

declare module 'claude-code' {
  interface PluginState {
    clm: { workflow: ClmWorkflow }
  }

  interface EngineInterface {
    clm: Clm
  }
}
