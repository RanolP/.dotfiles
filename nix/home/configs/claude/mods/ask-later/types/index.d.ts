export type Option = { label: string; description?: string }

export type Question = {
  /** `Q<n>`, unique within the session. */
  id: string
  question: string
  header?: string
  options: Option[]
  multiSelect?: boolean
  /** What the model proceeds under until the answer arrives. */
  assumption?: string
  /** The work the model parked until the answer arrives. */
  blocks?: string
  /** `resolved`: the model settled it in chat through the `resolve` tool. */
  status: 'pending' | 'answered' | 'resolved'
  answer?: string
  /** The answer has reached the model. */
  delivered?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    /** `turnId`: the running main turn, null while idle; picks session.append vs prompt.submit for delivery. */
    'ask-later': { questions: Question[]; turnId: string | null }
  }
}
