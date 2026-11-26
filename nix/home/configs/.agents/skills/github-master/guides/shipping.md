# Ship a PR or a stack: verdicts, trunk moves, landing order

Use this guide when a PR is merge-ready per `guides/babysit.md` and the user asks to land it, or asks whether a stack can land. Merging stays the user's move: this guide decides what is safe to land and in which order, and hands over the merge commands.

## A verdict covers a patch; green CI covers a head

A verdict is one reviewer's `PASS`, `PASS+NOTES` or `FAIL` on one PR. Only a reviewer that did not write the code gives one -- a fresh `code-reviewer` agent spawned on that PR, or a person -- because an author checks what it meant to build. Green CI and an approving bot review are inputs to a verdict, never a verdict, since neither reads the change as a whole.

Record each verdict with the head SHA it saw and who gave it (`verdict: PASS, sha: <40-hex>, reviewer: <agent id or login>`), in the session's report or, when the user asked for a PR comment, there.

A rebase gives every commit a new SHA while the change can stay identical, so a verdict travels by patch-id and CI does not:

```sh
git diff <parent>...<verdict-sha> | git patch-id --stable
git diff <parent>...<current-head> | git patch-id --stable
```

`<parent>` is the PR's base branch (the PR below it in a stack, the default branch otherwise). Equal ids keep the verdict. Different ids void it: a fresh reviewer reads the interdiff (`git range-diff <old-base>..<verdict-sha> <new-base>..<current-head>`) and gives a new verdict on the current head. CI needs its own green on every new head either way, because the code it runs against changed.

## Trunk moved: decide whether the patch was tested

Right before landing, `git fetch` and ask whether the default branch's new commits can change what this patch does. Rebasing for every trunk move never ends, so rebase only when the code that would land was never tested:

```sh
git diff --name-only <tested-base> origin/<default>    # what trunk changed since CI ran
git diff --name-only <tested-base>...<head>            # what the PR touches
```

- Rebase and wait for CI when the two lists share a file, when trunk changed which checks run for the PR, or when trunk changed a caller of the patch or something it calls (`rg` the PR's changed symbols in trunk's diff).
- A lockfile both sides changed needs a frozen install (`pnpm install --frozen-lockfile`, `npm ci`, `uv sync --locked`) on the merge result. A pass lets it land; a failure means the rebase must repair the lockfile.
- No overlap: land without a rebase.
- A third rebase for trunk moves is the stop: report the colliding commits to the user, since sequencing the competing work is their call.

## Landing a stack

1. Get one verdict per PR from its own fresh reviewer, each reading that PR's diff against its parent.
2. Walk up from the lowest unmerged PR and stop at the first one without `PASS` or `PASS+NOTES`. The PRs below it are the verified run; the first unverified one is the ceiling. A verified PR above the ceiling waits, because merging it pulls the unverified code underneath into the default branch with it.
3. Hand over the merge commands for the run only, bottom first, one PR at a time (`gh pr merge <n> -R <owner>/<repo> --squash`), and name the ceiling PR and what its verdict lacks. On GitHub a PR whose base is still its parent's branch merges into that branch, so after each merge retarget the next PR to the default branch (`gh pr edit <n> --base <default>`), and re-check its patch-id per the first section before its merge.
4. Read each merge back before calling it landed, per `guides/babysit.md` "Stop and report". Arm `gh pr merge --auto` only on a PR whose verdict covers its current head, since auto-merge lands whatever head is ready.
5. Keep every branch and base in the run still while it lands: the next PR's retarget in step 3 is the only change, because a merge lands whatever its branch and base hold at that moment. A base moving to the default branch after its parent merges is expected. When a merge stalls, read `gh pr view <n> --json state,mergeStateStatus,mergedAt,baseRefName` and `gh pr checks <n>` to learn why before changing anything; `scripts/watch-pr --stack --status-only` reads the whole run at once.
6. Stop at the ceiling. Landing past it takes new verdicts, so it starts again at step 1.

The report lists the verified run and its ceiling, each PR's verdict with its reviewer and SHA, what landed and the read-back that confirmed it, and what the ceiling PR needs.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/poteto-mode/playbooks/shipping.md`, `playbooks/autopilot-full.md`, `playbooks/autopilot-stack.md` and `docs/guide/06-verify-and-ship.md`.*
