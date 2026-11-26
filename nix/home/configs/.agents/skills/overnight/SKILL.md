---
name: overnight
description: Set up a run the user will not watch -- check the four trust conditions first, then write the overnight contract (goal, a pass/fail finish predicate, an isolated worktree, the user's quoted permissions, an escape hatch), and drive one change, one check, one decision-log row per iteration until the predicate passes or the hatch fires.
when_to_use: When the user hands over work to run unattended or while away ("going to bed, keep going", "run this overnight", "work on this while I'm out", "/loop until done"), or asks to schedule an autonomous loop with `/loop` or `/schedule`. A pause request is skill `pause-resume`.
---

# Overnight

An unattended loop that cannot verify its own work produces unchecked work faster, and the mess compounds each iteration. Check the trust conditions, write the contract, then run the loop.

## 1. Trust gate

All four hold before the loop starts unattended:

1. **Done once with eyes on it.** The task, or one unit of it, ran by hand or under the user's watch in this or a cited session, so what good looks like is on record (a commit, a recorded flow, a saved output).
2. **The tools are present.** The checks the user would use (the test command, the verification skill, the profiler, device access) are installed and answered once this session; inventory them per `AGENTS.md` (inventory).
3. **Every stage can stop the line.** Each iteration ends in a command that exits non-zero when the work misses the bar, and the loop stops or discards on that exit.
4. **Repeated failures became tools.** A failure seen twice while watching now has a script or check (skill `build-the-lever`).

When one fails, name it in the reply and run the loop attended until it holds.

## 2. The contract

Write it back to the user in the reply, each line filled:

- **Goal** -- the user's request, quoted.
- **Done means** -- a predicate every iteration can run that passes or fails ("zero hits for `rg -F oldParser src/`, `pnpm test parser` green, the old API file deleted"). A duration ("work on it for four hours") gives the loop nothing to check; turn it into a predicate and confirm it with the user before leaving.
- **Where** -- an isolated worktree per skill `git-master` (`<repo>/.claude/worktrees/<name>`), off a named base, so the run cannot collide with the user's open work; in a repo whose rules forbid branches, a detached worktree.
- **Permissions** -- the user's own sentence quoted for each mutation the run may make unasked ("don't ask me before committing"). Anything unquoted keeps its usual gate from `AGENTS.md` (Mutations the outside world can see): the run stops at it and records it for the morning.
- **Escape hatch** -- after 3 failed hypotheses on the same obstacle (`AGENTS.md`, A failure earns a hypothesis), stop, write up why, and leave the tree at the last green checkpoint.
- **Log** -- the decision-log path (skill `decision-log`).

## 3. The loop

Each iteration:

1. Run the finish predicate; stop when it passes.
2. Make the smallest justified change.
3. Verify against the real artifact.
4. Commit it when it made progress and the contract allows commits; discard it in full otherwise.
5. Log one row through skill `decision-log`.

Wake on the condition: `/loop` re-checks the predicate on its interval, and a background command's completion wakes the session per `AGENTS.md` (wait). A plateau means a new category of hypothesis, and the predicate stays as agreed: a loop that relaxes its own finish condition reports a pass it did not earn.

## 4. Hand-back

Run the hand-back steps of skill `decision-log` (transcript audit, cross-vendor review, Attention section), then report the predicate's final state with its command output, the iteration count kept against discarded, everything that stopped at a gate waiting on the user, and the worktree path. For a quick read-only status before the full audit, skill `ketchup` fits.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `docs/guide/07-overnight.md`.*
