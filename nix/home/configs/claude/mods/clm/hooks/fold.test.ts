import { test, expect, mock } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'
import type { CommandRunInput, PromptSubmitInput, RenderPropsOf, SessionCompactInput, SessionCompactResult, SessionMessage, SessionStartInput, ToolCallInput, TurnCompleteInput } from 'claude-code'

import { boardHtml } from './board'
import { chooseContinuation, clmStatus, mergeInstructions, isHeld, readOpts, resetUserWorkflow, removeQueueSnapshotTargets, restoreFailedContinuation, sessionIssues, submitWithRecovery, trackIssue, recallRows, residentLedgerText, TASK_TOOL } from './register'
import type { Held, Meta } from './register'
import { INTENT_SYSTEM } from './intent'
import type { ClmWorkflow } from '../types'

import { ageDecayPlan, fallbackLedger, instructionValues, LEDGER_COMPACT_SYSTEM, MERGE_SYSTEM, parseMerge, preserveInstructions, REVIEW_SYSTEM, SPLIT_MERGE_SYSTEM } from './ledger'
import { focusOf, isRecord, parseLog, snapshot, toEvents, type Issue, type Payload } from './tracker'
import { buildCleared, estTokens, fingerprint, foldedRows, planClear, protectedIndex, stableAttachmentOf, stableAttachmentRow, TOKEN_ESTIMATOR_VERSION } from './fold'
import { applyReadyIfAtThreshold, clearFoldJob, handleSessionCompact, setRewindFoldJob, transcriptKey } from './fold-job'
import { atFoldPoint, boundedOverhead, calibrateFirstReading, foldableTokens, storedTopics } from './fold-runtime'
import type { Opts } from './fold-runtime'
import type { RewindIo, RewindPlan } from './rewind'
import type { StableAttachmentType } from './fold'
import { M, intentReply, use, res, BIG, MID, ROWS, CITE, ledger, splitAnswer, compressedTopics, TURN, OPTS, LEDGER_FILE, LOG_FILE, storedLedger, ids, est, shape, handled, compactInput, promptInput, turnInput, commandInput, compactedMessages, workflow, heldIn, isMetaValue, metaIn, bottoms, turnEnds, waitForPending, BG_OPTS, logEvents, panelHandlers, sixDone, storedOverhead, NOTE_REPLY, ESCAPE_ROWS, WITHHELD_FILE, section, PR_ROWS, TRACKER, seedTracker, issueAt, runClm, LATER_BAND_PROPS, waitForLog, modDetectionHarness } from './clm-test-support'
import type { State, On, Seen, PanelReply } from './clm-test-support'

const readStateFile = (files: Record<string, string>, path: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(files[path] ?? '{}')
  if (!isRecord(value)) throw new Error(`state file is not an object: ${path}`)
  return value
}

const readyPlan: RewindPlan = { notes: '', fullNotes: '', ops: [], seq: 1, keepFrom: 0, dropFps: [], cuts: {}, keptTurns: 0, fallback: false }
const thresholdOpts: Opts = { budget: 2000, reserve: 100, tailTarget: 1200, queueTarget: 100000, ledgerTarget: 300, model: '', reviewModel: '' }
const ENGINE_SUMMARY_TEXTS = ['ENGINE SUMMARY', '[clm clauses]\n- (none)']

// Regression caught: a session kept running the old store copy after a rebuild and its autocompact silently failed 40 times.
test('a compaction under a mod whose installed path changed since load logs mod-stale once', async () => {
  const seen = modDetectionHarness([
    { exitCode: 0, stdout: '/nix/store/old-hm_clm\n', stderr: '' },
    { exitCode: 0, stdout: '/nix/store/new-hm_clm\n', stderr: '' },
    { exitCode: 0, stdout: '/nix/store/new-hm_clm\n', stderr: '' },
  ], { HOME: '/home/t', CLAUDE_CODE_PLUGIN_DIRS: '/home/t/.claude/mods/clm' })
  await seen.initialize()
  await seen.compact()
  await seen.compact()
  await seen.settle()
  expect(logEvents(seen).filter(row => row.event === 'mod-stale').map(({ event, loadedFrom, installedPath }) => ({ event, loadedFrom, installedPath }))).toEqual([
    { event: 'mod-stale', loadedFrom: '/nix/store/old-hm_clm', installedPath: '/nix/store/new-hm_clm' },
  ])
  expect(seen.logs.filter(text => text.includes('stale clm'))).toHaveLength(1)
})

// Regression caught: CLAUDE_CONFIG_DIR pointed at .claude-personal while the runtime loaded clm from CLAUDE_CODE_PLUGIN_DIRS under ~/.claude.
test('the installed mod lookup follows CLAUDE_CODE_PLUGIN_DIRS instead of CLAUDE_CONFIG_DIR', async () => {
  const seen = modDetectionHarness([{ exitCode: 0, stdout: '/nix/store/old-hm_clm\n', stderr: '' }], {
    HOME: '/home/t', CLAUDE_CONFIG_DIR: '/x/.claude-personal', CLAUDE_CODE_PLUGIN_DIRS: '~/.claude/mods/clm:/other',
  })
  await seen.initialize()
  expect(seen.runs[0]).toEqual(['realpath', '/home/t/.claude/mods/clm'])
})

// Regression caught: a compaction-time realpath failure went unlogged, leaving stale-mod detection failures invisible.
test('a compaction-time installed mod lookup failure leaves compaction fail-open and logs the reason', async () => {
  const seen = modDetectionHarness([
    { exitCode: 0, stdout: '/nix/store/old-hm_clm\n', stderr: '' },
    { exitCode: 1, stdout: '', stderr: 'not found' },
  ], {
    HOME: '/home/t', CLAUDE_CODE_PLUGIN_DIRS: '/home/t/.claude/mods/clm',
  })
  await seen.initialize()
  const result = await seen.compact()
  await seen.settle()
  expect(result.messages?.map(message => message.text)).toEqual(['ENGINE SUMMARY'])
  expect(logEvents(seen).filter(row => row.event === 'mod-stale').map(row => row.reason)).toEqual([
    expect.stringContaining('could not resolve'),
  ])
})

// Regression caught: a plugin compaction with no clm plan handed the rows back unchanged, so the context never shrank, and dropped out of latency attribution.
test('a plugin compaction with no clm plan returns the engine summary and logs its entry state and wait time', OPTS, async () => {
  const logged = Promise.withResolvers<void>()
  const events: { event: string; fields: Record<string, unknown> }[] = []
  let time = 100
  const io = {
    loadedFrom: '/nix/store/current-hm_clm', sessionId: async () => 'compact-log-plugin', now: async () => time += 5,
    readMeta: async () => ({ seq: 0, fails: 0 }), writeMeta: async () => undefined, observeTranscript: async () => undefined,
    storeGet: async () => undefined, storeDelete: async () => undefined, storeSet: async () => undefined, pendingKey: async () => 'pending:s1',
    backfillClauses: async () => undefined,
    logEvent: async (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }); logged.resolve() }, log: () => undefined,
  } as unknown as FoldJobIo
  const summary = { messages: [M('user', 'ENGINE SUMMARY')] }
  const result = await handleSessionCompact(io, OPTS.options, ROWS, 'plugin', async () => summary)
  await logged.promise
  expect(result.messages?.map(message => message.text)).toEqual(ENGINE_SUMMARY_TEXTS)
  expect(events).toEqual([{ event: 'session-compact', fields: { trigger: 'plugin', state: 'none', outcome: 'plugin-handoff', loadedFrom: '/nix/store/current-hm_clm', waitMs: 5, totalMs: 10 } }])
})

// Regression caught: a swap whose io read rejected threw out of session.compact, so the engine's compactor never ran and the context stayed full.
test('a swap whose io read rejects hands off to the engine summary exactly once', OPTS, async () => {
  const rows = handled(ROWS)
  let handoffs = 0
  const io = {
    sessionId: async () => 'swap-read-fails', now: async () => 0,
    readMeta: async () => ({ seq: 0, fails: 0 }), writeMeta: async () => undefined, observeTranscript: async () => undefined,
    storeDelete: async () => undefined, storeSet: async () => undefined, pendingKey: async () => 'pending:swap-read-fails',
    readRewindIo: () => ({}), captureOrigin: async () => { throw new Error('origin read failed') },
    logEvent: async () => undefined, log: () => undefined,
  } as unknown as FoldJobIo
  const key = transcriptKey(await io.sessionId())
  const first = protectedIndex(rows)
  const keepRow = rows[first + 4]!
  clearFoldJob(key)
  setRewindFoldJob(key, { ...readyPlan, keepFrom: first + 4, keepFp: fingerprint(keepRow), dropFps: foldedRows(rows, first, first + 4).map(fingerprint) }, rows.map(fingerprint))
  const summary = { messages: [M('user', 'ENGINE SUMMARY')] }
  try {
    const result = await handleSessionCompact(io, OPTS.options, rows, 'auto', async () => { handoffs++; return summary })
    expect(result.messages?.map(message => message.text)).toEqual(ENGINE_SUMMARY_TEXTS)
    expect(handoffs).toBe(1)
  } finally { clearFoldJob(key) }
})

// Regression caught: a ready plan whose ledger outweighed its dropped rows wrote the ledger, a snapshot and a new seq before the shrink check handed off, so the ledger history described a swap that never happened.
test('a ready plan whose stable rows grow total context leaves the ledger, its snapshots and meta.seq unchanged', OPTS, async () => {
  const rows = handled(ROWS)
  const stored: Record<string, unknown> = {}
  const files: Record<string, string> = {}
  const metas: Meta[] = []
  const logs: string[] = []
  const io = {
    sessionId: async () => 'swap-grows', now: async () => 0, usageReading: async () => undefined,
    readMeta: async () => ({ seq: 0, fails: 0 }), writeMeta: async (meta: Meta) => { metas.push(meta) }, observeTranscript: async () => undefined,
    storeGet: async (key: string) => stored[key], storeSet: async (key: string, value: unknown) => { stored[key] = value }, storeDelete: async (key: string) => { delete stored[key] },
    pendingKey: async () => 'pending:swap-grows', topicsKey: async () => 'topics:swap-grows', ledgerPath: async () => LEDGER_FILE,
    writeFile: async (path: string, text: string) => { files[path] = text },
    readRewindIo: () => ({ storeGet: async (key: string) => stored[key], storeSet: async (key: string, value: unknown) => { stored[key] = value } }),
    captureOrigin: async () => ({ session: 's1', repo: 'example.invalid/repo', cwd: '/work/repo' }),
    append: async () => [], updateHeld: async () => undefined, backfillClauses: async () => undefined, readAll: async () => [],
    trackerView: async () => ({ issues: [], dropped: [], finished: [], doneTitles: new Set() }),
    residentLedger: async (_key: string, _issues: unknown, _focus: unknown, _events: unknown, ledger: { notes: string }) => ledger.notes,
    stableAttachments: async (headKept: boolean) => ({ rows: [stableAttachmentRow('output_style_instructions', 's'.repeat(20_000))], headKept }),
    logEvent: async () => undefined, log: (text: string) => { logs.push(text) },
  } as unknown as FoldJobIo
  const key = transcriptKey(await io.sessionId())
  const first = protectedIndex(rows)
  const keepRow = rows[first + 2]!
  clearFoldJob(key)
  setRewindFoldJob(key, {
    ...readyPlan, notes: '## 목표\n- keep the task', fullNotes: '## 목표\n- keep the task', keepFrom: first + 2, keepFp: fingerprint(keepRow),
    dropFps: foldedRows(rows, first, first + 2).map(fingerprint), keptTurns: 1, rewindOnly: false,
  }, rows.map(fingerprint))
  const summary = { messages: [M('user', 'ENGINE SUMMARY')] }
  try {
    expect((await handleSessionCompact(io, OPTS.options, rows, 'manual', async () => summary)).messages?.map(message => message.text)).toEqual(ENGINE_SUMMARY_TEXTS)
  } finally { clearFoldJob(key) }
  expect(logs.some(text => text.includes('did not shrink'))).toBe(true)
  expect(stored[`ledger-snapshots:${key}`]).toBeUndefined()
  expect(metas.every(meta => meta.seq === 0)).toBe(true)
  expect(files[LEDGER_FILE]).toBeUndefined()
})

