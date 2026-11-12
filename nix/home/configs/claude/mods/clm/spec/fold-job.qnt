// Run: nice -n 15 quint run nix/home/configs/claude/mods/clm/spec/fold-job.qnt --main current --invariants noSummaryDropLoop noReinjection noLoss --max-steps 40 --max-samples 5000 --n-threads 2 --seed 0x1
// Regenerate the conformance traces (hooks/fold-conformance.test.ts): nice -n 15 sh nix/home/configs/claude/mods/clm/spec/fold-job-traces.sh
//
// The clm background fold job (hooks/fold-job.ts) as a state machine: a turn end starts a summary job, a compaction
// waits up to its 7 s deadline for it, applyFoldPlan persists the swap step by step, and user messages typed while
// the model works ride the queued-message store until a fold retires them. Sizes are one symbolic level: whether the
// newest turn plus the ledger row fits tailTarget. Instances at the bottom bind the current code and the code at
// 520a61f (before 5884744).
module foldJob {
  // true: fold-job.ts at 5884744; false: at 520a61f.
  const FIXED: bool
  // Whether io.markQueuedMessagesFolded itself may throw (register.ts:603, a host state update).
  const RETIRE_MAY_FAIL: bool
  const MSGS: Set[int]

  type Msg = {
    typed: bool,      // the host appended the queued_command attachment (register.ts:589-597)
    inStore: bool,    // still in the clm queuedMessages store, so withQueuedMessages re-inserts it (fold.ts:90)
    inContext: bool,  // present in the conversation the model reads
    handled: bool,    // an assistant row follows it, so buildCleared does not carry it (fold.ts:261-262)
    carried: int,     // times a swap emitted it as a `folded` row after the ledger row (fold.ts:262-269)
    engine: bool,     // a handOff to the engine summarizer covered it (fold-job.ts:699-705)
  }
  // phase: idle | bg (split summary) | single | engine | ready | swapping
  // snap: queued messages in the rows the job planned over; csnap: those in the rows a waiting compaction read.
  type Job = { phase: str, attempt: int, fits: bool, snap: Set[int], csnap: Set[int], mechanical: bool }
  type Swap = { active: bool, pc: int, dropped: Set[int] }

  var msgs: int -> Msg
  var job: Job
  var compactWaiting: bool
  var swap: Swap
  // Set when a job ends without a plan because its split overflowed tailTarget twice.
  var endedNoPlanOnOverflow: bool
  var seen: Set[str]

  pure val idleJob: Job = { phase: "idle", attempt: 0, fits: true, snap: Set(), csnap: Set(), mechanical: false }
  pure val noSwap: Swap = { active: false, pc: 0, dropped: Set() }
  pure val freshMsg: Msg = { typed: false, inStore: false, inContext: false, handled: false, carried: 0, engine: false }

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

  pure def stored(ms: int -> Msg): Set[int] = ms.keys().filter(m => ms.get(m).inStore)

  // buildCleared over the dropped rows: an unhandled one is carried as a folded row, a handled one leaves context.
  pure def applyDrop(ms: int -> Msg, dropped: Set[int]): int -> Msg =
    ms.keys().mapBy(m => {
      val r = ms.get(m)
      if (not(dropped.contains(m))) r
      else if (r.handled) { ...r, inContext: false }
      else { ...r, carried: r.carried + 1, inContext: true }
    })

  pure def retire(ms: int -> Msg, which: Set[int]): int -> Msg =
    ms.keys().mapBy(m => if (which.contains(m)) { ...ms.get(m), inStore: false } else ms.get(m))

  // ---- user and model ----

  // src: register.ts:583-597 captureAppendedRow (queued_command attachment -> storeQueuedMessage)
  action typeMsg(m: int): bool = all {
    not(msgs.get(m).typed),
    msgs' = msgs.set(m, { ...freshMsg, typed: true, inStore: true, inContext: true }),
    job' = job, compactWaiting' = compactWaiting, swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow,
    seen' = if (job.phase != "idle") seen.union(Set("typedDuringFold")) else seen,
  }

  // The model answers: every queued message in context now has an assistant row after it.
  action assistantReply: bool = all {
    msgs.keys().exists(m => msgs.get(m).inContext and not(msgs.get(m).handled)),
    msgs' = msgs.keys().mapBy(m => if (msgs.get(m).inContext) { ...msgs.get(m), handled: true } else msgs.get(m)),
    job' = job, compactWaiting' = compactWaiting, swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen,
  }

  // ---- summary job ----

  // src: fold-job.ts:492-515 maybeClear -> startFoldJob(turnEnd=true), fold-job.ts:422-469
  action turnEnd(twoTurns: bool, fits: bool): bool = all {
    job.phase == "idle", not(compactWaiting), not(swap.active),
    job' = { ...idleJob, phase: if (routeToSplit(FIXED, twoTurns, fits)) "bg" else "single", fits: fits, snap: stored(msgs) },
    msgs' = msgs, compactWaiting' = compactWaiting, swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen,
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
    job' = bgNext(job, outcome, FIXED),
    endedNoPlanOnOverflow' = (endedNoPlanOnOverflow or (outcome == "overflow" and job.attempt == 1 and not(FIXED))),
    seen' = if (outcome == "overflow" and job.attempt == 1 and FIXED) seen.union(Set("singleAfterOverflow")) else seen,
    msgs' = msgs, compactWaiting' = compactWaiting, swap' = swap,
  }

  // src: fold-job.ts:363-377 prepareSingleFold; fold-job.ts:379-401 prepareEngineFold
  action finishFold(ok: bool): bool = all {
    job.phase == "single" or job.phase == "engine",
    job' = { ...job, phase: if (ok) "ready" else "idle" },
    msgs' = msgs, compactWaiting' = compactWaiting, swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen,
  }

