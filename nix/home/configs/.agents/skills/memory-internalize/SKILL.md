---
name: memory-internalize
description: Move a chosen memory into the shared agent rules in `~/.dotfiles`, then remove the memory file, its `MEMORY.md` line, and any links pointing at it, and hand the user the rebuild command. Use when the user picks a memory to promote into a rule, or accepts a `memory-review` recommendation.
---

# Memory internalize

A rule in `nix/home/configs/.agents/AGENTS.md` ships to every agent on every host through Home Manager. A memory reaches one project folder. This skill moves one memory across that gap and leaves nothing behind on the old side.

Works on one memory at a time. Several memories that belong in the same rule get merged into that rule in a single pass.

## 1. Read the whole memory, then find its home

```sh
cat <memory-path>                                  # the full body, not the description
grep -n "^## " ~/.dotfiles/nix/home/configs/.agents/AGENTS.md
```

The heading list decides the shape of the edit:

- **A rule already covers the ground** — merge into it as one more `DO` line. A second section saying the same thing splits the reader's attention.
- **Nothing covers it** — add a `## Title` section with `WHEN` / `DO` / `NEVER` lines, in the voice of the sections already there.
- **It is Claude-specific** (plan mode, subagents, `Agent` tool, Claude Code hooks) — it belongs in `nix/home/configs/claude/CLAUDE.md` instead, which Home Manager appends after the shared file.

## 2. Write the rule so it stands alone

- Put the incident inside the rule when the incident is what explains it — the reader must understand it without the memory, the transcript, or the session that produced it.
- Lead every line with the action to take. Keep a `NEVER` line only when it carries a failure the `DO` line cannot hold.
- Name every referent by its exact identifier plus a short description: `git-integrity-guard.py` (denies force-push), not "the guard".
- Convert relative dates to absolute ones, and quote the user's own words when the wording is the point.

## 3. Check it against the rules already in the file

Read the neighbouring sections before saving. When the new rule contradicts a live one, resolve it with the user rather than letting both stand — two rules that disagree make the next session's behavior a coin flip.

## 4. Remove every trace of the memory

```sh
rm <memory-path>
grep -rn "\[\[<memory-name>\]\]" ~/.claude/projects/*/memory/     # links from other memories
```

Then delete its one-line pointer from the `MEMORY.md` in the same folder, and rewrite each `[[<memory-name>]]` link into the sentence it was standing in for. A link to a deleted memory is a dead end for every later session.

## 5. Hand the rebuild to the user

The rule is inert until Home Manager applies it, and the user runs that command themselves:

```
! sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26      # macOS
! home-manager switch --flake ~/.dotfiles/nix#ranolp-archwsl -b before-hm    # Linux/WSL
```

Say plainly that the rule is pending until they run it, and report which memory was removed and which rule now carries it.

---

*Paired with `memory-review`, which finds and ranks the memories worth moving.*