test('multiline goals survive topic restoration through the end of the 목표 section', async () => {
  const notes = '## 목표\n- first line\n- second line\n\n## 사용자 지시\n- keep this'
  const topics = await storedTopics({ topics: async () => undefined }, notes, 2, 's1:main')
  expect(topics).toEqual([{ topic: '기존 세션 주제', summary: '- first line\n- second line', seq: 2 }])
})

test('a built-in compact summary enters the fold input and leaves the rebuilt head', () => {
  const summary = M('user', 'BUILT-IN SUMMARY', { isCompactSummary: true } as Partial<SessionMessage>)
  const rows = [summary, M('user', 'older'), M('assistant', 'answer'), M('user', 'newest'), M('assistant', 'latest')]
  const plan = planClear(rows, 30, 1)
  if (!plan) throw new Error('expected a clear plan')
  expect(plan.dropped).toContain(summary)
  expect(buildCleared(plan, M('user', '[clm ledger #1 · now]'))).not.toContain(summary)
})

// Regression caught: an auto compaction that joined an in-flight plugin rewind swap got that swap's grown rows back, so the engine's compaction left the context larger.
test('an auto compaction joining a plugin rewind swap whose rows grew hands off to the engine summary once', OPTS, async () => {
  const rows = handled(ROWS)
  const gate = Promise.withResolvers<void>()
  const swapping = Promise.withResolvers<void>()
  const stored: Record<string, unknown> = {}
  const io = {
    sessionId: async () => 'joined-rewind', now: async () => 0, usageReading: async () => undefined,
    readMeta: async () => ({ seq: 0, fails: 0 }), writeMeta: async () => undefined, observeTranscript: async () => undefined,
    storeGet: async (key: string) => stored[key], storeSet: async (key: string, value: unknown) => { stored[key] = value }, storeDelete: async (key: string) => { delete stored[key] },
    pendingKey: async () => 'pending:joined-rewind', topicsKey: async () => 'topics:joined-rewind', ledgerPath: async () => LEDGER_FILE,
    writeFile: async () => undefined, markStableAttachmentsCarried: async () => undefined,
    readRewindIo: () => ({ storeGet: async (key: string) => stored[key], storeSet: async (key: string, value: unknown) => { stored[key] = value } }),
    captureOrigin: async () => { swapping.resolve(); await gate.promise; return { session: 's1', repo: 'example.invalid/repo', cwd: '/work/repo' } },
    readAll: async () => [], trackerView: async () => ({ issues: [], dropped: [], finished: [], doneTitles: new Set() }),
    residentLedger: async (_key: string, _issues: unknown, _focus: unknown, _events: unknown, ledger: { notes: string }) => ledger.notes,
    stableAttachments: async (headKept: boolean) => ({ rows: [], headKept }),
    logEvent: async () => undefined, log: () => undefined,
  } as unknown as FoldJobIo
  const key = transcriptKey(await io.sessionId())
  const first = protectedIndex(rows)
  clearFoldJob(key)
  setRewindFoldJob(key, {
    ...readyPlan, notes: '## 목표\n- restored task', fullNotes: '## 목표\n- restored task', keepFrom: first + 1, keepFp: fingerprint(rows[first + 1]!),
    dropFps: [], rewindOnly: true,
  }, rows.map(fingerprint))
  let pluginHandoffs = 0
  let autoHandoffs = 0
  const summary = { messages: [M('user', 'ENGINE SUMMARY')] }
  try {
    const plugin = handleSessionCompact(io, OPTS.options, rows, 'plugin', async () => { pluginHandoffs++; return summary })
    await swapping.promise
    const auto = handleSessionCompact(io, OPTS.options, rows, 'auto', async () => { autoHandoffs++; return summary })
    gate.resolve()
    expect((await plugin).messages?.some(message => message.text.includes('clm ledger #1'))).toBe(true)
    expect((await auto).messages?.map(message => message.text)).toEqual(ENGINE_SUMMARY_TEXTS)
    expect(pluginHandoffs).toBe(0)
    expect(autoHandoffs).toBe(1)
  } finally { clearFoldJob(key) }
})

// Regression caught: a fixed prompt prefix above the budget triggered a fold even when the conversation rows stayed below it.
test('a large fixed prefix does not start compaction when foldable rows are below budget', OPTS, async () => {
  const session = 'fixed-prefix-small'
  const key = `${session}:main`
  const rows: SessionMessage[] = [{ role: 'user', text: 'x'.repeat(5200), toolUses: [] }]
  const meta = { seq: 0, fails: 0, overhead: 48_500, ratio: 1, estimatorVersion: TOKEN_ESTIMATOR_VERSION }
  expect(foldableTokens(rows, 50_000, meta)).toBe(1500)
  let compactions = 0
  const io = {
    sessionId: async () => session,
    sessionMessages: async () => rows,
    readMeta: async () => meta,
    usageReading: async () => 50_000,
    sessionCompact: async () => { compactions++; return { messages: rows } },
    logEvent: async () => undefined,
    log: () => undefined,
  }
  clearFoldJob(key)
  setRewindFoldJob(key, readyPlan, [])
  try { await applyReadyIfAtThreshold(io, thresholdOpts, transcriptKey(await io.sessionId())) } finally { clearFoldJob(key) }
  expect(compactions).toBe(0)
})

// Regression caught: a foldable conversation above budget must still reach the engine compact path.
test('compaction starts when foldable rows exceed budget despite the fixed prefix', OPTS, async () => {
  const session = 'fixed-prefix-large'
  const key = `${session}:main`
  const rows: SessionMessage[] = [{ role: 'user', text: 'x'.repeat(12_000), toolUses: [] }]
  const meta = { seq: 0, fails: 0, overhead: 47_000, ratio: 1, estimatorVersion: TOKEN_ESTIMATOR_VERSION }
  expect(foldableTokens(rows, 50_000, meta)).toBe(3000)
  let compactions = 0
  const io = {
    sessionId: async () => session,
    sessionMessages: async () => rows,
    readMeta: async () => meta,
    usageReading: async () => 50_000,
    sessionCompact: async () => { compactions++; return { messages: rows } },
    logEvent: async () => undefined,
    log: () => undefined,
  }
  clearFoldJob(key)
  setRewindFoldJob(key, readyPlan, [])
  try { await applyReadyIfAtThreshold(io, thresholdOpts, transcriptKey(await io.sessionId())) } finally { clearFoldJob(key) }
  expect(compactions).toBe(1)
})

// Regression caught: with a 67k fixed prefix the window budget sat past the engine's own autocompact point (~166.7k of 200k), so the ready clm plan never applied before the engine summarized.
test('with a 67k prefix in a 200k window the clm fold point sits below the engine autocompact point', OPTS, async () => {
  const { opts } = readOpts({}, 200_000, 67_000)
  const meta = { estimatorVersion: TOKEN_ESTIMATOR_VERSION, overhead: 67_000 }
  const rows: SessionMessage[] = [{ role: 'user', text: 'x'.repeat(2400), toolUses: [] }]
  expect(opts.budget - opts.reserve + 67_000).toBeLessThan(166_667)
  expect(atFoldPoint(rows, 150_000, meta, opts)).toBe(true)
  expect(atFoldPoint(rows, 100_000, meta, opts)).toBe(false)
})

// Regression caught: an undercounting estimator stored an overhead larger than the whole context, so foldable tokens read 0 and the fold point was never reached.
test('an undercounting estimator never stores an overhead above the first observed reading', OPTS, async () => {
  const rows: SessionMessage[] = [{ role: 'user', text: 'x'.repeat(2400), toolUses: [] }]
  const meta: Meta = { seq: 0, fails: 0, estimatorVersion: TOKEN_ESTIMATOR_VERSION, overhead: 150_000 }
  calibrateFirstReading(meta, rows, 70_000)
  expect(meta.overhead).toBe(70_000)
  expect(boundedOverhead(190_000, meta)).toBe(70_000)
  expect(atFoldPoint(rows, 160_000, meta, { budget: 60_000, reserve: 4000 })).toBe(true)
})

test('foldable size ignores stale and implausible calibration', OPTS, async () => {
  const rows: SessionMessage[] = [{ role: 'user', text: 'x'.repeat(2400), toolUses: [] }]
  expect(foldableTokens(rows, 50_000, { estimatorVersion: 0, overhead: 49_000, ratio: 1.5 })).toBe(1000)
  expect(foldableTokens(rows, undefined, { estimatorVersion: TOKEN_ESTIMATOR_VERSION, ratio: 1.5 })).toBe(1500)
  expect(foldableTokens(rows, 50_000, { estimatorVersion: TOKEN_ESTIMATOR_VERSION, overhead: 20_000, ratio: 1.5 })).toBe(30_000)
  expect(foldableTokens(rows, 50_000, { estimatorVersion: TOKEN_ESTIMATOR_VERSION, overhead: 26_000, ratio: 1.5 })).toBe(24_000)
  expect(foldableTokens(rows, 50_000, { estimatorVersion: TOKEN_ESTIMATOR_VERSION, overhead: 50_000, ratio: 1.5 })).toBe(1500)
})

