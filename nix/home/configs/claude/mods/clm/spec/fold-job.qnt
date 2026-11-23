// Run: nice -n 15 quint run nix/home/configs/claude/mods/clm/spec/fold-job.qnt --main current --invariants noCompactAfterUnhandled noSummaryDropLoop noReinjection noLoss unhandledStaysInContext unhandledCompactRetiresReady --witnesses wCompactUnhandled --max-steps 40 --max-samples 5000 --n-threads 2 --seed 0x1
// Red on the code before the fixes: the same command with --main head (unhandledStaysInContext, noReinjection), --main prefix (noReinjection) or --main unguarded (noCompactAfterUnhandled)
// Regenerate the conformance traces (hooks/fold-conformance.test.ts): nice -n 15 sh nix/home/configs/claude/mods/clm/spec/fold-job-traces.sh
//
// The clm background fold job (hooks/fold-job.ts) as a state machine: a turn end starts a summary job, a compaction
// waits up to its 7 s deadline for it, applyFoldPlan persists the swap step by step, and user messages typed while
// the model works ride the queued-message store until a fold retires them. Sizes are one symbolic level: whether the
// newest turn plus the ledger row fits tailTarget. Instances at the bottom bind the current code, the code at
// 9928335 (before the carry and retire fixes) and the code at 520a61f (before 5884744).
module foldJob {
  // true: fold-job.ts at 5884744; false: at 520a61f.
  const FIXED: bool
  // true: a carried message stays in the store and its folded row stays until a reply follows it (fold.ts
  // buildCleared, fold-job.ts applyFoldPlan); false (9928335): the swap retired it and the next swap removed its row.
  const KEEP_UNHANDLED: bool
  // true: a retire first lands in fold-job.ts's in-memory retired set, which no write can fail, and every read of the
  // queue skips it; false (9928335): a failed write left the message in the queue the next fold reads.
  const RETIRE_IN_MEMORY: bool
  // Whether io.markQueuedMessagesFolded itself may throw (register.ts:603, a host state update).
  const RETIRE_MAY_FAIL: bool
  // Mutation toggle: false removes the post-unhandled guards from clm compaction and fold starts.
  const GUARD_UNHANDLED: bool
  const MSGS: Set[int]

  type Msg = {
    typed: bool,      // the host appended the queued_command attachment (register.ts:589-597)
    inStore: bool,    // still in the clm queuedMessages store, so withQueuedMessages re-inserts it (fold.ts:90)
    inContext: bool,  // present in the conversation the model reads
    handled: bool,    // an assistant row follows it, so buildCleared does not carry it (fold.ts:261-262)
    carried: int,     // times a swap emitted it as a `folded` row after the ledger row (fold.ts:262-269)
    engine: bool,     // a handOff to the engine summarizer covered it (fold-job.ts:699-705)
    foldedRow: bool,  // its `folded` row is in the conversation
    typedAt: int,     // clock of its typeMsg
    repliedAt: int,   // clock of the first assistantReply after it, 0 while none
    retired: bool,    // in fold-job.ts's in-memory retired set (RETIRE_IN_MEMORY)
    left: bool,       // a swap folded it away together with its reply
    reinjected: bool, // a swap read it from the queue after it left or the engine summary covered it
  }
  // phase: idle | bg (split summary) | single | engine | ready | swapping
  // snap: queued messages in the rows the job planned over; csnap: those in the rows a waiting compaction read.
  // snapAt / csnapAt: the clock when those rows were read, so a reply after it is outside the rows.
  type Job = { phase: str, attempt: int, fits: bool, snap: Set[int], csnap: Set[int], snapAt: int, csnapAt: int, mechanical: bool }
  type Swap = { active: bool, pc: int, dropped: Set[int] }

