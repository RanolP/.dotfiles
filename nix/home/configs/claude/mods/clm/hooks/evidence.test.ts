import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, RenderPropsOf, SessionCompactInput, SessionCompactResult, SessionMessage, SessionStartInput, ToolCallInput, TurnCompleteInput } from 'claude-code'

import { boardHtml } from './board'
import { chooseContinuation, clmStatus, resetUserWorkflow, restoreFailedContinuation, sessionIssues, submitWithRecovery, trackIssue, TASK_TOOL } from './register'
import { INTENT_SYSTEM } from './intent'
import type { ClmWorkflow } from '../types'

import { focusOf, parseLog, snapshot, toEvents, type Issue, type Payload } from './tracker'
import { checkEvidence } from './evidence'
import { M, intentReply, use, res, BIG, MID, ROWS, CITE, splitAnswer, compressedTopics, TURN, OPTS, LEDGER_FILE, LOG_FILE, storedLedger, ids, shape, handled, compactInput, promptInput, turnInput, commandInput, compactedMessages, workflow, bottoms, turnEnds, BG_OPTS, logEvents, panelHandlers, sixDone, NOTE_REPLY, ESCAPE_ROWS, WITHHELD_FILE, section, PR_ROWS, TRACKER, seedTracker, issueAt, runClm, waitForLog } from './clm-test-support'
import type { State, On, Seen, PanelReply } from './clm-test-support'
// --- evidence gate and review ------------------------------------------------

// Regression caught: refs copied as rendered (`<- [toolu_…]`, `[user m4 … KST]`) or with the `m` dropped or case changed missed their source row, so every done they backed was downgraded.
test('a ref spelled the way the range renders it resolves to its row, and an assistant ref still fails', () => {
  const user = { kind: 'user' as const, text: 'please investigate the build' }
  const tool = { kind: 'tool_result' as const, text: 'log: make fails at' }
  const sources = new Map([['m4', user], ['toolu_01AbC', tool], ['abcd1234', user], ['@beef5678', user]])
  const evidence = [
    { ref: ' [user m4 2026-10-15 14:03 KST] ', quote: user.text },
    { ref: '<- [toolu_01AbC]', quote: tool.text },
    { ref: 'TOOLU_01ABC', quote: tool.text },
    { ref: 'M4', quote: user.text },
    { ref: '4', quote: user.text },
    { ref: '[assistant 2026-10-15 14:04 KST]', quote: user.text },
    { ref: '@ABCD1234', quote: user.text },
    { ref: 'BEEF5678', quote: user.text },
  ]
  const checked = checkEvidence(evidence, sources)
  expect(checked.held.map(item => item.ref)).toEqual(['m4', 'toolu_01AbC', 'toolu_01AbC', 'm4', 'm4', 'abcd1234', '@beef5678'])
  expect(checked.problems).toEqual(['ref [assistant 2026-10-15 14:04 KST] is not a citable row of the folded range'])
})