// Regression caught: an engine-store limit failure after the fold was computed discarded the compact result.
test('a compact returns folded messages when store persistence exceeds its limit', OPTS, async () => {
  const rows = handled(ROWS)
  const files: Record<string, string> = {}
  const rewindValues = new Map<string, unknown>()
  const rewind: RewindIo = {
    storeGet: async key => rewindValues.get(key), storeSet: async (key, value) => { rewindValues.set(key, value) },
    storeDelete: async key => { rewindValues.delete(key) }, writeFile: async (path, text) => { files[path] = text },
    ledgerPath: async () => LEDGER_FILE, topicsKey: async key => `topics:${key}`, pendingKey: async key => `pending:${key}`,
    readMeta: async () => ({ seq: 0, fails: 0 }), writeMeta: async () => undefined,
    readyFoldDropFps: () => undefined, clearReadyFold: async () => undefined, setRewindReady: () => undefined,
    logEvent: async () => undefined, log: () => undefined,
  }
  const io: FoldJobIo = {
    sessionId: async () => 's1', sessionMessages: async () => rows,
    stableAttachments: async () => { throw new Error('attachment read failed') }, markStableAttachmentsCarried: async () => undefined,
    sessionCompact: async () => ({ messages: rows }), now: async () => Date.parse('2026-10-06T00:00:00Z'),
    after: () => ({ cancel: () => undefined }), usageReading: async () => 6000, sentAt: async () => () => undefined,
    readMeta: async () => { throw new Error('malformed session state') }, writeMeta: async () => undefined,
    readLedger: async () => undefined, ledgerPath: async () => LEDGER_FILE, basePath: async () => '/home/t/.claude-work/plans/clm-s1',
    readFile: async () => undefined, writeFile: async (path, text) => { files[path] = text }, appendFile: async () => undefined,
    lessonsPath: async () => '', fileExists: async () => false, fileList: async () => [],
    run: async () => ({ exitCode: 0, stderr: '' }),
    storeGet: async () => undefined, storeSet: async () => { throw new Error('HooksError: $.store.set: the store would be 4194305 characters, over the 4194304 limit') },
    storeDelete: async () => undefined, pendingKey: async () => 'pending:s1', topicsKey: async () => 'topics:s1:main',
    captureOrigin: async () => ({ session: 's1', repo: 'example.invalid/repo', cwd: '/work/repo' }),
    readAll: async () => [], trackerView: async () => ({ issues: [], dropped: [], finished: [], doneTitles: new Set() }),
    updateHeld: async () => { throw new Error('held store full') }, backfillClauses: async () => undefined,
    residentLedger: async () => { throw new Error('resident index write failed') },
    append: async () => { throw new Error('tracker write failed') }, projectPanel: async () => undefined, readRewindIo: () => rewind,
    observeTranscript: async () => { throw new Error('transcript write failed') }, fold: async () => { throw new Error('ready plan should bypass fold summary') },
    complete: async () => ({ isAnswered: false, text: '', reason: 'unused' }),
    logEvent: async (event, fields) => {
      const line = JSON.stringify({ ts: '2026-10-06T00:00:00.000Z', event, ...fields })
      files[LOG_FILE] = `${files[LOG_FILE] ?? ''}${line}\n`
    },
    log: () => undefined,
  }
  const first = protectedIndex(rows)
  // Folding the large build log is what makes this swap shrink the context.
  const keepFrom = first + 4
  const keepRow = rows[keepFrom]
  if (!keepRow) throw new Error(`fold plan has no kept row at ${keepFrom}`)
  const plan: RewindPlan = {
    notes: '## 목표\n- keep the task', fullNotes: '## 목표\n- keep the task', ops: [], seq: 1,
    keepFp: fingerprint(keepRow), keepFrom,
    dropFps: foldedRows(rows, first, keepFrom).map(fingerprint), cuts: {}, keptTurns: 1, fallback: false, rewindOnly: false,
    topics: [{ topic: 'build', summary: 'build summary', seq: 1 }],
  }
  clearFoldJob('s1:main')
  setRewindFoldJob('s1:main', plan, rows.map(fingerprint))
  const result = await handleSessionCompact(io, OPTS.options, rows, 'manual', async () => { throw new Error('the clm swap should have shrunk the rows') })
  clearFoldJob('s1:main')
  expect(compactedMessages(result).some(message => message.text.includes('clm ledger #1'))).toBe(true)
  const failures = logEvents({ files }).filter(event => event.event === 'fold-persist-failed').map(event => String(event.reason))
  for (const reason of ['malformed session state', 'transcript write failed', 'tracker write failed', 'held store full', 'resident index write failed', 'attachment read failed', 'over the 4194304 limit']) {
    expect(failures.some(failure => failure.includes(reason))).toBe(true)
  }
})

// Regression caught: session-owned transcript indexes kept increasing the engine-wide store.
test('session-scoped store keys land in the session state file', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: [], replies: [] })
  await $.prompt.submit(promptInput('Start the migration'))
  const key = 'address-index:s1:main'
  const state = readStateFile(seen.files, '/home/t/.claude-work/plans/clm-s1.state.json')
  expect(state[key]).toBeDefined()
  expect(seen.engineStore).not.toHaveProperty(key)
})

// Regression caught: one-shot migration includes old sessions and keeps file values when merging.
test('plugin load migrates session keys for every session, including old sessions', OPTS, async ($, on) => {
  const keysStarted = Promise.withResolvers<void>()
  const keysGate = Promise.withResolvers<void>()
  const state: State = { rows: [], replies: [], sessionId: 's1', storeKeysBlock: async () => { keysStarted.resolve(); await keysGate.promise } }
  const seen = bottoms(on, state)
  const firstKey = 'address-index:s1:main'
  const oldSessionKey = 'requests:s2:main'
  const oldSessionPath = '/home/t/.claude-work/plans/clm-s2.state.json'
  const existingFileKey = 'held:s2'
  const marker = 'migrated:session-files:v1'
  seen.engineStore[firstKey] = { rows: [{ address: '@first' }] }
  seen.engineStore[oldSessionKey] = ['legacy value']
  // This old ledger stays eligible because migration covers every session.
  seen.files['/home/t/.claude-work/plans/clm-s2.md'] = 'old ledger'
  seen.files[oldSessionPath] = JSON.stringify({ [existingFileKey]: ['file value'] })

  const input = { cwd: '/work/repo', surface: 'terminal', isInteractive: true } satisfies SessionStartInput
  const firstStart = $.session.start(input)
  await keysStarted.promise
  state.sessionId = 's2'
  const secondStart = $.session.start(input)
  keysGate.resolve()
  await Promise.all([firstStart, secondStart])

  const firstState = readStateFile(seen.files, '/home/t/.claude-work/plans/clm-s1.state.json')
  const oldState = readStateFile(seen.files, oldSessionPath)
  expect(firstState[firstKey]).toEqual({ rows: [{ address: '@first' }] })
  expect(oldState[oldSessionKey]).toEqual(['legacy value'])
  expect(oldState[existingFileKey]).toEqual(['file value'])
  expect(seen.engineStore).toEqual({ [marker]: true })
})

// Regression caught: a failed migration must not rerun and rewrite the log on every state access.
test('a failed migration retries only at the next root session start', OPTS, async ($, on) => {
  let attempts = 0
  const seen = bottoms(on, {
    rows: [], replies: [],
    storeKeysBlock: async () => {
      attempts++
      if (attempts === 1) throw new Error('store enumeration failed')
    },
  })
  const input = { cwd: '/work/repo', surface: 'terminal', isInteractive: true } satisfies SessionStartInput
  await $.session.start(input)
  for (let index = 0; index < 3; index++) await $.prompt.submit(promptInput(`state access ${index}`))
  expect(attempts).toBe(1)
  await $.session.start(input)
  expect(attempts).toBe(2)
  expect(seen.engineStore['migrated:session-files:v1']).toBe(true)
})

