# Verify an existing fix

Use this when an open PR or a merged commit plausibly fixes a reported bug, and the question is whether it does. The existing PR or commit owns the fix: measure it, and leave its code and its branch as they are. A finding that it falls short goes into the report and to its author, not into a competing patch.

## Qualify the fix

Require one concrete artifact: an open PR whose code changes address the symptom, a merged PR, or a merged commit with matching code and intent. A ticket status, a comment saying "fixed", a branch name, or a cause hypothesis is not an artifact; report that there is nothing to verify yet.

When several candidates exist, take the one linked from the report or ticket; otherwise take the closest match to the affected code and say why.

## Two builds, one environment

Run both builds in a separate checkout (`git worktree add`, per skill `parallel-worktree-workflow`) so the user's working tree stays untouched. Record before the first run:

- the baseline revision -- the PR's base for an open PR; the parent of the fix commit for a merged one, when that parent builds and shows the old behavior;
- the patched revision -- the PR head or the fix commit;
- the PR or commit URL;
- the environment inputs both runs share (account, fixture data, flags, device, build mode).

Both runs go through the repo's `verify-<app>` skill: its launch, doctor, the same journey file, and its evidence directory, one subdirectory per build.

## Baseline: the symptom, twice

1. Launch the baseline, and run doctor to confirm the right app and environment.
2. Drive the reported path through real user actions.
3. Observe the discriminating symptom -- the state that differs between broken and fixed.
4. Reset to a fresh state and repeat.
5. Keep the recording or screenshot plus the read-only state check from each attempt.

Two reproductions make a baseline. With fewer, the verdict is `inconclusive` whatever the patched build shows.

## Patched: the fix, twice

Launch the patched revision with the same environment and data, drive the same journey twice from a fresh state, and confirm in each attempt that the broken state is gone and the expected state appears. Capture the same evidence as the baseline, including the same read-only state check, so before and after compare one value. The result comes from the running patched app; a green build or test suite is not this measurement.

Then smoke the blast radius: drive the states, inputs, permissions, platforms and failure paths next to the fixed behavior that the diff could reach, once each, from the same verify skill. A regression found there makes the verdict `insufficient`, with that evidence.

## Verdict

- `confirmed` -- the baseline reproduced twice and the patched build resolved it twice. Report the artifact with the before and after evidence.
- `insufficient` -- the symptom appears on both builds, or the blast-radius smoke found a regression. Report that the artifact does not resolve it, with both sets of evidence.
- `inconclusive` -- the baseline did not reproduce, the patched app did not run, or the evidence does not show the discriminating state. Name the half that could not be measured, and claim nothing about the fix.

Posting the verdict on the PR, issue or Jira ticket is an outside-visible send: draft it in the report and post when the user asks.

## Cleanup

Stop both instances through the verify skill's cleanup, remove the worktree, and keep the evidence directories.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `automations/benny/skills/reproduce-and-fix-issues/references/verify-existing-fix.md` and step 13 of its `SKILL.md`.*
