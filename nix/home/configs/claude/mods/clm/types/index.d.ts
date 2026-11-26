export type ClmBoardIssue = {
  id: string
  title: string
  status: 'todo' | 'doing' | 'ready-to-land' | 'done' | 'question' | 'dropped'
  repo: string
  branch?: string
  updated: string
  priority?: number
  ready?: boolean
  claimedBy?: string
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
  resumeRequest: { text: string } | null
  lastSubmittedTurn: string | null
  activeTurnId: string | null
  promptSeq: number
  focusAppliedSeq: number
}

export type ClmStatus = {
  focus: { id: string; title: string; status: 'todo' | 'doing' | 'ready-to-land' | 'done' | 'question' | 'uncertain' | 'dropped' } | null
  stackDepth: number
  pending: Array<{ id: string; title: string }>
  agents: Array<{ agentId: string; taskId: string; title: string; status: 'todo' | 'doing' | 'ready-to-land' | 'done' | 'question' | 'uncertain' | 'dropped' }>
  resumeRequest: { text: string } | null
  openIssues: number
}

export type ClmTaskInput = {
  tool_use_id?: string
  id?: string
  title?: string
  status: 'todo' | 'doing' | 'done' | 'dropped'
  note?: string
  hypothesis?: boolean
  method?: string
  plan?: string[]
  result?: { intent: string; finding: string; decision: string; files?: string[] }
  evidence?: { ref: string; quote: string }
}

export type Clm = {
  /** Create an issue in this session, or set an existing issue's status. */
  track(input: ClmTrackInput): Promise<ClmIssue>
  /** Read this session's issues, optionally filtered by id and status. */
  issues(query?: ClmIssueQuery): Promise<ClmIssue[]>
  /** Queue a continuation prompt for clm's turn-end arbiter. */
  resume(input: { text: string }): Promise<'submitted' | 'queued'>
  /** Read the pending resume request and open issue count. */
  status(): Promise<ClmStatus>
}

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__clm__clm_task': ClmTaskInput
  }

  interface PluginState {
    clm: { workflow: ClmWorkflow }
  }

  interface EngineInterface {
    clm: Clm
  }
}
