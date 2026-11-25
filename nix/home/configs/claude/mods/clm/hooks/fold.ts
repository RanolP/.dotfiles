import type { SessionMessage } from 'claude-code'

const isBare = (m: SessionMessage) => m.toolUses.length === 0 && (m.toolResults ?? []).length === 0

// Rows the engine injects rather than the conversation. SessionMessage has no
// origin flag, so match text. "(no content)" is how the engine rebuilds an
// empty assistant row after a compaction.
const SYSTEM_ROW = {
  taskNotification: /^\s*<task-notification>/,
  remindersOnly: /^\s*(?:<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/,
  localCommand: /^\s*(?:<command-name>\/(?:clear|compact)<\/command-name>|<local-command-(?:stdout|stderr|caveat)>)/,
}
const isLocalCommand = (m: SessionMessage) => isBare(m) && m.role === 'user' && SYSTEM_ROW.localCommand.test(m.text)
const isReminderRow = (m: SessionMessage) => isBare(m) && m.role === 'user' && SYSTEM_ROW.remindersOnly.test(m.text)
const isEmptyRow = (m: SessionMessage) => isBare(m) && (m.text.trim() === '' || (m.role === 'assistant' && m.text.trim() === '(no content)'))
const isSystemRow = (m: SessionMessage): boolean => {
  if (!isBare(m)) return false
  if (m.role === 'assistant') return isEmptyRow(m)
  return SYSTEM_ROW.taskNotification.test(m.text) || SYSTEM_ROW.remindersOnly.test(m.text) || isLocalCommand(m)
}

/** A user-facing time on the Asia/Seoul clock, `2026-10-13 18:04 KST`; Korea keeps no DST, so +9h is exact. */
export const kst = (t: number | string | Date = new Date()): string => {
  const ms = new Date(t).getTime()
  return Number.isNaN(ms) ? String(t) : `${new Date(ms + 9 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} KST`
}
const isPrompt = (m: SessionMessage) => m.role === 'user' && m.text.trim() !== '' && (m.toolResults ?? []).length === 0 && !isSystemRow(m)

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
export const stripReminders = (text: string) => text.replace(REMINDER, '').trim()
const isCompactSummary = (m: SessionMessage): boolean => (m as SessionMessage & { isCompactSummary?: boolean }).isCompactSummary === true
// User-role rows the harness writes into the conversation: a subagent's
// hand-back and a loaded skill's body. They are not the user speaking, so
// they are neither citable as the user nor instructions.
const HARNESS_TEXT = /^(?:Another Claude session sent a message:|Base directory for this skill: )/
export const isHarnessText = (text: string) => HARNESS_TEXT.test(text)
/** A prompt the user wrote: what may be quoted as the user. */
export const isUserTyped = (m: SessionMessage) => !isCompactSummary(m) && isPrompt(m) && !isHarnessText(stripReminders(m.text))

// Rebuilt WITHOUT the handle: a handled row keeps its old parent and message id,
// and on --resume the loader pulls the pre-compaction chain back in.
const strip = (m: SessionMessage): SessionMessage =>
  ({ role: m.role, text: m.text, toolUses: m.toolUses, ...(m.toolResults ? { toolResults: m.toolResults } : {}) })

// A subagent opens on harness reminders no later row repeats, the
// SubagentHandback delivery rule among them. The engine summary of a subagent
// dropped them, and the worker then ended on plain text its caller never got,
// so each one the compacted rows lack goes back right after the summary.
export function keepSpawnReminders(before: readonly SessionMessage[], after: readonly SessionMessage[]): SessionMessage[] {
  const firstReply = before.findIndex(m => m.role === 'assistant')
  const missing = before.slice(0, firstReply < 0 ? before.length : firstReply)
    .filter(m => isReminderRow(m) && !after.some(kept => kept.text === m.text)).map(strip)
  return after.length && missing.length ? [after[0]!, ...missing, ...after.slice(1)] : [...after]
}
