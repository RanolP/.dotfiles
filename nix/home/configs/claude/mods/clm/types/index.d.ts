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

export type ClmLaterItem = {
  text: string
  issue?: string
}

export type ClmWorkflow = {
  later: ClmLaterItem[]
  resumeRequest: { text: string } | null
  lastSubmittedTurn: string | null
  activeTurnId: string | null
  promptSeq: number
  focusAppliedSeq: number
  replayed: { issue: string } | null
}

export type ClmStatus = {
  focus: { id: string; title: string; status: 'todo' | 'doing' | 'done' | 'question' | 'uncertain' | 'dropped' } | null
  stackDepth: number
  pending: Array<{ id: string; title: string }>
  agents: Array<{ agentId: string; taskId: string; title: string; status: 'todo' | 'doing' | 'done' | 'question' | 'uncertain' | 'dropped' }>
  later: ClmLaterItem[]
  resumeRequest: { text: string } | null
  lastFoldAt: number | null
  ledgerPath: string
  openIssues: number
}

export type ClmRecallInput = { address: string }
export type ClmTaskInput = {
  id?: string
  title?: string
  status: 'doing' | 'done' | 'uncertain' | 'dropped'
  note?: string
  evidence?: { ref: string; quote: string }
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
  interface McpToolInputs {
    'mcp__clm__clm_recall': ClmRecallInput
    'mcp__clm__clm_task': ClmTaskInput
  }

  interface PluginState {
    clm: { workflow: ClmWorkflow }
  }

  interface EngineInterface {
    clm: Clm
  }
}