// Regression caught: malformed session state aborted compaction before the fold could reach the engine.
test('a corrupt session state file is preserved and compaction still folds', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [ledger('RECOVERED-FROM-CORRUPT-STATE')] })
  const statePath = '/home/t/.claude-work/plans/clm-s1.state.json'
  const corruptText = '{not json'
  seen.files[statePath] = corruptText

  const messages = compactedMessages(await $.session.compact(compactInput('manual', handled(ROWS))))
  const backupPath = Object.keys(seen.files).find(path => path.startsWith('/home/t/.claude-work/plans/clm-s1.state.corrupt-'))

  expect(messages[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(backupPath).toBeDefined()
  if (!backupPath) throw new Error('corrupt session state backup was not written')
  expect(seen.files[backupPath]).toBe(corruptText)
  expect(seen.files[statePath]).not.toBe(corruptText)
})
// Regression caught: the automatic fold keeps the wrong rows (drops the request, keeps folded turns, or cuts between a tool_use and its tool_result).
test('over budget, a fold keeps [first request, ledger, newest turns] with tool pairs intact', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('a.ts:12 is the bad import')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out[0].text).toBe('please investigate the build')
  expect(out[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(section(out[1].text, 'learned')).toContain('a.ts:12 is the bad import')
  expect(storedLedger(seen)).toContain('a.ts:12 is the bad import')
  expect(shape(out.slice(2))).toEqual(['run tests', 'tu_c', 'tu_c', 'tests pass', 'commit it', 'done'])
  expect(out[0].handle).toBe('h0')
  expect(out.slice(1).some((m: any) => m.handle !== undefined)).toBe(false)
  expect(seen.prompts[0]).toContain('fixed a.ts:12')
  expect(seen.prompts[0]).not.toContain('tests pass')
  expect(seen.files[LEDGER_FILE]).toContain('## 핵심 사실·경로')
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: every fold rewrote the retired instruction index after clauses became authoritative.
test('a fold leaves the retired instruction index absent', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('fold without a legacy index')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(seen.store['instruction-index:s1:main']).toBeUndefined()
})

// Regression caught: the harness moved stable attachments behind the ledger after compact, invalidating the cached prompt prefix.
test('a mid-session CLAUDE.md edit is carried on the next fold', OPTS, async ($, on) => {
  const instructions = 'Codebase and user instructions are shown below.\n# Stable instructions\nKeep the exact bytes.'
  const context = '{"cwd":"/work/repo"}'
  const coordinator = 'Retain the assigned task and report to the parent.'
  const sections = 'Stable project context section.'
  const style = 'Use the selected response style exactly.'
  const s: State = { rows: ROWS, replies: [ledger('first fold'), ledger('second fold')] }
  const seen = bottoms(on, s)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  const attachment = (type: StableAttachmentType, text: string, agentId?: string) => ({ type, text, origin: 'dynamic', ...(agentId === undefined ? {} : { agentId }) })
  await $.prompt.attachment(attachment('instructions', instructions))
  await $.prompt.attachment(attachment('session_context', context))
  await $.prompt.attachment(attachment('coordinator_context', coordinator))
  await $.prompt.attachment(attachment('context_sections', sections))
  await $.prompt.attachment(attachment('output_style_instructions', style))

  await turnEnds($, s, seen)
  expect(seen.results).toHaveLength(1)
  const first = seen.results.at(0)?.messages ?? []
  expect(first[1]?.text).toBe(stableAttachmentRow('session_context', context).text)
  expect(first[2]?.text).toBe(stableAttachmentRow('coordinator_context', coordinator).text)
  expect(first[3]?.text).toBe(stableAttachmentRow('context_sections', sections).text)
  expect(first[4]?.text).toBe(stableAttachmentRow('output_style_instructions', style).text)
  expect(first[5]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(first.slice(1, 5).every(row => row.handle === undefined)).toBe(true)
  await $.prompt.attachment(attachment('instructions', 'Subagent-only instructions', 'agent-1'))
  expect(await $.prompt.attachment(attachment('instructions', instructions))).toEqual({ text: instructions })
  await $.prompt.attachment(attachment('instructions', instructions))
  expect(await $.prompt.attachment(attachment('session_context', context))).toEqual({ text: null })
  expect(await $.prompt.attachment(attachment('coordinator_context', coordinator))).toEqual({ text: null })
  expect(await $.prompt.attachment(attachment('context_sections', sections))).toEqual({ text: null })
  expect(await $.prompt.attachment(attachment('output_style_instructions', style))).toEqual({ text: null })

  const instructionDelta = 'These instruction files changed — each replaces its earlier copy, and the instructions preamble above still applies:\n/work/CLAUDE.md\nNew instruction text.'
  const secondInstructionDelta = 'Instruction files were re-read after compaction.\nThe new guard applies to generated files.'
  expect(await $.prompt.attachment(attachment('instructions', instructionDelta))).toEqual({ text: instructionDelta })
  expect(await $.prompt.attachment(attachment('instructions', secondInstructionDelta))).toEqual({ text: secondInstructionDelta })
  s.rows = [...ROWS, ...first, M('user', 'continue work'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'continued'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)
  expect(seen.results).toHaveLength(2)
  const second = seen.results.at(1)?.messages ?? []
  expect(second[1]?.text).toBe(first[1]?.text)
  expect(second[2]?.text).toBe(first[2]?.text)
  expect(second[3]?.text).toBe(first[3]?.text)
  expect(second[4]?.text).toBe(first[4]?.text)
  expect(second[5]?.text).toMatch(/^\[clm ledger #2 · /)
  expect(second.filter(row => row.text === first[1]?.text)).toHaveLength(1)
  expect(second.filter(row => stableAttachmentOf(row)?.type === 'instructions')).toHaveLength(0)
  expect(second.filter(row => row.text === first[4]?.text)).toHaveLength(1)
  expect(await $.prompt.attachment(attachment('instructions', instructions))).toEqual({ text: instructions })
  await $.prompt.attachment(attachment('instructions', instructions))
  await $.prompt.attachment(attachment('instructions', 'Instruction files were re-read after an edit; these differ from their earlier copies.\nUpdated instruction text.'))
})

// Regression caught: Claude Code re-attached instructions after a clm swap while clm also returned them as a stable row, doubling CLAUDE.md on every request.
test('a fold leaves instructions to the harness so the post-fold chain receives exactly one copy', OPTS, async ($, on) => {
  const instructions = 'Codebase and user instructions are shown below.\n# Stable instructions'
  const s: State = { rows: ROWS, replies: [ledger('first fold')] }
  const seen = bottoms(on, s)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  const attachment = { type: 'instructions' as const, text: instructions, origin: 'dynamic' }
  await $.prompt.attachment(attachment)
  await turnEnds($, s, seen)
  const folded = seen.results.at(0)?.messages ?? []
  expect(folded.filter(row => stableAttachmentOf(row)?.type === 'instructions')).toEqual([])
  expect(await $.prompt.attachment(attachment)).toEqual({ text: instructions })
})

// Regression caught: the harness re-announced the same MEMORY.md delta after every fold and clm carried one more copy each time (49 identical 31KB rows in one session).
test('MEMORY.md edits across folds leave one latest instructions row before the ledger', OPTS, async ($, on) => {
  const file = (memory: string) => `Contents of /home/u/.claude/projects/w/memory/MEMORY.md (user\'s auto-memory, persists across conversations):\n\n${memory}`
  const full = `Codebase and user instructions are shown below.\n\nContents of /w/CLAUDE.md (project instructions, checked into the codebase):\n\nKeep the exact bytes.\n\n${file('- memory v1')}`
  const delta = (memory: string) => `Instruction files were re-read after the conversation was compacted; these differ from their earlier copies — each replaces its earlier copy, and the instructions preamble above still applies:\n\n${file(memory)}`
  const s: State = { rows: ROWS, replies: [ledger('first fold'), ledger('second fold'), ledger('third fold')] }
  const seen = bottoms(on, s)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  const announce = (text: string) => $.prompt.attachment({ type: 'instructions', text, origin: 'dynamic' })
  const instructionRows = (rows: readonly SessionMessage[]) => rows.filter(row => stableAttachmentOf(row)?.type === 'instructions')
  const more = [M('user', 'continue work'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'continued'), M('user', 'push'), M('assistant', 'pushed')]
  await announce(full)
  await turnEnds($, s, seen)
  const first = seen.results.at(0)?.messages ?? []
  expect(await announce(full)).toEqual({ text: full })
  expect(await announce(delta('- memory v2'))).toEqual({ text: delta('- memory v2') })
  s.rows = [...first, ...more]
  await turnEnds($, s, seen)
  const second = seen.results.at(1)?.messages ?? []
  expect(instructionRows(second)).toEqual([])
  expect(await announce(delta('- memory v2'))).toEqual({ text: delta('- memory v2') })
  expect(await announce(delta('- memory v2'))).toEqual({ text: delta('- memory v2') })
  expect(await announce(delta('- memory v3'))).toEqual({ text: delta('- memory v3') })
  s.rows = [...second, ...more]
  await turnEnds($, s, seen)
  const third = seen.results.at(2)?.messages ?? []
  expect(instructionRows(third)).toEqual([])
})

// Regression caught: after a later fold dropped the head, carriedAtSeq suppressed the harness's only instructions copy.
test('after a fold drops the head, re-announcing the same instructions passes through', OPTS, async ($, on) => {
  const full = 'Codebase and user instructions are shown below.\n\nContents of /w/memory/MEMORY.md (user\'s auto-memory, persists across conversations):\n\n- v1'
  const delta = 'Instruction files were re-read after the conversation was compacted; these differ from their earlier copies:\n\nContents of /w/memory/MEMORY.md (user\'s auto-memory, persists across conversations):\n\n- v2'
  const s: State = { rows: ROWS.slice(0, 1), replies: [ledger('first fold'), ledger('second fold')] }
  const seen = bottoms(on, s)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  const announce = (text: string) => $.prompt.attachment({ type: 'instructions', text, origin: 'dynamic' })
  await announce(full)
  s.rows = ROWS
  await turnEnds($, s, seen)
  const first = seen.results.at(0)?.messages ?? []
  expect(first[0]?.handle).toBe('h0')
  expect(await announce(delta)).toEqual({ text: delta })
  s.rows = [...first, M('user', 'continue work'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'continued'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)
  const second = seen.results.at(1)?.messages ?? []
  expect(second[0]?.handle).toBeUndefined()
  expect(second[1]?.text).toMatch(/^\[clm ledger #2 · /)
  expect(await announce(delta)).toEqual({ text: delta })
})

// Regression caught: a note quoting the harness's "Contents of x (y):" header split the file, so an edit left its stale tail in the latest full text.
test('mergeInstructions splits only on harness file boundaries and declines ambiguous headers', () => {
  const header = (path: string, kind = "user's auto-memory, persists across conversations") => `Contents of ${path} (${kind}):\n\n`
  const full = (memory: string) => `Codebase and user instructions are shown below.\n\n${header('/w/CLAUDE.md', 'project instructions, checked into the codebase')}Keep.\n\n${header('/w/MEMORY.md')}${memory}`
  const delta = (body: string) => `Instruction files were re-read:\n\n${body}`
  const quoted = `- a\n\n${header('/x/notes.md', 'memory')}- tail v1`
  expect(mergeInstructions(full(quoted), delta(header('/w/MEMORY.md') + '- c'))).toBe(full('- c'))
  expect(mergeInstructions(full('- v1'), delta(header('/w/MEMORY.md') + quoted))).toBe(full(quoted))
  expect(mergeInstructions(full(`- a\n\n${header('/w/CLAUDE.md', 'project instructions, checked into the codebase')}- b`), delta(header('/w/MEMORY.md') + '- c'))).toBeUndefined()
  expect(mergeInstructions(full('- v1'), delta(`${header('/w/MEMORY.md')}- a\n\n${header('/w/MEMORY.md')}- b`))).toBeUndefined()
  expect(mergeInstructions(full('- v1'), delta(header('/w/OTHER.md') + '- new'))).toBeUndefined()
})

// Regression caught: after a resume, a digest-only head attachment kept the head, and the changed instructions it also held were neither kept fresh nor carried, so the MEMORY.md edit vanished.
test('after a resume a stale head instructions copy is carried even when another head attachment is digest-only', OPTS, async ($, on) => {
  const full = 'Codebase and user instructions are shown below.\n\nContents of /w/memory/MEMORY.md (user\'s auto-memory, persists across conversations):\n\n- v1'
  const delta = 'Instruction files were re-read after the conversation was compacted; these differ from their earlier copies:\n\nContents of /w/memory/MEMORY.md (user\'s auto-memory, persists across conversations):\n\n- v2'
  const style = 'Use the selected response style exactly.'
  const s: State = { rows: ROWS.slice(0, 1), replies: [ledger('first fold'), ledger('second fold')] }
  const seen = bottoms(on, s)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  const announce = (type: StableAttachmentType, text: string) => $.prompt.attachment({ type, text, origin: 'dynamic' })
  await announce('instructions', full)
  await announce('output_style_instructions', style)
  s.rows = ROWS
  await turnEnds($, s, seen)
  const first = seen.results.at(0)?.messages ?? []
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true } satisfies SessionStartInput)
  expect(await announce('instructions', full)).toEqual({ text: full })
  expect(await announce('instructions', delta)).toEqual({ text: delta })
  s.rows = [...first, M('user', 'continue work'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'continued'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)
  const second = seen.results.at(1)?.messages ?? []
  const carried = second.filter(row => stableAttachmentOf(row)?.type === 'instructions')
  expect(carried).toEqual([])
})

test('instruction removal notices supersede older file sections and survive later re-reads', OPTS, async ($, on) => {
  const full = 'Codebase and user instructions are shown below.\n# Stable instructions'
  const header = 'Instruction files were re-read after the conversation was compacted; these differ from their earlier copies — each replaces its earlier copy, and the instructions preamble above still applies:'
  const older = `${header}\n\nContents of /w/Q.md:\n\nQ rules`
  const removal = `${header}\n\nContents of /w/P.md:\n\nP v1\n\nInstructions no longer present: /w/Q.md`
  const latest = `${header}\n\nContents of /w/P.md:\n\nP v2`
  const retained = `${header}\n\nInstructions no longer present: /w/Q.md`
  const s: State = { rows: [...ROWS], replies: [ledger('first'), ledger('second')] }
  const seen = bottoms(on, s)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))

  await $.prompt.attachment({ type: 'instructions', text: full, origin: 'dynamic' })
  await turnEnds($, s, seen)
  const first = seen.results.at(0)?.messages ?? []
  await $.prompt.attachment({ type: 'instructions', text: older, origin: 'dynamic' })
  await $.prompt.attachment({ type: 'instructions', text: removal, origin: 'dynamic' })
  await $.prompt.attachment({ type: 'instructions', text: latest, origin: 'dynamic' })
  s.rows = [...ROWS, ...first, M('user', 'continue work'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'continued'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)

  const second = seen.results.at(1)?.messages ?? []
  expect(second.map(stableAttachmentOf).filter(row => row?.type === 'instructions')).toEqual([])
})

// Regression caught: a fold re-carried the first request's session-start attachments as user rows, so the UI showed them as typed by the user.
test('head group with attachments does not re-carry them as user rows', OPTS, async ($, on) => {
  const instructions = 'Codebase and user instructions are shown below.\n# Stable instructions'
  const style = 'Use the selected response style exactly.'
  const s: State = { rows: ROWS.slice(0, 1), replies: [ledger('first fold')] }
  const seen = bottoms(on, s)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  const attachment = (type: StableAttachmentType, text: string) => ({ type, text, origin: 'dynamic' })
  await $.prompt.attachment(attachment('instructions', instructions))
  await $.prompt.attachment(attachment('output_style_instructions', style))
  s.rows = ROWS
  await turnEnds($, s, seen)
  const out = seen.results.at(0)?.messages ?? []
  expect(out[0]).toEqual(handled(ROWS)[0]!)
  expect(out[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(out.filter(row => stableAttachmentOf(row) !== undefined)).toEqual([])
  expect(await $.prompt.attachment(attachment('instructions', instructions))).toEqual({ text: instructions })
  expect(await $.prompt.attachment(attachment('output_style_instructions', style))).toEqual({ text: null })
})

// Regression caught: after --resume the head-held attachments were missing from the memory-only state, so the re-announced CLAUDE.md reached the model twice and the next fold carried it as a user row.
test('a resumed session still drops the head-held re-announcement and carries no user row on the next fold', OPTS, async ($, on) => {
  const instructions = 'Codebase and user instructions are shown below.\n# Stable instructions'
  const s: State = { rows: ROWS.slice(0, 1), replies: [ledger('first fold'), ledger('second fold')] }
  const seen = bottoms(on, s)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  const attachment = { type: 'instructions' as const, text: instructions, origin: 'dynamic' }
  await $.prompt.attachment(attachment)
  s.rows = ROWS
  await turnEnds($, s, seen)
  const first = seen.results.at(0)?.messages ?? []
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true } satisfies SessionStartInput)
  expect(await $.prompt.attachment(attachment)).toEqual({ text: instructions })
  s.rows = [...first, M('user', 'continue work'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'continued'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)
  expect(seen.results).toHaveLength(2)
  const second = seen.results.at(1)?.messages ?? []
  expect(second[1]?.text).toMatch(/^\[clm ledger #2 · /)
  expect(second.filter(row => stableAttachmentOf(row) !== undefined)).toEqual([])
})

test('deleting a CLAUDE.md mid-session keeps the original full text carried on the next fold', OPTS, async ($, on) => {
  const instructions = 'Codebase and user instructions are shown below.\n# Stable instructions\nKeep the exact bytes.'
  const deletion = 'Instructions no longer present: /w/CLAUDE.md'
  const s: State = { rows: ROWS, replies: [ledger('first fold'), ledger('second fold')] }
  const seen = bottoms(on, s)
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  const attachment = (text: string) => ({ type: 'instructions' as const, text, origin: 'dynamic' })
  await $.prompt.attachment(attachment(instructions))
  await turnEnds($, s, seen)
  expect(seen.results).toHaveLength(1)
  const first = seen.results.at(0)?.messages ?? []
  expect(await $.prompt.attachment(attachment(deletion))).toEqual({ text: deletion })
  s.rows = [...ROWS, ...first, M('user', 'continue work'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'continued'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)
  expect(seen.results).toHaveLength(2)
  const second = seen.results.at(1)?.messages ?? []
  expect(second.filter(row => stableAttachmentOf(row)?.type === 'instructions')).toEqual([])
})

test('token estimates count CJK scripts and other text separately', () => {
  expect(estTokens(M('user', '한ᄀ漢かカ'))).toBe(8)
  expect(estTokens(M('user', 'x'.repeat(10)))).toBe(5)
})

test('an identical attachment is not dropped when the compact boundary has no carried row', OPTS, async ($, on) => {
  bottoms(on, { rows: [M('user', '[clm ledger #7 · 2026-10-16 12:00 KST]')], replies: [] })
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  const input = { type: 'instructions' as const, text: 'Codebase and user instructions are shown below.\n# Stable instructions', origin: 'dynamic' }
  expect(await $.prompt.attachment(input)).toEqual({ text: input.text })
  expect(await $.prompt.attachment(input)).toEqual({ text: input.text })
})

// Regression caught: a lesson the model invented, with evidence quoted from nowhere in the dropped turns, lands in the lessons file as if verified.
test('a lesson whose evidence is not in the dropped turns is never written to the lessons file', OPTS, async ($, on) => {
  const lessons = [
    { kind: 'fact', lesson: 'make fails at a.ts:12 until the bad import is fixed.', evidence: 'log: make fails at a.ts:12' },
    { kind: 'correction', lesson: 'The user wants pnpm instead of npm.', evidence: 'use pnpm, not npm' },
  ]
  const s: State = { rows: ROWS, replies: [ledger('a.ts:12 is the bad import')], lessonReplies: [JSON.stringify({ lessons })] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const path = '/home/t/.dotfiles/.lessons/lessons.jsonl'
  for (let i = 0; i < 500 && !seen.files[path]; i++) await new Promise(resolve => setTimeout(resolve, 1))
  const written = (seen.files[path] ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line))
  expect(seen.lessonPrompts).toHaveLength(1)
  expect(written.map(record => record.evidence)).toEqual(['log: make fails at a.ts:12'])
  expect(written[0]._sentinel).toContain('LESSON-CONFIDENTIAL')
})

// Regression caught: a second fold loses the first ledger (not fed back from the file) or stacks a second ledger row beside the first.
test('the ledger round-trips through its file and survives a second fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('FIRST-FACT'), ledger('SECOND-FACT', '[]', [{ ref: 'tu_c', quote: 'all 12 tests passed' }])] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const after1 = seen.results[0].messages
  // The stored transcript keeps the pre-fold chain in front of the live one.
  s.rows = [...ROWS, ...after1, M('user', 'add docs'), use('tu_d', 'Write'), res('tu_d', 'w ' + BIG), M('assistant', 'docs added'), M('user', 'push'), M('assistant', 'pushed')]
  await turnEnds($, s, seen)
  expect(seen.prompts[1]).toContain('FIRST-FACT')
  const out = seen.results[1].messages
  expect(out.filter((m: any) => m.text.startsWith('[clm ledger')).length).toBe(1)
  expect(out[1].text).toMatch(/^\[clm ledger #2 · /)
  expect(section(out[1].text, 'learned')).toContain('SECOND-FACT')
  expect(storedLedger(seen)).toContain('SECOND-FACT')
  expect(out.map((m: any) => m.text).filter(Boolean)).toEqual(['please investigate the build', out[1].text, 'push', 'pushed'])
})

// Regression caught: a merged ledger missing a section replaces the memory anyway and silently drops that section.
test('a merged ledger without its 목표 header skips the fold', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['## 핵심 사실·경로\n- a heading the merge no longer writes\n\n<ops>[]</ops>'] }
  const seen = bottoms(on, s)
  const result = compactedMessages(await $.session.compact(compactInput('manual', handled(ROWS))))
  expect(result[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('요약 없이 접힘:')
  expect(logEvents(seen).map(e => e.event)).toEqual(['merge-invalid', 'merge-invalid', 'fallback', 'truncation', 'clear'])
})

// Regression caught: after a fold, reads include the pre-boundary transcript so totals double-count rows the model no longer sees; and /clm output lands in the model's transcript.
test('/clm prints the ledger, a budget line counting only post-boundary rows, and the last decisions', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('LEDGER-ONLY-FACT')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const after = seen.results[0].messages
  s.rows = [...ROWS, ...after]
  const r: any = await $.command.run(commandInput('clm'))
  expect(r.text).toBeUndefined()
  const text = seen.logs.at(-1)!
  const expected = after.reduce((n: number, m: any) => n + est(m), 0)
  expect(text.split('\n')[0]).toBe(`clm budget: ${expected}/2000 tokens (${Math.round(expected / 20)}%); escape at 1900, queue target 100000, tail target 1200, ledger target 300, ratio 1`)
  expect(text).toContain('LEDGER-ONLY-FACT')
  expect(text).toContain('"event":"clear"')
})

// Regression caught (guard 1): when the newest turn alone exceeds the tail target, the fold drops it too and the model loses the turn it is working on.
test('the tail keeps the newest turn even when that turn alone exceeds the tail target', OPTS, async ($, on) => {
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', 'HEAD' + 'z'.repeat(8000) + 'TAIL'), M('assistant', 'dumped')]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(shape(out.slice(2))).toEqual(['dump logs', 'tu_e', 'tu_e', 'dumped'])
})

// Regression caught: a pending plan found the newer of two identical prompts and deleted the rows between it and the planned boundary.
test('a pending fold keeps both identical tail prompts and the turn between them', OPTS, async ($, on) => {
  const rows = [
    M('user', 'start'), M('assistant', 'x'.repeat(9000)),
    M('user', 'old work'), M('assistant', 'x'.repeat(9000)),
    M('user', 'continue'), M('assistant', 'first continuation'),
    M('user', 'between'), M('assistant', 'middle result'),
    M('user', 'continue'), M('assistant', 'second continuation'),
    M('user', 'last'), M('assistant', 'done'),
  ]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out.filter((m: any) => m.text === 'continue').length).toBe(2)
  expect(shape(out)).toContain('between')
  expect(shape(out)).toContain('first continuation')
})

// Regression caught: summary work blocks the turn, or an engine trigger races it with a duplicate summary.
test('an engine trigger joins the turn-end summary and uses its single result', BG_OPTS, async ($, on) => {
  const rows = [M('user', 'protected request'), M('assistant', 'done'), M('user', 'finished topic'), M('assistant', 'A'.repeat(24_000)), M('user', 'active topic'), M('assistant', 'working')]
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let summaryStarted = false
  const s: State = { rows, replies: [], splitBlock: () => { summaryStarted = true; return gate } }
  const seen = bottoms(on, s)
  let returned = false
  const turn = $.turn.complete(TURN).then(() => { returned = true })
  for (let i = 0; i < 50 && !summaryStarted; i++) await new Promise(resolve => setTimeout(resolve, 2))
  const returnedBeforeSummary = await Promise.race([turn.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))])
  const engineCompact = $.session.compact(compactInput('auto', handled(rows)))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(seen.splitPrompts).toHaveLength(1)
  release()
  await turn
  const compacted = compactedMessages(await engineCompact)
  expect(summaryStarted).toBe(true)
  expect(returnedBeforeSummary).toBe(true)
  expect(seen.splitPrompts).toHaveLength(1)
  expect(seen.engineCompactions).toBe(0)
  expect(compacted[0]?.text).toBe('protected request')
  expect(compacted[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(compacted.slice(2)).toEqual(rows.slice(4))
})

// Regression caught: compaction waited on a stalled summary past the engine's 10 s budget instead of folding mechanically at the deadline.
test('a compact whose background summary never finishes folds mechanically at the deadline', { options: { budget: 5000, tailTarget: 300, queueTarget: 1, ledgerTarget: 200, reserve: 100 } }, async ($, on) => {
  const rows = [
    M('user', 'protected request'), M('user', 'finished A'), use('tu_a', 'Bash'), res('tu_a', 'A'.repeat(24_000)), M('assistant', 'A done'),
    M('user', 'active B'), use('tu_b', 'Edit'), res('tu_b', 'B result'), M('assistant', 'B done'),
  ]
  const instruction = 'preserve this instruction exactly'
  let summaryStarted = false
  const s: State = { rows, replies: [], splitBlock: () => { summaryStarted = true; return new Promise<void>(() => {}) } }
  const seen = bottoms(on, s)
  seen.store['clauses:s1:main'] = {
    version: 1, nextId: 2, predicates: { preserve: { key: 0, example: 'preserve(instruction).' } }, clauses: [
      { id: 'C1', head: { name: 'preserve', args: [{ atom: 'instruction' }] }, neg: false, body: [], source: 'preserve(instruction).', text: instruction, quote: instruction, address: '@00000001', promptSeq: 1, issue: null, at: '2026-10-27T00:00:00Z', status: 'live' },
    ],
  }
  seen.files[LEDGER_FILE] = `## 목표\n- keep goal\n\n## 사용자 지시\n- ${JSON.stringify(instruction)}\n\n## 한 일\n- (none yet)\n\n## 핵심 사실·경로\n- (none yet)`
  await $.turn.complete(TURN)
  for (let i = 0; i < 50 && !summaryStarted; i++) await new Promise(resolve => setTimeout(resolve, 2))
  expect(summaryStarted).toBe(true)

  const compact = $.session.compact(compactInput('auto', handled(rows)))
  await seen.clock.advance(7000)
  const outcome = await Promise.race([
    compact.then(result => ({ result })),
    new Promise<{ timeout: true }>(resolve => setTimeout(() => resolve({ timeout: true }), 1000)),
  ])
  if ('timeout' in outcome) throw new Error('compact waited past the deadline for the background summary')
  const result = compactedMessages(outcome.result)
  expect(result.reduce((total, row) => total + est(row), 0)).toBeLessThan(rows.reduce((total, row) => total + est(row), 0))
  expect(result[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(result[1]?.text).toContain(instruction)
  expect(storedLedger(seen)).toContain(JSON.stringify(instruction))
  expect((seen.store['ledger-snapshots:s1:main'] as { coveredRows: string[] }[])[0]?.coveredRows).toContain(fingerprint(rows[3]!))
})

// Regression caught: a background plan finishing after the mechanical swap rolled meta back, stayed parked as stale pending, and blocked the next pre-summary.
test('a background plan completed after a mechanical fold is discarded as stale', { options: { budget: 5000, tailTarget: 300, queueTarget: 1, ledgerTarget: 100, reserve: 100 } }, async ($, on) => {
  const rows = [
    M('user', 'protected request'), M('user', 'finished A'), use('tu_a', 'Bash'), res('tu_a', 'A'.repeat(24_000)), M('assistant', 'A done'),
    M('user', 'active B'), use('tu_b', 'Edit'), res('tu_b', 'B result'), M('assistant', 'B done'),
  ]
  let release!: () => void
  let summaryStarted = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const s: State = { rows, replies: [], splitBlock: () => { summaryStarted = true; return gate } }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  for (let i = 0; i < 50 && !summaryStarted; i++) await new Promise(resolve => setTimeout(resolve, 2))
  expect(summaryStarted).toBe(true)

  const compacting = $.session.compact(compactInput('auto', handled(rows)))
  await seen.clock.advance(7000)
  const mechanical = compactedMessages(await compacting)
  s.rows = [...mechanical]
  release()
  await waitForLog(seen, 'clm: background fold finished after its job was replaced; plan discarded')
  expect(metaIn(seen).seq).toBe(1)
  expect(metaIn(seen).boundary).toBeDefined()
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(seen.engineCompactions).toBe(0)
  s.rows = [...s.rows, M('user', 'next C'), M('assistant', 'C'.repeat(2000))]
  await $.turn.complete(TURN)
  for (let i = 0; i < 50 && seen.splitPrompts.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 2))
  expect(seen.splitPrompts.length).toBeGreaterThan(1)
})

// Regression caught: a compact with no prepared job blocked on an unanswered model call past the engine's 10 s budget.
test('a compact with no job and a silent model folds mechanically at the deadline', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [], mergeBlock: () => new Promise<void>(() => {}) })
  const compact = $.session.compact(compactInput('auto', handled(ROWS)))
  await seen.clock.advance(7000)
  const outcome = await Promise.race([
    compact.then(result => ({ result })),
    new Promise<{ timeout: true }>(resolve => setTimeout(() => resolve({ timeout: true }), 1000)),
  ])
  if ('timeout' in outcome) throw new Error('compact waited past the deadline for the model')
  const result = compactedMessages(outcome.result)
  expect(seen.prompts).toHaveLength(1)
  expect(result.reduce((total, row) => total + est(row), 0)).toBeLessThan(ROWS.reduce((total, row) => total + est(row), 0))
  expect(result[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(seen.engineCompactions).toBe(0)
})

// Regression caught: queueTarget was checked only after turn completion, so long turns entered compact without a summary job.
test('a tool step past queueTarget starts a background fold', BG_OPTS, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(14_000)), M('user', 'active B'), M('assistant', 'working')]
  let release!: () => void
  let summaryStarted = false
  const gate = new Promise<void>(resolve => { release = resolve })
  const seen = bottoms(on, { rows, replies: [], splitBlock: () => { summaryStarted = true; return gate } })
  on('tool.call', () => ({ result: { success: true } }))
  const step = $.tool.call({ tool: 'Bash', command: 'true' } as ToolCallInput)
  const returnedBeforeSummary = await Promise.race([
    step.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250)),
  ])
  for (let i = 0; i < 50 && !summaryStarted; i++) await new Promise(resolve => setTimeout(resolve, 2))
  expect(returnedBeforeSummary).toBe(true)
  expect(summaryStarted).toBe(true)
  expect(seen.splitPrompts).toHaveLength(1)
  release()
  await step
  await waitForPending(seen)
})

// Regression caught: a changed A row let the swap delete turns the summary never saw, and the discarded plan then left the context unshrunk.
test('a background plan whose A rows changed is discarded and the engine summary compacts instead', BG_OPTS, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(24_000)), M('user', 'active B'), M('assistant', 'B result')]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2)] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  s.rows[1] = M('user', 'A changed after summary')
  const unchanged = handled(s.rows)
  const result = compactedMessages(await $.session.compact(compactInput('plugin', unchanged)))
  expect(result.map(m => m.text)).toEqual(ENGINE_SUMMARY_TEXTS)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(seen.engineCompactions).toBe(1)
})

