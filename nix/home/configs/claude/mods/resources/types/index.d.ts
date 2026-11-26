export type ResourceInput = {
  action: 'list' | 'who' | 'register' | 'unregister' | 'acquire' | 'release' | 'forget'
  name?: string
  kind?: 'owned' | 'mutex'
  aliases?: string[]
  description?: string
}

declare module 'claude-code' {
  interface McpToolInputs {
    'mcp__resources__resource': ResourceInput
  }
}
