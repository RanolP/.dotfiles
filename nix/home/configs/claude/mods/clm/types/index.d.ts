export type ClmBoardIssue = {
  id: string
  title: string
  status: 'todo' | 'doing' | 'done' | 'question' | 'dropped'
  repo: string
  branch?: string
  updated: string
}

export type ClmBoard = {
  issues: ClmBoardIssue[]
  /** The repository the session runs in, which the `repo` filter keeps. */
  repo: string
  filter: 'repo' | 'all'
}

declare module 'claude-code' {
  interface PluginState {
    clm: { board: ClmBoard }
  }
}
