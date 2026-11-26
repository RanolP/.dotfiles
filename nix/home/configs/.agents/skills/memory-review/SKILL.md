---
name: memory-review
description: Survey the Claude memories saved across every project, plus the user corrections in recent session transcripts that no memory caught, rank them by how much they belong in the shared rules file, and recommend a shortlist to internalize, keep, delete, or hand to `correct` for a guard. Use when the user asks which memories should become rules, wants the memory store cleaned up, or opens `~/.dotfiles` after a stretch of work in other repos.
---

# Memory review

Memories are written wherever the work happened, so a correction that applies on every host can sit in one project folder forever. This skill reads the whole store, sorts it by where each memory belongs, and hands the user a ranked shortlist. It recommends; the user picks; `dotfiles:evolve` does the moving.

Nothing is deleted here. This skill only reads; the transcript pass in step 5 writes its extract to the scratchpad and nowhere else.

## 1. Sweep cheaply

Memory files live at `~/.claude/projects/<project-slug>/memory/*.md`, indexed by `MEMORY.md` in the same folder, with lazily-searched files under `evidence/`.

Bodies are large, so read the frontmatter first and nothing else:

```sh
grep -H "^description:\|^  type:" ~/.claude/projects/*/memory/*.md
```

Read a full body only for the candidates that survive step 2.

## 2. Sort each memory into one bucket

| Bucket | What it looks like | Recommendation |
|---|---|---|
| **Global habit** | describes how the agent should work, and nothing in it is repo-specific | internalize into `nix/home/configs/.agents/AGENTS.md` |
| **Global fact** | a tool, path, or platform behavior true on this machine regardless of repo | internalize, or keep if it is already in a rules file |
| **Project fact** | names a repo, a service, a ticket, a schema | keep where it is |
| **Duplicate** | an existing rule, memory or doc already says it, including a "retired" entry kept only as an index line | delete the file and its `MEMORY.md` line after confirming the other source covers it; a stub pointing at the covering source adds nothing |
| **Stale** | its premise no longer holds — a shell that changed, a version that moved, a file that is gone | delete, or rewrite from the current facts |
| **Conflicting** | it contradicts a live rule or another memory | raise it first; the user decides which side is right |

Two checks make this real rather than a guess:

```sh
grep -n "^## " ~/.claude/CLAUDE.md                    # every rule that already exists
grep -rn "\[\[<memory-name>\]\]" ~/.claude/projects/*/memory/   # who links to it
```

A memory in the **Stale** or **Conflicting** bucket needs its premise tested before you report it — check the version, the path, or the setting yourself rather than trusting what the file says.

## 3. Rank by what it costs to leave it alone

Order the shortlist by damage, highest first:

1. **Conflicting** — a memory that fights a rule makes behavior random, so it lands at the top no matter how small it is.
2. **Recurring correction** with a live rule (step 5) — the rule exists and the mistake still happens, so prose has already failed for it.
3. **Global habit** repeated across projects — the same correction saved twice means it keeps happening.
4. **Recurring correction** with no rule yet (step 5).
5. **Global habit** seen once.
6. **Stale** — wrong facts are worse than missing ones.
7. **Duplicate** — harmless, just noise in every session's startup context.

## 4. Report as a table the user can act on

One row per memory, ranked, with the exact file path, the bucket, and one sentence of evidence. Name the rule it conflicts with or duplicates by its heading text, so the user can judge without opening anything.

Then sort the same rows into three lists, so the user sees what was filtered out as well as what was kept:

- **Accept** -- seen in 2+ sessions and would change what a future agent does: the edit and its target file.
- **Reject** -- a one-off, a detail that drifts (SHA, version, count), or a lesson that changes no behaviour: one-line reason each.
- **Backlog** -- something a script, lint or hook could enforce: hand it to `correct` rather than writing prose.

Close with the single highest-value next step: which memory to internalize first, or which correction class to hand to `correct` first, and why that one. Then ask the user one multiple-choice question (4-6 options, multi-select) on which areas they want worked first, plus one free-form question for anything the transcripts did not show.

## 5. Mine the corrections no memory caught

A correction the agent never saved as a memory is invisible to steps 1-4, and the repeats are exactly those: in the 2026-11-24 mining of 901 user messages, the largest class (8 of 88 corrections) was a mistake the user had already flagged, against a rule that already existed in prose. Sweep the transcripts as a second source:

```sh
python3 ~/.claude/skills/correct/mine-corrections.py <scratchpad>/corrections.json --since <YYYY-MM-DD>
```

- **`--since`** -- the end date of the previous memory-review run, as an absolute date: the user's word, or the `mined <since>..<until>` window an earlier report or commit body recorded (`git -C ~/.dotfiles log -1 --format='%cs %b' --grep='mined '`); else 14 days before today. State the window as the first line of the step 4 report so the next run can start where this one ended.
- **What it writes** -- one record per user-typed message, `{project, session, date, text, prev}`, where `prev` is the agent turn the message answered. Harness wrappers, tool results, subagent transcripts and replays from forked sessions are already dropped, and credentials are redacted.
- **Classify in parallel** -- split the records by date into three slices and send one read-only miner per slice at once. Each keeps the messages of four kinds and returns a JSON array of `{kind: "correction" | "fetchable_context" | "missed_skill" | "preference", class: string, quote: string (at most 160 chars of the user's words), date: string, project: string, what_agent_did: string}`:
  - **correction** -- the user pushed back on what the agent did.
  - **fetchable_context** -- the user pasted or typed a fact a tool in reach could have read (a file, a ticket, a log, a live state).
  - **missed_skill** -- the work matched a skill's `description` or `when_to_use`, and the skill was never loaded; `class` names the skill.
  - **preference** -- a stated working-style preference that was never framed as a correction (response length and format, delegation, verification posture, code or prose discipline, process conventions).
- **Cross-check** -- merge the slices and keep a class seen in 2+ slices or 2+ sessions; a lone sighting stays out of the report.
- **Check the rules** -- grep `~/.claude/CLAUDE.md` and the project's own rules for each kept class, and file it as **Recurring correction** with or without a live rule.

Add the kept classes to the step 4 table, one row each with the count, dates and one quote. Hand corrections and fetchable context to `correct`, which picks the enforcement rung and proves it; route a missed skill to an edit of that skill's `description` or `when_to_use`, the cheapest fix there is; file a preference as a **Global habit**. This skill only ranks.

---

*Paired with `dotfiles:evolve`, which performs the move this skill recommends.*