  var msgs: int -> Msg
  var job: Job
  var compactWaiting: bool
  var lastAction: str
  var swap: Swap
  // Set when a job ends without a plan because its split overflowed tailTarget twice.
  var endedNoPlanOnOverflow: bool
  // Ticks on typeMsg and assistantReply: rows sit in the conversation in clock order.
  var clock: int
  var seen: Set[str]
  var compactionDisabled: bool

  pure val idleJob: Job = { phase: "idle", attempt: 0, fits: true, snap: Set(), csnap: Set(), snapAt: 0, csnapAt: 0, mechanical: false }
  pure val noSwap: Swap = { active: false, pc: 0, dropped: Set() }
  pure val freshMsg: Msg = { typed: false, inStore: false, inContext: false, handled: false, carried: 0, engine: false, foldedRow: false, typedAt: 0, repliedAt: 0, retired: false, left: false, reinjected: false }

  // Persist order in applyFoldPlan. 5884744 retires queued messages in their own persistStep before the
  // persistCompactResult block (fold-job.ts:590-591); 520a61f retired them last inside that block, so any
  // earlier failing write skipped it (git show 520a61f:.../fold-job.ts, markQueuedMessagesFolded after
  // markStableAttachmentsCarried).
  pure def steps(fixed: bool): List[str] =
    if (fixed) ["retire", "ledger", "snapshot", "meta", "done"]
    else ["ledger", "snapshot", "meta", "retire", "done"]
  pure val DONE = 4

  // startFoldJob's route (fold-job.ts:436-446): 520a61f split whenever turns >= 2; 5884744 also requires the newest
  // turn plus the ledger row to fit tailTarget.
  pure def routeToSplit(fixed: bool, twoTurns: bool, fits: bool): bool = twoTurns and (not(fixed) or fits)

  // The queue a fold reads: the store less the in-memory retired set (fold-job.ts rowsWithQueuedMessages).
  pure def stored(ms: int -> Msg): Set[int] = ms.keys().filter(m => ms.get(m).inStore and not(ms.get(m).retired))

  // A cut is a prefix of the rows, which hold the queued messages in typing order (withQueuedMessages anchors each
  // after the row before it and after the messages it placed there before, fold.ts withQueuedMessages; a carried
  // folded row sits right after the ledger row and was typed before every message still queued), so the dropped
  // queued messages are a proper typing-order prefix of those read: a swap keeps a tail, while an empty-tail plan
  // is stale and hands off.
  pure def isTypingPrefix(ms: int -> Msg, read: Set[int], dropped: Set[int]): bool =
    dropped.forall(m => read.exclude(dropped).forall(k => ms.get(m).typedAt < ms.get(k).typedAt))

  // The cut drops every row up to the first kept queued message, or every row read: its replies are the clock values
  // below this bound. A narrower cut that kept a reply in the tail would carry its message too; the model omits it.
  pure def cutBound(ms: int -> Msg, read: Set[int], dropped: Set[int], readAt: int): int = {
    val kept = read.exclude(dropped)
    kept.fold(readAt + 1, (b, k) => if (ms.get(k).typedAt < b) ms.get(k).typedAt else b)
  }

  // buildCleared (fold.ts): a dropped message with no assistant row after it among the folded rows is carried as a
  // folded row after the ledger row, one with such a row leaves context. KEEP_UNHANDLED: a folded row the cut keeps
  // stays, one it drops is carried again or leaves by the same rule; 9928335 removed every folded row (head and tail
  // filtered isQueuedMessage, and the retired message was no queued source to carry). A read message that already left
  // or that the engine summary covered is a fresh source row whose reply is gone: it comes back.
  pure def applyDrop(ms: int -> Msg, read: Set[int], dropped: Set[int], bound: int): int -> Msg =
    ms.keys().mapBy(m => {
      val r0 = ms.get(m)
      val back = read.contains(m) and (r0.left or r0.engine)
      val r1 = if (back) { ...r0, reinjected: true, inContext: true } else r0
      val r = if (r1.foldedRow and not(KEEP_UNHANDLED)) { ...r1, inContext: false, foldedRow: false } else r1
      if (not(dropped.contains(m))) r
      else if (not(back) and r.repliedAt > 0 and r.repliedAt < bound) { ...r, inContext: false, foldedRow: false, left: true }
      else { ...r, carried: r.carried + 1, inContext: true, foldedRow: true }
    })