// Regression caught: a split between topics or a tail that cannot fit still produced a destructive plan.
test('a mid-topic split or tail overflow is rejected, retried once, then dropped', { options: { budget: 5000, tailTarget: 300, queueTarget: 1, ledgerTarget: 100, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(12000)), M('user', 'active B'), M('assistant', 'z'.repeat(6000))]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(1.5), splitAnswer(2)] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  for (let i = 0; i < 50 && !seen.logs.some(line => line.includes('split summary dropped')); i++) await new Promise(resolve => setTimeout(resolve, 2))
  expect(seen.splitPrompts).toHaveLength(2)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(seen.logs.some(line => line.includes('split summary dropped'))).toBe(true)
})

// Regression caught: a session opened by an isMeta peer message kept its whole first turn in the head and re-emitted it after every fold.
test('rows ahead of the first request are folded, leaving the ledger right after the request', BG_OPTS, async ($, on) => {
  const fold = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(24_000)), M('user', 'active B'), M('assistant', 'B result')]
  const rows = [use('tu_p', 'Read'), res('tu_p', 'peer turn output'), ...fold]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2)] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const out = compactedMessages(await $.session.compact(compactInput('auto', handled(rows))))
  expect(out[0]?.text).toBe('protected request')
  expect(out[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(out.some(m => m.toolResults?.some(r => r.text === 'peer turn output'))).toBe(false)
})

