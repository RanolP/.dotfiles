---
name: pause-resume
description: Pause work at a safe boundary and leave a resume note a cold session can continue from; or resume -- from that note, from a prior session or branch left mid-flight, or by rebuilding "where was I on X" from past transcripts plus the shared record (git, Jira, Slack, Sentry, Notion), checked against live git and gh state. Use when the user says "pause", "stop for now", "resume", "pick up where we left off", "take over this branch", "where did I leave off", or "recall my work on X". "keep going", "don't stop" and "going to bed, keep going" are not pauses.
---

# pause-resume

One note format, two halves. The pause half writes the note; the resume half reads it, or rebuilds the same fields when no note exists. Git and the live remote are the record of what landed; a note or transcript carries intent and decisions, and every fact in it is re-checked before it is built on (`AGENTS.md`: a transcript or temp file is never the record of a fact).

## The resume note

Write it to `resume/<topic-slug>.md` inside the project's auto-memory directory (the `memory/` folder whose `MEMORY.md` the system prompt shows), which survives a reboot and is per-workspace. Leave it out of the `MEMORY.md` index: it is a hand-off, deleted once the resumed work is under way.

1. **Goal** -- the user's request, quoted.
2. **Doing** -- the step in progress at the pause.
3. **Progress** -- each finished piece with the check that verified it (command and result), or `unverified`.
4. **State** -- repo, branch, HEAD SHA, the checkpoint commit, clean or dirty (listing uncommitted paths), and each stopped worker with its ID and last known output.
5. **Next steps** -- numbered; the first is a literal command or edit.
6. **Key files** -- absolute paths.
7. **Gotchas** -- what cost time, and the approaches that failed.

## Pause

Pause only on the user's explicit request.

1. **Stop at a safe boundary.** Finish the current atomic step or back out of it, and start nothing new.
2. **Collect, then stop workers.** For each worker and background command (`running()`, the task list), read its output and record it in State, then `TaskStop` it -- an unread result is gone once the worker stops.
3. **Make the edits durable.** Commit them as one `wip: <topic>` commit, staging explicit paths, where the repo's checkpoint rule allows a commit without asking: `main` in `~/.dotfiles`, `claude/local-dev` when that is the current branch elsewhere. Note a broken tree in one body line. On any other branch, leave the edits in the working tree and list them in State.
4. **Publish nothing.** The remote, PRs and tracker statuses stay as they are; a pause is reversible by construction.
5. **Write the note.**

**Reply:** where you stopped, what is on disk (the commit SHA, the note path) versus only in this context (ideally nothing), whether the tree is clean, and the first command on resume. This is a pause, not a final report.

## Resume

1. **Route.**
   - A note exists (`ls <memory>/resume/`) or the user pasted a capsule (paths, branch, the change): start from it and skip the mining.
   - One prior session or branch is named: a worker reads that transcript or branch and returns the reduced timeline.
   - "Where was I on X" or "what have I been working on": lock the scope, mine, and sweep (steps 2-4).
2. **Lock the scope** and state it back in one line: the window (default the last 7 days), the topic, and the workspace (default the current project). "All" stays all.
3. **Mine the transcripts.** They live at `<config>/projects/<slug>/<session-id>.jsonl`, where `<config>` is `$CLAUDE_CONFIG_DIR` or `~/.claude` and `<slug>` is the working directory with `/` and `.` turned into `-`. Order candidates by `ls -t`, run `rg -l <topic>` first, and skip the current session and every `*/subagents/*.jsonl`. Split the matches into slices across `haiku` workers (one worker for one or two sessions), each returning one block per session: `{session_id, goal, decisions[], open_threads[], corrections[], artifacts[]}`. The raw text stays in the workers.
4. **Sweep the shared record** whenever the topic names a feature, file, subsystem or bug; skip it only for pure activity recall ("what did I do this week"). Run one read-only worker per source in parallel with the mining -- `gh` (PRs, issues, reverts), `jira`, the Slack MCP, the Sentry MCP, `ntn` -- each answering what the current state is, what was tried and did not hold, and what users still report, as `{source, state, tried_and_failed[], still_reported[], empty: boolean}`. An empty result is a finding; name an unavailable source as skipped.
5. **Verify against live state.** `git fetch`, `git status`, `git log origin/<base>..HEAD`, and `gh pr view <n> --json state,isDraft,mergeable` plus `gh pr checks <n>` for each PR found. For each inherited `done` claim, re-run the check behind it or mark it `unverified`, and restate the original goal to confirm the claims serve it. Verified work stays done: re-running its check is enough.
6. **Write the brief** (contract below), then continue from the first open next step when the user asked to resume; a "where was I" question ends at the brief. Delete the note once its first next step lands.

### Brief contract

- **Capsule** -- at most 5 bullets: what this work is and where it stands.
- **Threads** -- one line each, prefixed with exactly one tag, each checked against `git`/`gh` in step 5: `[merged #N]`, `[open PR #N]`, `[in flight <branch>]`, `[verified, uncommitted]`, `[reverted #N]`, `[planned, not started]`.
- **Problems** -- at most 5, the recurring ones, including symptoms users still report and every fix that shipped and was reverted, so the next attempt starts where the last one failed.
- **Verdict** -- one of: continue the work, ship a finished result, ratify or override a prior conclusion, postmortem a failed run.
- **Next move** -- the single most useful next action, concrete.

Cite transcript findings by session ID and shared-record findings by their source (PR number, ticket key, Slack permalink, Sentry issue). An adjacent feature stays out unless it blocks this one; when the brief outgrows a screen, cut detail before threads.
