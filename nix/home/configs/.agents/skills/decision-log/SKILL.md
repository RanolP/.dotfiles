---
name: decision-log
description: Keep an append-only TSV decision trail for long, multi-phase or unattended work (ts, phase, decision, why, evidence pointer, result) written through `scripts/log.sh`, audit it against the run's transcript before hand-back, have a model from another vendor review the trail, and end the reply with an Attention section.
when_to_use: When a run is long, multi-phase, unattended or overnight (skill `overnight`), fans out to several workers, or will be reviewed by someone who was not watching; when the user asks "show me your work", "what did you decide and why", or "catch me up on last night" with an audit. Other skills route their decision trail here by name.
---

# Decision log

One TSV per run of work, one row per decision. It is the record of why the work went the way it did, so the transcript never has to be cited as that record (`AGENTS.md`: a transcript is never the record of a fact). Each row points at evidence that is the record: a commit, a file, a command's saved output.

## Columns

| column | holds |
|---|---|
| `ts` | UTC ISO 8601, stamped by the script |
| `phase` | the phase or workstream (`frame`, `harness`, `parser-migration`); `start` is reserved, below |
| `decision` | what was chosen or done, one line |
| `why` | the reason in plain words a teammate would use |
| `evidence` | a pointer that resolves: a commit SHA, `file:line`, a PR as `owner/repo#n (title)`, a saved output path, a screenshot path |
| `result` | the outcome or predicate state: `tests green`, `reverted`, `diff empty`, `inconclusive`, `open` |

Write the rows in plain words, concrete actions first (skill `slopless` applies to the cells too). Evidence is a pointer, never a paragraph.

## Where it lives

Keep the log at `audit/<topic-slug>.tsv` inside the project's auto-memory directory (the `memory/` folder whose `MEMORY.md` the system prompt shows). That directory survives a reboot, sits outside every repo, and stays out of the `MEMORY.md` index. Copy it into the repo and commit it only when a reviewer needs the trail to trust the result, and say so in the reply.

## Logging a row

```sh
bash <this skill's dir>/scripts/log.sh <memory>/audit/<slug>.tsv <phase> <decision> <why> <evidence> <result>
```

The script writes the header on first use and keeps every cell on one line and formula-safe, so evidence copied from a PR title or a Slack message is safe to log.

Log decision points: a fork chosen, a unit finished with its verification result, a pivot or revert with its trigger, a blocker surfaced, a gate fixed. A loop logs one row per iteration. Routine reads and obvious steps stay out.

The log is append-only. A wrong call gets a new row that names the row it supersedes (by `ts`) and says what actually happened.

## Several runs, one log

A run is one conversation, its later turns included. A pickup, a replacement agent or a new chat is a new run. Before a run's first write to an existing log, it reads the last rows, then writes a row with phase `start` whose `decision` names the `ts` range of the rows before it that this run did not write, and whose evidence names this run (the session id or agent id). A run that returns to a log in a later turn reads the last rows again and writes a fresh `start` row when another run wrote since. `start` means nothing else.

## Before hand-back

1. **Audit the log against the transcript.** Spawn a `haiku` worker with the log path, this run's `start` row `ts` values, and this run's transcript path (`<config>/projects/<slug>/<session-id>.jsonl` plus `<session-id>/subagents/*.jsonl`, `<config>` being `$CLAUDE_CONFIG_DIR` or `~/.claude`). It walks only this run's rows and returns:

   ```
   {rows: [{ts: str, real_action: boolean, evidence_resolves: boolean, note: str}], missing_pivots: [{what: str, transcript_ref: str}]}
   ```

   Correct the log, not the story: for each row with a `false`, append a superseding row with what happened and a pointer that resolves; for each missing pivot, append its row. The audit never edits or deletes a row.
2. **Cross-vendor review of the trail.** Send the log path, the transcript path and `git diff <base>..HEAD --stat` to `hetero-subagents:codex:gpt-6.2-astra` (read-only), asking for decisions with weak or absent evidence, verification claimed without a command in the transcript, choices that look risky in hindsight (premature, scope-creeping, patching a symptom), and gaps a casual skim would miss -- each finding as `{ts: str, reason: str}`. It scans the trail; it does not redo the work. When it cannot run, say so in the Attention section.
3. **Render it for the reader**: `column -s $'\t' -t <log>`.

## Attention section

Every reply for a run that kept a log ends with:

```
Attention (reviewed by <model>)
- <ts>: <what to look at and why>
```

`No flags` is a valid list; the reviewer's model name always appears.

## Composing

A skill that needs a decision trail names skill `decision-log` and lets it own the columns and the path. Skill `hillclimb` keeps its own experiment columns in `decision.tsv`.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/show-me-your-work` (the skill and `scripts/log.sh`) and "The morning audit" in `docs/guide/07-overnight.md`.*