// Regression caught: applying a precomputed summary changed B after the model selected its split.
test('the applied background fold is head plus ledger plus B verbatim', BG_OPTS, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), use('tu_a', 'Bash'), res('tu_a', 'A'.repeat(24_000)), M('assistant', 'A done'), M('user', 'active B'), use('tu_b', 'Edit'), res('tu_b', 'B result'), M('assistant', 'B done')]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2, 'B topic', 'B summary')], compressionReplies: [compressedTopics([{ topic: 'B topic', summary: 'B summary', seq: 1 }])] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const result = compactedMessages(await $.session.compact(compactInput('plugin', handled(rows))))
  const expectedTail = rows.slice(5).map(({ handle: _handle, ...message }) => message)
  expect(result[0]?.text).toBe('protected request')
  expect(result[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(result.slice(2)).toEqual(expectedTail)
  const clear = logEvents(seen).find(event => event.event === 'clear')!
  expect(typeof clear.summaryMs).toBe('number')
  expect(typeof clear.durationMs).toBe('number')
  expect(metaIn(seen).foldDurationsMs?.['1']).toBe(clear.durationMs)
})

// Regression caught: a compaction below the escape threshold held the ready fold back and handed the rows back unchanged, so the engine kept re-firing.
test('a ready fold swaps on the next compaction even below the escape threshold', { options: { budget: 6000, tailTarget: 5000, queueTarget: 1, ledgerTarget: 300, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(24_000)), M('user', 'active B'), M('assistant', 'B result')]
  const usage = (tokens: number) => ({ startedAt: 0, rateLimits: [], context: { window: 200000, tokens } })
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2)], usage: usage(11_000) }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  s.usage = usage(5800)
  const crossed = compactedMessages(await $.session.compact(compactInput('manual', handled(rows))))
  expect(crossed[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(seen.engineCompactions).toBe(0)
  expect(seen.store['pending:s1']).toBeUndefined()
  expect(storedLedger(seen)).toContain('build summary')
  expect(seen.splitPrompts).toHaveLength(1)
})

