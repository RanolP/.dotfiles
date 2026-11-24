---
name: correct
description: Turn a mistake the user has corrected more than once into structure that makes it impossible -- cluster recurring corrections into classes (2+ occurrences), fix each class at the highest rung that works (architecture, types, a lint or check whose error names the fix, a test, a Claude Code hook, and a prose rule last), prove the new check fails on the real past mistake, and keep the rule-to-enforcer table current. Use when the user corrects the same kind of mistake again ("또", "계속", "반복", "몇 번을 말해", "again", "still", "I told you"), when `memory-review` hands over recurring correction classes, when a 시말서 records a mistake that already has one, or when the user says "/correct".
---

# Correct

A correction the user has to give twice is a fact about the environment, not about one session: the rule the agent read did not hold, so another sentence of the same rule will not hold either. This skill moves each such class out of prose and into something that fails, at the level where the mistake actually lives.

Every agent that meets the code sees only the files it opened, copies the nearest example, and takes the shortest path that compiles. Shape the repo and the harness so the change that looks right from one file is right everywhere.

When the trigger is a live correction, fix the instance the user pointed at first, then run this skill on its class in the same turn.

## 1. Gather the corrections

Pull from every source that holds one, and record each as `{quote, date, project, session, what_agent_did}`, with `quote` at most 160 characters of the user's own words:

- **This session** -- the correction that triggered the run, plus earlier ones in the transcript.
- **Transcripts** -- `python3 ~/.claude/skills/correct/mine-corrections.py <scratchpad>/corrections.json --since <YYYY-MM-DD>` writes only user-typed messages (harness wrappers dropped, credentials redacted), each with the agent turn it answered in `prev`. Keep the output in the scratchpad. `memory-review` step 5 runs the same pass and hands over its classes.
- **`docs/src/agent-incidents.md`** in `~/.dotfiles` -- incidents already written up.
- **`~/.dotfiles/.apologies/`** -- each 시말서 counts toward its class's tally. Read them in the main thread and cite one only by its file path; `apology` §0 keeps their content out of briefs, commits and every shared body.

For a sweep of more than a few days of transcripts, split by date into slices and send one read-only miner per slice in parallel, each returning the typed records above and nothing else.

## 2. Cluster into classes

Name each class by the situation, not the incident: "a deliverable the user listens to arrives as a local file instead of the page they have open", not "the TTS sample on 2026-11-23". The `prompt-authoring` section *Generalize past the incident* owns this step.

A class counts once it has two occurrences -- across two sessions or two mining slices, or twice in one session when the user flags the repeat. Then read the rule-to-enforcer table (step 5): a correction against a rule whose row says `prose only` is a repeat even at its first sighting, because that rule already failed once by being skipped.

## 3. Fix the class at the highest rung that works

Find where the class lives -- the project repo it happened in, or the harness every session shares -- and climb down this ladder only as far as you must:

1. **Architecture.** Give each piece of state one owner and each task one supported path; hide internals so the wrong import fails; replace a hand-synced list with one source of truth; delete the old way an agent would copy. A banner whose face and text render as separate layers becomes one component that renders both.
2. **Types.** Make the bad state unwritable.
3. **A lint or CI check whose error names the fix** -- the file, type, function or command to use instead. When the bad pattern is already common, fail only on additions.
4. **A behavior test** that fails when the behavior breaks and survives a refactor of internals.
5. **A Claude Code hook** for a mistake made through a tool call -- `PreToolUse` to deny or rewrite it, `UserPromptSubmit` or `Stop` to inject the check at the moment it applies. `rule-write` §6 and `claude-hook-management` own the container verification and the four wiring points.
6. **A prose rule** through `rule-write`, only for a judgement call no matcher can inspect -- and then with the failure as an example inside the rule. Project-scoped lessons go into that project's `AGENTS.md` or `CLAUDE.md`; ones true on every repo go into the shared rules files.

Fix the most frequent classes first, one change per class. For each, write down why every higher rung did not work; "the user's request was about prose" is not a reason, "the mistake happens in a judgement no tool call exposes" is.

## 4. Prove the check fails on the real past mistake

Replay the actual mistake against the new structure before calling the class fixed:

- **Hook** -- feed the offending tool input recovered from the transcript to `python3 <hook>.py` on stdin and show the deny; then feed the corrected form and show it passes. Add both as cases to the hook's `--selftest`.
- **Lint, type or test** -- check out or recreate the bad code in a scratch copy, run the same command CI runs, and show the failure names the fix; then show it passes on the fixed code.
- **Architecture** -- show the old path is gone: the wrong import fails to resolve, the duplicated list no longer exists.

A check that was never seen failing is a hypothesis, so it does not enter the table yet.

## 5. Keep the rule-to-enforcer table

The table lives in `~/.dotfiles/docs/src/agent-incidents.md` under `## Rule enforcers` (create the section on first use), never in the always-loaded rules files, where every byte costs every prompt:

| Rule | Lives in | Enforced by | Incidents |
|---|---|---|---|
| a deliverable the user reads goes into the page they have open | `nix/home/configs/claude/CLAUDE.md`, *An Artifact page ...* | prose only | 2026-11-23 (x2) |

- Add or update one row per class this run touched.
- A row reading `prose only` that gathers a new incident moves up a rung in the same change.
- Once an enforcer makes the mistake impossible, cut the prose rule down to whatever judgement the enforcer cannot carry, or delete it, and say so in the row.

## 6. Land it

- **A project repo** -- follow that repo's conventions (`git log --oneline -30`, its branch rules). Stop at the working tree and report the change unless the user asked for a commit.
- **`~/.dotfiles`** -- commit each class on local `main` as it lands, per that repo's `AGENTS.md`; a new hook follows `claude-hook-management` from container check to registration, and the rebuild goes to the user.

## Reply

One block per class:

- **Class** -- the generalized name.
- **Evidence** -- count, dates, projects, and up to three quotes of 160 characters or fewer.
- **Rung** -- what now enforces it, with its path.
- **Why no higher rung** -- one sentence.
- **Proof** -- the command that failed on the real mistake and its output, then the passing run.
- **Pending** -- anything waiting on the user: a rebuild, a commit in a project repo.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/correct`, `skills/principle-encode-lessons-in-structure`, and the slice-and-cross-check mining of `skills/automate-me`.*
