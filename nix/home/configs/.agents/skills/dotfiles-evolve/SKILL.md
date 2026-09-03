---
name: dotfiles:evolve
description: Move a chosen memory into the shared agent rules in `~/.dotfiles`, sweep the docs the new rule contradicts, remove the memory file, its `MEMORY.md` line and any links pointing at it, then report the deploy state and hand the user the rebuild command. Use when the user picks a memory to promote into a rule, accepts a `memory-review` recommendation, or invokes this skill with no target at all.
---

# dotfiles:evolve

A rule in `nix/home/configs/.agents/AGENTS.md` ships to every agent on every host through Home Manager. A memory reaches one project folder. This skill moves one memory across that gap and leaves nothing stale behind on either side.

Works on one memory at a time. Several memories that belong in the same rule get merged into that rule in a single pass.

## 0. Resolve the target yourself

The invocation carries a name, a fuzzy phrase, or nothing at all. All three end at one memory path before step 1 starts.

- **A path or a memory name** — use it as given.
- **A fuzzy phrase** (`"그 jira adf 수정 관련 메모리"`) — grep the descriptions, then confirm the hit by its body:

  ```sh
  grep -rH "^description:" ~/.claude/projects/*/memory/*.md ~/.claude/projects/*/memory/evidence/*.md
  ```

  `memory-review` reads only `memory/*.md`, so search `evidence/` here too — a promoted memory often lives there.
- **No target at all** — run the `memory-review` survey, pick the top-ranked candidate yourself, and say in plain text which memory you chose and why before moving it.

Present the choice as prose with a recommendation, never as `AskUserQuestion` chips. Incident (2026-09-02): invoked with empty arguments, this skill hand-rolled a survey and ended on a chip menu; the user interrupted the tool call and nothing landed.

## 1. Read the whole memory

```sh
cat <memory-path>                                  # the full body, not the description
```

The body is the candidate. The description is a search key and carries too little to write a rule from.

## 2. Land it as a rule with `rule-write`

Hand that body to the `rule-write` skill and follow it. It owns generalizing the memory past its incident, the durability gates, the choice between `AGENTS.md` and `CLAUDE.md`, merge-vs-new-section, the `WHEN` / `DO` / `WHY` / `NEVER` authoring, the mechanization check, and the rebuild handoff.

Come back here once the rule is written, to clear the old side.

## 3. Sweep the docs the new rule contradicts

A promoted fact usually obsoletes something written before it was known. Grep the rule's key identifiers — the CLI name, the tool, the path, the API — across the config tree:

```sh
grep -rn "<identifier>" ~/.dotfiles/nix/home/configs/
```

Update every skill or doc whose instructions the new rule makes wrong, in the same pass. Incident (2026-09-02): a rule landed saying the `jira` CLI edits ADF directly, and `nix/home/configs/.agents/skills/github-master/guides/pr.md:51` still told the reader to "leave a placeholder region for the human to upload" — the user had to ask for that fix as a separate turn.

## 4. Remove every trace of the memory

```sh
rm <memory-path>
grep -rn "\[\[<memory-name>\]\]" ~/.claude/projects/*/memory/     # links from other memories
```

Then delete its one-line pointer from the `MEMORY.md` in the same folder, and rewrite each `[[<memory-name>]]` link into the sentence it was standing in for. A link to a deleted memory is a dead end for every later session.

## 5. Report both sides, and the deploy state

Name which memory was removed, which rule now carries it, and which files the step-3 sweep changed.

Then state the deploy state plainly, because the rule is inert until Home Manager applies it:

```sh
git -C ~/.dotfiles status --short                                          # what is still uncommitted
grep -c "<section heading>" ~/.claude/CLAUDE.md ~/.codex/AGENTS.md         # whether the live files carry it yet
```

`~/.dotfiles` allows direct commits on `main`, so offer the commit in one sentence and make it when the user asks. `rule-write` step 7 hands over the rebuild command; add these facts to that same message so the user sees the whole move in one place.

---

*Paired with `memory-review`, which finds and ranks the memories worth moving, and `rule-write`, which authors the rule itself.*
