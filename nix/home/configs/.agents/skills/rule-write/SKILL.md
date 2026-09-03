---
name: rule-write
description: Land ONE durable instruction as a rule in the shared agent rules files -- generalize the incident into a class, confirm it is durable, choose `AGENTS.md` or `CLAUDE.md`, merge into a live section or open a new one, author it in `WHEN`/`DO`/`WHY`/`NEVER` form, mechanize it when a machine can check it, and hand the user the rebuild. Use when a correction, a lesson, a promoted memory, or an incident countermeasure should become a standing rule. Callers supply the candidate; this skill does not harvest or rank candidates.
---

# rule-write

One candidate instruction in, one rule landed. The caller decides WHAT to record -- `dotfiles:evolve` brings a promoted memory, `apology` brings a recurrence guard, the user brings a correction they just gave. This skill owns everything from that candidate to the rebuild handoff.

Works on one instruction at a time. Several candidates that belong in the same rule are merged into that rule in a single pass.

## 1. Find the universal rule behind the candidate

The candidate almost always arrives as one incident: a file, a branch, a command, a moment. Strip the proper nouns and ask which CLASS of situation it belongs to, then write the rule for that class.

- The incident is the evidence, and the class is the rule. "I kept a dead flag in a branch nobody had pulled" generalizes to "unshipped code has no reader to protect, so delete it rather than preserving it".
- A rule that fires only on the exact file, branch, or ticket that produced it is a retelling. The next session meets a different file and reads past it.
- Keep the incident inside the rule as its `WHY`, so the reader understands the rule without the session that produced it.

## 2. Confirm it is durable

Three gates, all of which must pass:

1. **It constrains future behavior.** A fact about the current state is not a rule.
2. **A reader cannot derive it** from the code, the git history, a passing type-check, or an existing config file.
3. **No live rule already says it.** `grep -n "^## " ~/.dotfiles/nix/home/configs/.agents/AGENTS.md ~/.dotfiles/nix/home/configs/claude/CLAUDE.md`, then read the sections that look close.

Drop the candidate when a gate fails, and tell the user which gate and why. A rule that duplicates a live one splits the reader's attention across two places that will drift apart.

## 3. Choose the file

| File | Holds |
|---|---|
| `nix/home/configs/.agents/AGENTS.md` | Anything every agent obeys, on any host and any harness |
| `nix/home/configs/claude/CLAUDE.md` | What only Claude Code has -- plan mode, `Agent` spawns, `Task*` tools, hooks, `ExitPlanMode` |

Home Manager appends `CLAUDE.md` after `AGENTS.md`, so the Claude file reads as a continuation and never restates the shared one.

## 4. Merge into a live section, or open a new one

Read the `^## ` heading list of the chosen file first, then pick:

- **A section already covers the ground** -- add the instruction as one more `DO` line inside it.
- **Nothing covers it** -- open a `## Title` section whose title states the rule itself, in the voice of the sections already there.

Then read the neighbouring sections for contradictions. When the new rule disagrees with a live one, resolve it with the user rather than letting both stand -- two rules that disagree make the next session's behavior a coin flip.

## 5. Author it in house form

Bullets are `WHEN` (the trigger condition), `DO` (the action), `WHY` (the causal mechanism), `NEVER` (a failure the `DO` line cannot carry). `WHEN` and at least one `DO` are required; `WHY` and `NEVER` earn their place.

Name every referent by its exact identifier plus a short description -- `git-integrity-guard.py` (denies force-push), never "the guard". Convert relative dates to absolute ones.

For the sentence-level form -- positive phrasing, which prohibitions earn their place, how a `WHY` states a mechanism rather than a conclusion, and why the prose is English -- follow the `prompt-authoring` skill. It owns that layer.

## 6. Mechanize it when a machine can check it

A prose rule aimed at a model is a request, and a request gets violated eventually. When a `PreToolUse` hook or a CI check could decide the rule -- a forbidden command, a required file, a format, a skipped step -- the guard is the deliverable and the prose line is its fallback.

Follow `claude-hook-management` for the container verification, the `nix/home/default.nix` entry, the `git add`, and the `settings.json` registration. A hook reaches every session on this machine, so an unverified one is a total work stoppage.

Keep the prose alone only for what no matcher can inspect: intent, priority, taste, and judgement criteria.

## 7. Hand the rebuild to the user

The rule is inert until Home Manager applies it, and the user runs that command themselves:

```
! sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26      # macOS
! home-manager switch --flake ~/.dotfiles/nix#ranolp-archwsl -b before-hm    # Linux/WSL
```

Say plainly that the rule is pending until they run it, and name which section of which file now carries the instruction.