  // ---- compaction ----

  // src: fold-job.ts:732-752 compactOrHandOff; an idle job starts startFoldJob(turnEnd=false), a running one is awaited.
  action requestCompact: bool = all {
    not(compactWaiting), not(swap.active), job.phase != "ready",
    compactWaiting' = true,
    job' = if (job.phase == "idle") { ...idleJob, phase: "engine", snap: stored(msgs), csnap: stored(msgs) } else { ...job, csnap: stored(msgs) },
    msgs' = msgs, swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen,
  }

  // Start the swap of a plan: the dropped region holds any subset of the queued messages the job saw.
  // src: fold-job.ts:776-789, applyFoldPlan fold-job.ts:536-593 (buildCleared builds the result before persisting)
  action startSwap(dropped: Set[int], mechanical: bool): bool = all {
    msgs' = applyDrop(msgs, dropped),
    swap' = { active: true, pc: 0, dropped: dropped },
    job' = { ...job, phase: "swapping", mechanical: mechanical },
    compactWaiting' = false,
    endedNoPlanOnOverflow' = endedNoPlanOnOverflow,
    seen' = seen.union(if (mechanical) Set("mechanical") else Set()).union(if (dropped.exists(m => msgs.get(m).handled == false)) Set("carried") else Set()),
  }

  // The plan is ready (from a turn end, or the awaited job resolved inside the deadline). src: fold-job.ts:754-755
  action swapReady: bool = all {
    job.phase == "ready", not(swap.active),
    nondet d = job.snap.intersect(stored(msgs)).powerset().oneOf()
    startSwap(d, false),
  }

  // The 7 s deadline passes while the job still summarizes. src: fold-job.ts:681-693 awaitOrFallback -> prepareMechanicalFold
  action deadline: bool = all {
    compactWaiting, job.phase == "bg" or job.phase == "single" or job.phase == "engine",
    // prepareMechanicalFold plans over the rows compactOrHandOff read, not the job's.
    nondet d = job.csnap.intersect(stored(msgs)).powerset().oneOf()
    startSwap(d, true),
  }

  // No plan (job ended empty, or the transcript changed under a ready plan): the engine summarizer compacts and every
  // stored queued message is retired. src: fold-job.ts:756, 765-770, handOff fold-job.ts:699-704
  action handOff(retireOk: bool): bool = all {
    compactWaiting or job.phase == "ready", not(swap.active),
    job.phase == "idle" or job.phase == "ready",
    retireOk or RETIRE_MAY_FAIL,
    val covered = msgs.keys().mapBy(m => if (msgs.get(m).inStore) { ...msgs.get(m), engine: true } else msgs.get(m))
    msgs' = if (retireOk) retire(covered, stored(msgs)) else covered,
    job' = idleJob, compactWaiting' = false,
    swap' = swap, endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen.union(Set("handOff")),
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
      msgs' = if (step == "retire" and ok) retire(msgs, swap.dropped) else msgs,
      swap' = { ...swap, pc: if (ok or (step == "retire" and FIXED)) swap.pc + 1 else DONE },
      seen' = if (ok) seen else seen.union(Set("writeFailed")),
    },
    job' = job, compactWaiting' = compactWaiting, endedNoPlanOnOverflow' = endedNoPlanOnOverflow,
  }

  // src: fold-job.ts:782-786 (finally: job idle, pending plan deleted)
  action finishSwap: bool = all {
    swap.active, swap.pc == DONE,
    swap' = noSwap, job' = idleJob,
    msgs' = msgs, compactWaiting' = compactWaiting, endedNoPlanOnOverflow' = endedNoPlanOnOverflow, seen' = seen,
  }

  action init = all {
    msgs' = MSGS.mapBy(_ => freshMsg),
    job' = idleJob, compactWaiting' = false, swap' = noSwap, endedNoPlanOnOverflow' = false, seen' = Set(),
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

  // P2, regression 5884744: a failing state write skipped markQueuedMessagesFolded, so every later fold carried the
  // same queued message again. A message is emitted as a folded row at most once.
  val noReinjection = MSGS.forall(m => msgs.get(m).carried <= 1)

  // P3, intent of 87832d0 / 721ff6f: a queued message leaves the store only after it was handled, carried, or
  // covered by the engine summarizer, and an unhandled one never leaves the model's context.
  val noLoss = MSGS.forall(m => {
    val r = msgs.get(m)
    and {
      (r.typed and not(r.inStore)) implies (r.handled or r.carried >= 1 or r.engine),
      (r.typed and not(r.handled)) implies r.inContext,
    }
  })

  // Sanity: must be violated, showing a carry is reachable at all.
  val sanityNoCarry = MSGS.forall(m => msgs.get(m).carried == 0)

  // Witnesses
  val wCarried = seen.contains("carried")
  val wTypedDuringFold = seen.contains("typedDuringFold")
  val wSingleAfterOverflow = seen.contains("singleAfterOverflow")
  val wMechanical = seen.contains("mechanical")
  val wWriteFailed = seen.contains("writeFailed")
  val wHandOff = seen.contains("handOff")
}

module current { import foldJob(FIXED = true, RETIRE_MAY_FAIL = false, MSGS = Set(1, 2)).* }
module currentRetireFails { import foldJob(FIXED = true, RETIRE_MAY_FAIL = true, MSGS = Set(1, 2)).* }
module prefix { import foldJob(FIXED = false, RETIRE_MAY_FAIL = false, MSGS = Set(1, 2)).* }
