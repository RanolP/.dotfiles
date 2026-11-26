---
name: build-the-lever
description: For any non-trivial edit, migration, analysis or check, build the small tool that does or proves the work (a `grit` codemod, an `rg`-driven script, a generator, a rerunnable check) instead of working by hand -- the first unit done by hand as the oracle, the tool proven by reproducing it and by a no-op second run, and the tool left in the diff.
when_to_use: Before the first edit of a change that spans several files or call sites, a migration, a rename, a data or transcript analysis, a verification you will repeat, or a bulk-edit worker's brief. A couple of obvious edits are done by hand.
---

# Build the lever

The bar is triviality, not repetition: when the work is more than a couple of obvious edits, build the tool that does it or proves it, and let the tool be what a reviewer reruns. This extends two `AGENTS.md` rules -- "fold a repeated command sequence into one script" and "read hand-writing a standard task as the stop signal" -- to work that happens once. The failure it answers: subagents called `yt-dlp` ad hoc with no shared tool, each failure got a local patch, and the user asked for the tool instead (`docs/src/agent-incidents.md`, 2026-11-22).

## Pick the tool

Take the first that fits the work:

1. **Edits with a syntactic shape** (a call reshaped, an import moved, an API renamed): a `grit` (GritQL) pattern, run with `grit apply`. Read `grit --help` before its first call.
2. **Edits keyed on text**: an `rg -l` listing piped into a small script (`perl -pi`, or `uv run python`) that rewrites exactly the listed files.
3. **Files with a repeated structure**: a generator that writes them from one data file.
4. **An analysis** (counts, groupings, a transcript mine): a script that prints the table, so the numbers are rerunnable rather than read off by eye.
5. **A check you will run again** (an invariant, a "zero old callers" predicate): a script that exits non-zero on a violation and prints every offending `file:line`.

Build the smallest script that does or proves the job, in the repo's language or shell; a framework, config layer or plugin system is out of scope.

## Hand first, then the tool, then prove it

1. Do the first unit by hand. That unit is the oracle: it shows what correct output looks like before any automation exists.
2. Save the hand-made result (`git diff > <scratchpad>/oracle.patch`), restore the unit (`git checkout -- <paths>`), and build the tool.
3. Run the tool on that unit alone and compare: `git diff | diff - <scratchpad>/oracle.patch` prints nothing. A difference means the tool is wrong, or the hand edit was; settle which before going on.
4. Run the tool a second time on the same unit. `git diff --stat` is unchanged, because a lever that is safe to rerun can be applied to the whole set, interrupted, and applied again.
5. Apply it to every unit, then run the check from step 5 of the list above (or `rg` for the old form) and expect zero hits.

## Fan-out gets a recipe, not a description

A deterministic tool beats fanning the edit out to workers. When the work still needs judgement per unit and you do fan out, write the recipe, the Done-when command and the fences (paths each worker may touch) into one file every worker reads, and keep that file under main's control. For a `hetero-subagents:codex:gpt-6-luna` bulk-edit worker, the Done-when is the oracle diff from step 3 plus the zero-hit check, which main reruns per `AGENTS.md` (Parallel execution).

## Done when

The diff contains the tool next to its output, with the command that reruns it in the commit body or the PR body. A bulk change with no script, codemod, generator or check in the diff did not apply this skill. Keep a one-off tool in the scratchpad when its work ends with the session; commit it under the repo's `scripts/` (or the owning skill's `scripts/`) when the work recurs or a reviewer needs to rerun it.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/principle-build-the-lever`.*