// Regression caught: rewinding across an applied fold never restored the prior ledger snapshot.
test('a real rewind restores the prior folded ledger without another summary call', { options: { budget: 6000, tailTarget: 5000, queueTarget: 1, ledgerTarget: 750, reserve: 100 } }, async ($, on) => {
  const rows = [...ROWS]
  rows[2] = res('tu_a', 'log: make fails at a.ts:12 ' + 'A'.repeat(24_000))
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2, 'T1', 'A outcome'), splitAnswer(2, 'T2', 'B outcome')] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const first = compactedMessages(await $.session.compact(compactInput('auto', handled(rows))))
  expect(storedLedger(seen)).toContain('A outcome')
  s.rows = [...first, M('user', 'continue with C'), M('assistant', 'C'.repeat(11_000))]
  await $.turn.complete(turnInput('second-fold'))
  await waitForPending(seen)
  const second = compactedMessages(await $.session.compact(compactInput('auto', handled(s.rows))))
  expect(storedLedger(seen)).toContain('B outcome')
  expect(seen.store['ledger-snapshots:s1:main']).toHaveLength(2)

  s.rows = [...first]
  const calls = seen.splitPrompts.length + seen.prompts.length + seen.compressionPrompts.length
  const restored = compactedMessages(await $.session.compact(compactInput('plugin', handled(s.rows))))
  expect(restored.some(row => row.text.startsWith('[clm ledger #'))).toBe(true)
  expect(storedLedger(seen)).toContain('A outcome')
  expect(storedLedger(seen)).not.toContain('B outcome')
  expect(seen.splitPrompts.length + seen.prompts.length + seen.compressionPrompts.length).toBe(calls)
})

// Regression caught: a repeated short prompt fingerprint made an intact ledger look like an un-restorable rewind.
test('a duplicated short prompt rewind leaves the ledger intact', { options: { budget: 5000, tailTarget: 3000, queueTarget: 1, ledgerTarget: 750, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'protected request'), M('user', 'continue'), M('assistant', 'A'.repeat(14_000)), M('user', 'continue'), M('assistant', 'B work'), M('user', 'continue'), M('assistant', 'C work')]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2, 'T1', 'durable ledger')] }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const compacted = compactedMessages(await $.session.compact(compactInput('auto', handled(rows))))
  const before = storedLedger(seen)
  const repeated = compacted.findIndex((row, index) => index > 1 && row.role === 'user' && row.text === 'continue')
  if (repeated < 0) throw new Error('fixture has no repeated short prompt in the kept tail')
  s.rows = compacted.filter((_row, index) => index !== repeated)
  await $.session.compact(compactInput('plugin', handled(s.rows)))
  expect(storedLedger(seen)).toBe(before)
  expect(seen.logs.some(line => line.includes('restored ledger snapshot'))).toBe(false)
})

// Regression caught: re-folding kept T1 at its old size or discarded an exact user instruction.
test('ledger recompression shrinks the old topic and preserves each user instruction verbatim', { options: { budget: 5000, tailTarget: 1200, queueTarget: 1, ledgerTarget: 250, reserve: 100 } }, async ($, on) => {
  const instruction = 'Keep the public API stable while changing the parser.'
  const oldSummary = 'T1 '.repeat(160)
  const oldLedger = `[clm ledger #1 · 2026-10-14 09:00 KST] Earlier turns of this session were folded into these notes by a Haiku summary (file: ${LEDGER_FILE}).\n\n## 목표\n- T1: ${oldSummary}\n\n## 사용자 지시\n- (none yet)\n\n## 한 일\n- (none yet)\n\n## 할 일\n- (none yet)\n\n## 미결 질문\n- (none yet)\n\n## 핵심 사실·경로\n- (none yet)`
  const rows = [M('user', 'protected request'), M('user', oldLedger), M('user', instruction), M('assistant', 'A'.repeat(24_000)), M('user', 'continue with B'), M('assistant', 'B result')]
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2, 'T2', 'new topic summary')], compressionReplies: [compressedTopics([
    { topic: 'T1', summary: 'T1 closed outcome', seq: 1 },
    { topic: 'T2', summary: 'new topic summary', seq: 2 },
  ])] }
  const seen = bottoms(on, s)
  seen.files[LEDGER_FILE] = oldLedger
  seen.store['ledger:s1'] = { seq: 1, fails: 0 }
  seen.store['topics:s1'] = [{ topic: 'T1', summary: oldSummary, seq: 1 }]
  await $.turn.complete(TURN)
  await waitForPending(seen)
  const result = compactedMessages(await $.session.compact(compactInput('plugin', handled(rows))))
  const ledgerRow = result[1]?.text ?? ''
  expect(seen.compressionPrompts).toHaveLength(1)
  expect(storedLedger(seen)).toContain('T1:')
  expect(ledgerRow).toContain('T1: T1 closed outcome')
  expect(ledgerRow).not.toContain(oldSummary)
  const ledgerMessage = result[1]
  if (!ledgerMessage) throw new Error('fold omitted the ledger message')
  expect(est(ledgerMessage)).toBeLessThanOrEqual(250)
  expect(instructionValues(storedLedger(seen))).toContain(instruction)
})

// Regression caught (guards 2 and 6): a fold cut the tool result of the newest turn while that command was still in progress.
test('an oversized result in an older kept turn is cut while the newest turn stays whole', { options: { budget: 5000, tailTarget: 3000, queueTarget: 100_000, reserve: 100 } }, async ($, on) => {
  const olderResult = 'HEAD' + 'z'.repeat(16000) + 'TAIL'
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', olderResult), M('assistant', 'dumped'), M('user', 'ok'), M('assistant', 'ok')]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  const result = out.find((m: any) => m.toolResults?.[0]?.tool_use_id === 'tu_e').toolResults[0].text
  expect(result.startsWith('HEAD')).toBe(true)
  expect(result.endsWith('TAIL')).toBe(true)
  expect(result).toMatch(new RegExp(`…\\[clm: \\d+ of ${olderResult.length} chars cut at fold time\\]…`))
  expect(result.length).toBeLessThan(4 * 1200)
  expect(storedLedger(seen)).toContain('- 출력 과다: Bash {"id":"tu_e"}')
  expect(logEvents(seen).map(e => e.event)).toContain('truncation')
  expect(out.find((m: any) => m.text === 'ok')).toBeDefined()
})

// Regression caught: oversize notes pile up in the ledger without bound across folds.
test('only the last five oversize notes stay in the ledger', { options: { budget: 2000, tailTarget: 1600, queueTarget: 100000, ledgerTarget: 300, reserve: 100 } }, async ($, on) => {
  const old = ['a', 'b', 'c', 'd', 'e'].map(c => `- 출력 과다: Bash old-${c}`).join('\n')
  const rows = [...ROWS, M('user', 'dump logs'), use('tu_e', 'Bash'), res('tu_e', 'z'.repeat(16000)), M('assistant', 'dumped'), M('user', 'ok'), M('assistant', 'ok')]
  const s: State = { rows, replies: [ledger('new fact')] }
  const seen = bottoms(on, s)
  // Oversize notes are harness lines: an earlier fold left five in the stored ledger.
  seen.files[LEDGER_FILE] = `## 목표\n- g\n\n## 사용자 지시\n- (none yet)\n\n## 핵심 사실·경로\n- kept fact — quote: "log"\n${old}`
  await turnEnds($, s, seen)
  const notes = storedLedger(seen).split('\n').filter((l: string) => l.includes('출력 과다:'))
  expect(notes.length).toBe(5)
  expect(notes[0]).toContain('old-b')
  expect(notes[4]).toContain('tu_e')
  expect(storedLedger(seen)).toContain('kept fact')
})

// Regression caught (guard 3): a fold whose ledger outweighs the turns it drops makes the context bigger, and the next turn folds again.
test('a fold that would not shrink the context is skipped with both sizes logged', { options: { budget: 2000, tailTarget: 1990, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'start'), M('user', 'a'), M('assistant', 'A'), M('user', 'b'), M('assistant', 'B'), M('user', 'go'), M('assistant', 'w'.repeat(7600))]
  const s: State = { rows, replies: [ledger('p'.repeat(1700))] }
  const seen = bottoms(on, s)
  await $.session.compact(compactInput('manual', handled(rows)))
  expect(seen.store['pending:s1']).toBeUndefined()
  const line = seen.logs.find(l => l.includes('would not shrink'))!
  expect(line).toMatch(/\(\d+ -> \d+ est\. tokens\)/)
  const ev = logEvents(seen).find(e => e.event === 'skip-not-shrinking')
  expect(ev.tokensAfter).toBeGreaterThanOrEqual(ev.tokensBefore)
})

// Regression caught: an engine-requested compaction could not shrink the transcript after a malformed merge.
test('an engine manual compaction uses a mechanical ledger when the merge fails', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: ['bad'] }
  const seen = bottoms(on, s)
  const result = compactedMessages(await $.session.compact(compactInput('manual', handled(ROWS))))
  const row = result[1]?.text ?? ''
  expect(row).toMatch(/^\[clm ledger #1 · /)
  expect(section(row, '핵심 사실·경로')).toBe('')
  expect(section(storedLedger(seen), '핵심 사실·경로')).toContain('요약 없이 접힘:')
  expect(logEvents(seen).map(e => e.event)).toEqual(['merge-invalid', 'merge-invalid', 'fallback', 'truncation', 'clear'])
})

// Regression caught: system prompt tokens in usage blocked a queue-triggered background summary, or inflated the ratio it calibrated.
test('queueTarget schedules the background fold independently of the usage reading', { options: { budget: 3000, tailTarget: 2000, queueTarget: 1, ledgerTarget: 600, reserve: 100 } }, async ($, on) => {
  const rows = ROWS
  const usage = (tokens: number) => ({ startedAt: 0, rateLimits: [], context: { window: 200000, tokens } })
  const s: State = { rows, replies: [], splitReplies: [splitAnswer(2)], usage: usage(6000) }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  await waitForPending(seen)
  expect(metaIn(seen).ratio ?? 1).toBeLessThan(1.1)
  expect(seen.store['pending:s1']).toBeDefined()
})

// Regression caught: an overhead treated as implausible kept ratio at 1 forever.
test('a second fold calibrates ratio from a usable fixed-prefix overhead', { options: { budget: 5000, tailTarget: 1000, queueTarget: 100000, ledgerTarget: 300, reserve: 100 } }, async ($, on) => {
  const usage = (tokens: number) => ({ startedAt: 0, rateLimits: [], context: { window: 200000, tokens } })
  const firstRows = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(24_000)), M('user', 'active B'), M('assistant', 'B result')]
  const s: State = { rows: firstRows, replies: [ledger('first'), ledger('second')], usage: usage(50_000) }
  const seen = bottoms(on, s)
  const first = compactedMessages(await $.session.compact(compactInput('manual', handled(firstRows))))
  const overhead = metaIn(seen).overhead
  expect(typeof overhead).toBe('number')
  if (typeof overhead !== 'number') throw new Error('first fold did not store calibration overhead')

  const added = [M('user', 'finished C'), M('assistant', 'C'.repeat(16_000)), M('user', 'active D'), M('assistant', 'D result')]
  const visible = [...first, ...added]
  const secondReading = overhead + visible.reduce((total, row) => total + est(row), 0) * 3
  s.rows = [...firstRows, ...visible]
  s.usage = usage(secondReading)
  await $.session.compact(compactInput('manual', handled(s.rows)))

  expect(typeof metaIn(seen).ratio).toBe('number')
  expect(metaIn(seen).ratio).not.toBe(1)
})