  // A retire takes `which` off the queue the next fold reads; a write that lands also takes every message the
  // in-memory set holds out of the store, since each write passes that set along (fold-job.ts retireQueued).
  pure def retire(ms: int -> Msg, which: Set[int], ok: bool): int -> Msg =
    ms.keys().mapBy(m => {
      val r = ms.get(m)
      val marked = which.contains(m) or (RETIRE_IN_MEMORY and r.retired)
      { ...r, retired: r.retired or (RETIRE_IN_MEMORY and which.contains(m)), inStore: r.inStore and not(ok and marked) }
    })
  // What applyFoldPlan retires: the dropped messages, less those it carries when KEEP_UNHANDLED.
  pure def retiring(ms: int -> Msg, dropped: Set[int]): Set[int] =
    if (KEEP_UNHANDLED) dropped.filter(m => not(ms.get(m).foldedRow)) else dropped

  // ---- user and model ----

  // src: register.ts:583-597 captureAppendedRow (queued_command attachment -> storeQueuedMessage)
  action typeMsg(m: int): bool = all {
    not(msgs.get(m).typed),
    msgs' = msgs.set(m, { ...freshMsg, typed: true, inStore: true, inContext: true, typedAt: clock + 1 }),
    clock' = clock + 1,
    job' = job, compactWaiting' = compactWaiting, lastAction' = "typeMsg", swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow, compactionDisabled' = compactionDisabled,
    seen' = if (job.phase != "idle") seen.union(Set("typedDuringFold")) else seen,
  }

