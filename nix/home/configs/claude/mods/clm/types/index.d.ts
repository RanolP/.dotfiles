import type { StableAttachmentType } from '../hooks/fold'

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
  lastFoldAt: number | null
  ledgerPath: string
  openIssues: number
}

export type ClmRecallInput = { address: string }
export type ClmTaskInput = {
  id?: string
  title?: string
  status: 'todo' | 'doing' | 'done' | 'dropped'
  note?: string
  method?: string
  evidence?: { ref: string; quote: string }
}

export type ClmResourceInput = {
  action: 'list' | 'who' | 'register' | 'unregister' | 'acquire' | 'release' | 'forget'
  name?: string
  kind?: 'owned' | 'mutex'
  aliases?: string[]
  description?: string
}

export type ClmCoworkerInput = {
  action: 'claim' | 'ready' | 'release' | 'plan' | 'revoke' | 'land' | 'list' | 'register'
  issue?: string
  priority?: number
  ready?: boolean
  maxCoworkers?: number
  to?: string
  peer?: string
}

export type ClmStableAttachmentType = StableAttachmentType
export type ClmStableAttachmentValue = { full?: string; inHead?: boolean; headDigest?: string; deltas: string[]; carriedAtSeq: number }
export type ClmStableAttachmentSession = Partial<Record<ClmStableAttachmentType, ClmStableAttachmentValue>>
export type ClmStableAttachmentState = Record<string, ClmStableAttachmentSession>

export type Clm = {
  /** Create an issue in this session, or set an existing issue's status. */
  track(input: ClmTrackInput): Promise<ClmIssue>
  /** Read this session's issues, optionally filtered by id and status. */
  issues(query?: ClmIssueQuery): Promise<ClmIssue[]>
  /** Queue a continuation prompt for clm's turn-end arbiter. */
  resume(input: { text: string }): Promise<'submitted' | 'queued'>
  /** Read the pending resume request, last fold, ledger path, and open issue count. */
  status(): Promise<ClmStatus>
}

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__clm__clm_recall': ClmRecallInput
    'mcp__clm__clm_task': ClmTaskInput
    'mcp__clm__clm_resource': ClmResourceInput
    'mcp__clm__clm_coworker': ClmCoworkerInput
  }

  interface PluginState {
    clm: { workflow: ClmWorkflow; stableAttachments: ClmStableAttachmentState }
  }

  interface EngineInterface {
    clm: Clm
  }
}
