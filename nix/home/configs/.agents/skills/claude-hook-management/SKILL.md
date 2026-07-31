---
description: Add, change, or remove a Claude Code hook in the dotfiles repo. Holds the one-concern-per-file rule, the four wiring points, and the deployed-hook inventory.
when_to_use: When the user asks to create a hook, enforce a rule at the tool layer, or change an existing guard under nix/home/configs/claude/hooks/.
---

# Claude hook management

Hooks are the only enforcement Claude Code cannot talk itself out of. A rule in `AGENTS.md` is self-policed; a hook denies the tool call. Reach for a hook when goodwill has already failed.

## One concern, one file

Give each concern its own file under `nix/home/configs/claude/hooks/`, carrying:

- a **docstring** that states the problem the hook solves, not what the code does — the evidence for why the rule needed teeth belongs here;
- a **fail-open path** — every parse or IO error exits 0, because a bug in a guard must never make the tool unusable;
- a **`--selftest`** entry point that asserts the decision table, runnable as `python3 <hook>.py --selftest`.

One file may answer several events when they serve ONE concern. `rebuild-enforcer.py` spans PostToolUse and Stop for a single gate, and that is correct. Two unrelated rules in one file is not.

Never inline a shell command as a hook body in `settings.json`. A file can carry its reason and its self-check; a `printf` cannot.

## Wire it in four places

1. `nix/home/configs/claude/hooks/<name>.py` — the hook itself.
2. `nix/home/default.nix` — a `home.file.".claude/hooks/<name>.py"` entry with `executable = true`.
3. `nix/home/configs/claude/settings.json` — an entry in the event array (`matcher` for tool events).
4. `REUSE.toml` — add the path to the hooks annotation block.

Then `git add` the new file **before** the rebuild: `nix build` cannot see an untracked file in a flake repo, and the rebuild fails with a "make it visible to Nix" error until you stage it.

Apply with the host command in `AGENTS.md`, then verify against the deployed copy under `~/.claude/hooks/`, never the repo copy.

## Which output form reaches Claude

| Event | Form the model sees |
|---|---|
| UserPromptSubmit | plain stdout, appended as context |
| PreToolUse | `hookSpecificOutput.permissionDecision` (`deny` / `allow`) with a reason |
| PostToolUse | `hookSpecificOutput.additionalContext` — plain stdout goes to the debug log only |
| Stop | a block decision with a reason |

A PostToolUse hook that prints plain text is invisible. That mistake already shipped once here.

## Cost of a per-turn injection

An injected string stays in the transcript, so every later request re-reads all earlier copies as cache-read input. Cost grows with the SQUARE of the turn count: a 300-token injection over 50 turns is roughly 375k cache-read tokens, while a 20-token one is roughly 25k. Inject the checkable core; leave the full spec in the always-loaded rules.

## Deployed hooks

| File | Event | Concern |
|---|---|---|
| `ask-mode-guard.py` | UserPromptSubmit, PreToolUse `*` | an `ask:` turn stays explain-only |
| `output-shape-reminder.py` | UserPromptSubmit | restate the output-shape check next to generation |
| `plan-mode-guard.py` | PreToolUse `*` | plan mode distills only |
| `git-push-guard.py` | PreToolUse Bash | push reaches `claude/*` only |
| `ssh-guard.py` | PreToolUse Bash | `ssh` goes to the user's own TTY |
| `gpg-commit-guard.py` | PreToolUse Bash | a signed commit needs an unlocked key |
| `package-manager-guard.py` | PreToolUse Bash | use the manager the project declares |
| `gh-guard.py` | PreToolUse Bash | inject the github-master guide before a mutating `gh` |
| `subagent-model-guard.py` | PreToolUse Agent\|Task | every spawn names its model tier |
| `claude-dir-edit-guard.py` | PreToolUse Edit\|Write | Home-Manager-owned `~/.claude/` paths stay read-only |
| `rebuild-enforcer.py` | PostToolUse Edit\|Write, PostToolUse Bash, Stop | a config edit is followed by a rebuild |
| `missing-tool-hint.py` | PostToolUse Bash | check mise and project shims before calling a tool absent |

`git-push-guard.py` is linked into `~/.codex/hooks/` as well — Codex reads the same PreToolUse schema.