  // The model answers: every queued message in context now has an assistant row after it.
  action assistantReply: bool = all {
    msgs.keys().exists(m => msgs.get(m).inContext and not(msgs.get(m).handled)),
    msgs' = msgs.keys().mapBy(m => {
      val r = msgs.get(m)
      if (r.inContext and not(r.handled)) { ...r, handled: true, repliedAt: clock + 1 } else r
    }),
    clock' = clock + 1,
    job' = job, compactWaiting' = compactWaiting, lastAction' = "assistantReply", swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen, compactionDisabled' = compactionDisabled,
  }

  // ---- summary job ----

  // src: fold-job.ts:492-515 maybeClear -> startFoldJob(turnEnd=true), fold-job.ts:422-469
  action turnEnd(twoTurns: bool, fits: bool): bool = all {
    job.phase == "idle", not(compactWaiting), not(swap.active), not(compactionDisabled) or not(GUARD_UNHANDLED),
    job' = { ...idleJob, phase: if (routeToSplit(FIXED, twoTurns, fits)) "bg" else "single", fits: fits, snap: stored(msgs), snapAt: clock },
    clock' = clock, msgs' = msgs, compactWaiting' = compactWaiting, lastAction' = "turnEnd", swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen, compactionDisabled' = compactionDisabled,
  }

  // One split-merge attempt. src: fold-job.ts:261-328 prepareBackgroundFold
  // outcome: noReply (no text / rejected / invalid merge), skip (fold returned a string), overflow, ok.
  // When the newest turn does not fit, every split overflows: B always ends with it (fold-job.ts:436-439).
  pure def bgNext(j: Job, outcome: str, fixed: bool): Job =
    if (outcome == "ok") { ...j, phase: "ready" }
    else if (outcome == "skip") { ...j, phase: "idle" }
    else if (j.attempt == 0) { ...j, attempt: 1 }
    else if (outcome == "overflow" and fixed) { ...j, phase: "single" }   // fold-job.ts:301-309
    else { ...j, phase: "idle" }                                           // 520a61f: "background fold dropped"

  action bgAttempt(outcome: str): bool = all {
    job.phase == "bg",
    outcome != "ok" or job.fits,
    val nextJob = bgNext(job, outcome, FIXED)
    all {
      job' = nextJob,
      // The job ends with no plan right after the second split overflowed.
      endedNoPlanOnOverflow' = (endedNoPlanOnOverflow or (outcome == "overflow" and job.attempt == 1 and nextJob.phase == "idle")),
      seen' = if (outcome == "overflow" and job.attempt == 1 and nextJob.phase == "single") seen.union(Set("singleAfterOverflow")) else seen,
    },
    clock' = clock, msgs' = msgs, compactWaiting' = compactWaiting, lastAction' = "bgAttempt", swap' = swap, compactionDisabled' = compactionDisabled,
  }

  // src: fold-job.ts:363-377 prepareSingleFold; fold-job.ts:379-401 prepareEngineFold
  action finishFold(ok: bool): bool = all {
    job.phase == "single" or job.phase == "engine",
    job' = { ...job, phase: if (ok) "ready" else "idle" },
    clock' = clock, msgs' = msgs, compactWaiting' = compactWaiting, lastAction' = "finishFold", swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen, compactionDisabled' = compactionDisabled,
  }

  // ---- compaction ----

  // src: fold-job.ts:732-752 compactOrHandOff; an idle job starts startFoldJob(turnEnd=false), a running one is awaited.
  action requestCompact: bool = all {
    not(compactWaiting), not(swap.active), job.phase != "ready", not(compactionDisabled) or not(GUARD_UNHANDLED),
    compactWaiting' = true,
    job' = if (job.phase == "idle") { ...idleJob, phase: "engine", snap: stored(msgs), csnap: stored(msgs), snapAt: clock, csnapAt: clock }
      else { ...job, csnap: stored(msgs), csnapAt: clock },
    clock' = clock, msgs' = msgs, lastAction' = "requestCompact", swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen, compactionDisabled' = compactionDisabled,
  }

  // Start the swap of a plan over the rows read at readAt, which held the queued messages in `read`.
  // src: fold-job.ts:776-789, applyFoldPlan fold-job.ts:536-593 (buildCleared builds the result before persisting)
  action startSwap(read: Set[int], readAt: int, mechanical: bool): bool = all {
    val live = read.intersect(stored(msgs))
    // Every cut lands on a turn start (fold.ts planClear, the split's turn), and a carried folded row sits right after
    // the ledger row ahead of every turn start, so a swap that reads one drops it again.
    nondet dropped = live.powerset().filter(d => (live == Set() or d != live) and isTypingPrefix(msgs, live, d) and live.filter(m => msgs.get(m).foldedRow).subseteq(d)).oneOf()
    val swapped = applyDrop(msgs, live, dropped, cutBound(msgs, live, dropped, readAt))
    all {
      msgs' = swapped,
      swap' = { active: true, pc: 0, dropped: dropped },
      seen' = seen.union(if (mechanical) Set("mechanical") else Set())
        .union(if (dropped.exists(m => swapped.get(m).carried > msgs.get(m).carried)) Set("carried") else Set()),
    },
    job' = { ...job, phase: "swapping", mechanical: mechanical },
    compactWaiting' = false, clock' = clock,
    endedNoPlanOnOverflow' = endedNoPlanOnOverflow, lastAction' = if (mechanical) "deadline" else "swapReady", compactionDisabled' = compactionDisabled,
  }

  // The plan is ready (from a turn end, or the awaited job resolved inside the deadline). src: fold-job.ts:754-755
  action swapReady: bool = all {
    job.phase == "ready", not(swap.active),
    startSwap(job.snap, job.snapAt, false),
  }

  // A plugin ahead of clm forwards the event to Claude Code's native compactor without invoking clm's handler.
  // src: fold-job.ts applyReadyIfAtThreshold
  action compactUnhandled(retireOk: bool): bool = all {
    job.phase == "ready", not(compactWaiting), not(swap.active),
    retireOk or RETIRE_MAY_FAIL,
    val covered = msgs.keys().mapBy(m => { ...msgs.get(m), engine: msgs.get(m).engine or m.in(stored(msgs)), foldedRow: false })
    msgs' = retire(covered, stored(msgs), retireOk),
    job' = idleJob, compactWaiting' = false, lastAction' = "compactUnhandled",
    clock' = clock, swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow,
    seen' = seen.union(Set("compactUnhandled")), compactionDisabled' = true,
  }

  // The 7 s deadline passes while the job still summarizes. src: fold-job.ts:681-693 awaitOrFallback -> prepareMechanicalFold
  action deadline: bool = all {
    compactWaiting, job.phase == "bg" or job.phase == "single" or job.phase == "engine",
    // prepareMechanicalFold plans over the rows compactOrHandOff read, not the job's.
    startSwap(job.csnap, job.csnapAt, true),
  }

  // No plan (job ended empty, or the transcript changed under a ready plan): the engine summarizer compacts and every
  // queued message is retired; a failed retire write is swallowed and the engine summary is still adopted.
  // src: fold-job.ts compactOrHandOff, handOff
  action handOff(retireOk: bool): bool = all {
    compactWaiting or job.phase == "ready", not(swap.active),
    job.phase == "idle" or job.phase == "ready",
    retireOk or RETIRE_MAY_FAIL,
    // The engine summary replaces the conversation, folded rows included; it is assumed to keep what it summarized.
    val covered = msgs.keys().mapBy(m => { ...msgs.get(m), engine: msgs.get(m).engine or m.in(stored(msgs)), foldedRow: false })
    msgs' = retire(covered, stored(msgs), retireOk),
    job' = idleJob, compactWaiting' = false, clock' = clock,
    swap' = swap, lastAction' = "handOff", endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen.union(Set("handOff")), compactionDisabled' = compactionDisabled,
  }

  // ---- persistence inside applyFoldPlan ----

  // One write. A failure inside persistCompactResult skips every later write in the block (fold-job.ts:132-140);
  // the retire step under 5884744 sits in its own persistStep, whose failure is swallowed (fold-job.ts:128-131).
  // src: fold-job.ts:590-620
  action persist(ok: bool): bool = all {
    swap.active,
    val step = steps(FIXED).nth(swap.pc)
    all {
      step != "done",
      step != "retire" or ok or RETIRE_MAY_FAIL,
      msgs' = if (step == "retire") retire(msgs, retiring(msgs, swap.dropped), ok) else msgs,
      swap' = { ...swap, pc: if (ok or (step == "retire" and FIXED)) swap.pc + 1 else DONE },
      seen' = if (ok) seen else seen.union(Set("writeFailed")),
    },
    job' = job, compactWaiting' = compactWaiting, lastAction' = "persist", endedNoPlanOnOverflow' = endedNoPlanOnOverflow, clock' = clock, compactionDisabled' = compactionDisabled,
  }

  // src: fold-job.ts:782-786 (finally: job idle, pending plan deleted)
  action finishSwap: bool = all {
    swap.active, swap.pc == DONE,
    swap' = noSwap, job' = idleJob, clock' = clock,
    msgs' = msgs, compactWaiting' = compactWaiting, lastAction' = "finishSwap", endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen, compactionDisabled' = compactionDisabled,
  }

  action init = all {
    msgs' = MSGS.mapBy(_ => freshMsg),
    job' = idleJob, compactWaiting' = false, lastAction' = "init", swap' = noSwap, endedNoPlanOnOverflow' = false, clock' = 0, seen' = Set(), compactionDisabled' = false,
  }

  action step = any {
    nondet m = MSGS.oneOf()
    typeMsg(m),
    assistantReply,
    nondet two = Set(true, false).oneOf()
    nondet fits = Set(true, false).oneOf()
    turnEnd(two, fits),
    nondet o = Set("noReply", "skip", "overflow", "ok").oneOf()
    bgAttempt(o),
    nondet ok = Set(true, false).oneOf()
    finishFold(ok),
    requestCompact,
    swapReady,
    nondet u = Set(true, false).oneOf()
    compactUnhandled(u),
    deadline,
    nondet r = Set(true, false).oneOf()
    handOff(r),
    nondet w = Set(true, false).oneOf()
    persist(w),
    finishSwap,
  }

  // ---- properties ----

  // P1, regression 5884744: a newest turn too large for tailTarget made both splits overflow, the reply was dropped
  // with no plan, the next turn end retried it, and compaction folded mechanically (165 drops from 11-01).
  val noSummaryDropLoop = not(endedNoPlanOnOverflow)

  // P2, regressions 5884744 and the retire write failing: a message that left context with its reply, or that the
  // engine summary covered, is never read from the queue again, so no fold puts it back into the conversation. The
  // replay also checks the conversation never holds two copies of one message.
  val noReinjection = MSGS.forall(m => not(msgs.get(m).reinjected))

  // P3 (store half), intent of 87832d0 / 721ff6f: a queued message leaves the store only after it was handled,
  // carried at least once, or covered by the engine summarizer.
  val noLoss = MSGS.forall(m => {
    val r = msgs.get(m)
    (r.typed and not(r.inStore)) implies (r.handled or r.carried >= 1 or r.engine)
  })
  // P3 (context half): an unhandled message stays in the conversation. Violated at 9928335: the swap retired a carried
  // message and the next swap removed its folded row before any reply.
  val unhandledStaysInContext = MSGS.forall(m => {
    val r = msgs.get(m)
    (r.typed and not(r.handled)) implies r.inContext
  })

  // P4: the unhandled compact transition consumes the ready plan instead of allowing another compact next turn.
  val unhandledCompactRetiresReady = lastAction == "compactUnhandled" implies job.phase == "idle"

  // P5: once an unhandled compact disables clm compaction, neither clm compact requests nor background fold starts recur.
  val noCompactAfterUnhandled = compactionDisabled implies (lastAction != "requestCompact" and lastAction != "turnEnd")

  // Sanity: must be violated, showing a carry is reachable at all.
  val sanityNoCarry = MSGS.forall(m => msgs.get(m).carried == 0)

  // Witnesses
  val wCarried = seen.contains("carried")
  val wTypedDuringFold = seen.contains("typedDuringFold")
  val wSingleAfterOverflow = seen.contains("singleAfterOverflow")
  val wMechanical = seen.contains("mechanical")
  val wWriteFailed = seen.contains("writeFailed")
  val wHandOff = seen.contains("handOff")
  val wCompactUnhandled = seen.contains("compactUnhandled")
}

module current { import foldJob(FIXED = true, KEEP_UNHANDLED = true, RETIRE_IN_MEMORY = true, RETIRE_MAY_FAIL = true, GUARD_UNHANDLED = true, MSGS = Set(1, 2)).* }
module unguarded { import foldJob(FIXED = true, KEEP_UNHANDLED = true, RETIRE_IN_MEMORY = true, RETIRE_MAY_FAIL = true, GUARD_UNHANDLED = false, MSGS = Set(1, 2)).* }
module head { import foldJob(FIXED = true, KEEP_UNHANDLED = false, RETIRE_IN_MEMORY = false, RETIRE_MAY_FAIL = true, GUARD_UNHANDLED = true, MSGS = Set(1, 2)).* }
module prefix { import foldJob(FIXED = false, KEEP_UNHANDLED = false, RETIRE_IN_MEMORY = false, RETIRE_MAY_FAIL = false, GUARD_UNHANDLED = true, MSGS = Set(1, 2)).* }