// Regression caught: system usage alone scheduled a summary while the queue stayed below queueTarget.
test('a queue below queueTarget does not schedule a summary for a large usage reading', OPTS, async ($, on) => {
  // The 6000-token reading is mostly system prompt; the message queue stays below the configured 100000-token target.
  const s: State = { rows: ROWS.slice(4), replies: [ledger('x')], usage: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 6000 } } }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect(seen.prompts.length).toBe(0)
  expect(seen.store['pending:s1']).toBeUndefined()
  // A later usage baseline does not change the queue-size trigger.
  seen.store['ledger:s1'] = { seq: 1, fails: 0, overhead: 4800, ratio: 1 }
  await $.turn.complete(TURN)
  expect(seen.prompts.length).toBe(0)
})

// Regression caught: the usage reading from before a fold was read as current after it, so every later turn folded again.
test('a turn after a fold with an unchanged usage reading does not fold again', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('x'), ledger('y')], usage: { startedAt: 0, rateLimits: [], context: { window: 200000, tokens: 6000 } } }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  expect(seen.prompts.length).toBe(1)
  s.rows = [...ROWS, ...seen.results[0].messages, M('user', 'ok'), M('assistant', 'fine')]
  await $.turn.complete(TURN)
  expect(seen.prompts.length).toBe(1)
  expect(seen.store['pending:s1']).toBeUndefined()
})

// Regression caught (guard 7): empty and "(no content)" rows carried into the rewritten transcript waste context and can be refused by the API.
test('empty and "(no content)" rows are dropped from the fold result', OPTS, async ($, on) => {
  const rows = [...ROWS.slice(0, 12), M('assistant', '(no content)'), M('assistant', ''), ...ROWS.slice(12)]
  const s: State = { rows, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const out = seen.results[0].messages
  expect(out.some((m: any) => m.text === '(no content)' || (m.text === '' && ids(m).length === 0))).toBe(false)
})

// Regression caught (guard 8): a fold or skip leaves nothing to diagnose it from after the fact.
test('every fold writes a JSONL decision line with sizes, kept turns and ratio', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('x')] }
  const seen = bottoms(on, s)
  await turnEnds($, s, seen)
  const clear = logEvents(seen).find(e => e.event === 'clear')
  expect(Object.keys(clear).sort()).toEqual(['durationMs', 'event', 'keptTurns', 'ratio', 'reason', 'summaryMs', 'tokensAfter', 'tokensBefore', 'ts'])
  expect(clear.keptTurns).toBe(2)
  expect(clear.tokensAfter).toBeLessThan(clear.tokensBefore)
})

// Regression caught (guard 9): a budget under 2000 or a reserve over the budget is silently replaced and the user never learns the setting was ignored.
test('a bad option is logged with the value actually used', { options: { budget: 100, tailTarget: 50000, queueTarget: 0, ledgerTarget: 2000, reserve: 9999 } }, async ($, on) => {
  const s: State = { rows: [], replies: [] }
  const seen = bottoms(on, s)
  await $.session.start({ cwd: '/work/repo', surface: 'terminal', isInteractive: true } satisfies SessionStartInput)
  expect(seen.logs).toContain('clm: option budget=100 must be an integer of at least 2000; using 2000')
  expect(seen.logs).toContain('clm: option tailTarget=50000 must be a positive integer under the budget (2000); using 1000')
  expect(seen.logs).toContain('clm: option queueTarget=0 must be a positive integer; using 8000')
  expect(seen.logs).toContain('clm: option ledgerTarget=2000 must be a non-negative integer under tailTarget (1000); using 250')
  expect(seen.logs).toContain('clm: option reserve=9999 must be a positive integer under the budget (2000); using 500')
})

// Regression caught: with no plan pending, the engine's threshold or a /compact runs its own summarizer and replaces the ledger with an engine summary.
test('auto compaction with no pending plan produces a clm ledger instead of an engine summary', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('INLINE-FACT'), 'not a ledger'] }
  const seen = bottoms(on, s)
  const auto = compactedMessages(await $.session.compact(compactInput('auto', handled(ROWS))))
  expect(auto[1].text).toMatch(/^\[clm ledger #1 · /)
  expect(section(auto[1].text, 'learned')).toContain('INLINE-FACT')
  expect(storedLedger(seen)).toContain('INLINE-FACT')
  expect(seen.engineCompactions).toBe(0)
  // Nothing is left for clm to fold here, so the engine summary is the only way the context still shrinks.
  const manual = compactedMessages(await $.session.compact(compactInput('manual', handled([...auto, M('user', 'more'), use('tu_f', 'Bash'), res('tu_f', BIG), M('assistant', 'ok')]))))
  expect(manual.map(m => m.text)).toEqual(ENGINE_SUMMARY_TEXTS)
  expect(seen.engineCompactions).toBe(1)
})

// Regression caught: a non-shrinking compaction job handed the rows back unchanged, so autocompact re-fired every turn until the engine reported thrashing.
test('a non-shrinking auto job hands off to the engine summary after its escape attempt', { options: { budget: 2000, tailTarget: 1990, reserve: 100 } }, async ($, on) => {
  const rows = [M('user', 'start'), M('user', 'a'), M('assistant', 'A'), M('user', 'b'), M('assistant', 'B'), M('user', 'go'), M('assistant', 'w'.repeat(7600))]
  const s: State = { rows, replies: [ledger('p'.repeat(1700))] }
  const seen = bottoms(on, s)
  const r = await $.session.compact({ trigger: 'auto', messages: handled(rows) })
  if (!('messages' in r)) throw new Error('compaction returned no messages')
  expect(r.messages?.map(m => m.text)).toEqual(ENGINE_SUMMARY_TEXTS)
  expect(seen.engineCompactions).toBe(1)
  expect(logEvents(seen).find(e => e.event === 'escape')).toBeDefined()
})

// Regression caught: engine handoff discarded the clause store from the live context, so the next turn had no user instructions.
test('an engine handoff keeps the user clauses as a [clm clauses] row', OPTS, async ($, on) => {
  const rows = [M('user', 'start')]
  const seen = bottoms(on, { rows, replies: [] })
  seen.store['clauses:s1:main'] = {
    version: 1, nextId: 2, predicates: { forbid: { key: 0, example: 'forbid(push).' } }, clauses: [
      { id: 'C1', head: { name: 'forbid', args: [{ atom: 'push' }] }, neg: false, body: [], source: 'forbid(push).', text: 'origin에 push하지 않는다.', quote: 'Never push to origin.', address: '@00000001', promptSeq: 1, issue: null, at: '2026-10-27T00:00:00Z', status: 'live' },
    ],
  }
  const out = compactedMessages(await $.session.compact(compactInput('manual', handled(rows))))
  expect(out.map(row => row.text)).toEqual(['ENGINE SUMMARY', '[clm clauses]\n- origin에 push하지 않는다. (C1 @00000001)'])
})

const FOLD_ROWS = [M('user', 'protected request'), M('user', 'finished A'), M('assistant', 'A'.repeat(6000)), M('user', 'active B'), M('assistant', 'B result')]

// Regression caught: the background fold started on queue size alone, far below the 60% point, or never started at it.
test('an unset budget starts the background fold once usage crosses 60% of the window', { options: { tailTarget: 1200, queueTarget: 1, ledgerTarget: 300 } }, async ($, on) => {
  const usage = (tokens: number) => ({ startedAt: 0, rateLimits: [], context: { window: 10000, tokens } })
  const s: State = { rows: FOLD_ROWS, replies: [], splitReplies: [splitAnswer(2)], usage: usage(5900) }
  const seen = bottoms(on, s)
  await $.turn.complete(TURN)
  expect(seen.splitPrompts).toHaveLength(0)
  s.usage = usage(6000)
  await $.turn.complete({ ...TURN, turnId: 'crossed' })
  await waitForPending(seen)
  expect(seen.splitPrompts).toHaveLength(1)
})

// Regression caught: /force-compact was swallowed by the clm fold, so the engine summarizer never ran.
test('/force-compact hands one compaction to the engine summarizer', OPTS, async ($, on) => {
  const seen = bottoms(on, { rows: ROWS, replies: [] })
  await $.command.run(commandInput('force-compact', ' keep the plan '))
  await seen.clock.advance(1)
  expect(seen.engineCompactions).toBe(1)
  expect(seen.prompts).toEqual([])
})

// Regression caught: the force flag stayed armed, so every later /compact or auto compaction bypassed clm too.
test('after /force-compact, the next manual compaction is clm-owned again', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('a.ts:12 is the bad import')] }
  const seen = bottoms(on, s)
  await $.command.run(commandInput('force-compact'))
  await seen.clock.advance(1)
  const out = compactedMessages(await $.session.compact(compactInput('manual', handled(ROWS))))
  expect(seen.engineCompactions).toBe(1)
  expect(out[1]?.text).toMatch(/^\[clm ledger #1 · /)
})

// Regression caught: meta.boundary kept pointing into the pre-compaction chain, so the next fold read rows the engine had already summarized.
test('after /force-compact, clm folds from the engine summary onward', OPTS, async ($, on) => {
  const live = [M('user', 'ENGINE SUMMARY'), ...ROWS]
  const s: State = { rows: [...ROWS, ...live], replies: [ledger('a.ts:12 is the bad import')] }
  const seen = bottoms(on, s)
  await $.command.run(commandInput('force-compact'))
  await seen.clock.advance(1)
  expect(metaIn(seen).boundary).toEqual({ fp: fingerprint(M('user', 'ENGINE SUMMARY')), offset: 0 })
  const out = compactedMessages(await $.session.compact(compactInput('manual', handled(live))))
  expect(out[0]?.text).toBe('ENGINE SUMMARY')
  expect(out[1]?.text).toMatch(/^\[clm ledger #1 · /)
  expect(seen.engineCompactions).toBe(1)
})

// Regression caught: a handoff after a clm fold left the observed transcript on the pre-summary rows, so the next observation read the ledger row as rewound away and rolled the ledger back one snapshot per autocompact.
test('a handoff after a clm fold keeps the ledger', OPTS, async ($, on) => {
  const s: State = { rows: ROWS, replies: [ledger('INLINE-FACT'), 'not a ledger'] }
  const seen = bottoms(on, s)
  const auto = compactedMessages(await $.session.compact(compactInput('auto', handled(ROWS))))
  expect(storedLedger(seen)).toContain('INLINE-FACT')
  const manual = compactedMessages(await $.session.compact(compactInput('manual', handled([...auto, M('user', 'more'), use('tu_f', 'Bash'), res('tu_f', BIG), M('assistant', 'ok')]))))
  expect(manual.map(m => m.text)).toEqual(ENGINE_SUMMARY_TEXTS)
  s.rows = [...manual, M('user', 'next'), M('assistant', 'done')]
  await $.session.compact(compactInput('plugin', handled(s.rows)))
  expect(storedLedger(seen)).toContain('INLINE-FACT')
})
