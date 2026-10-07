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

export type Clm = {
  /** Create an issue in this session, or set an existing issue's status. */
  track(input: ClmTrackInput): Promise<ClmIssue>
  /** Read this session's issues, optionally filtered by id and status. */
  issues(query?: ClmIssueQuery): Promise<ClmIssue[]>
}

declare module 'claude-code' {
  interface EngineInterface {
    clm: Clm
  }
}
