# Claude Code

AI coding assistant CLI.

**Managed by:** `nix/home/default.nix` (home.file declarations), installed via mise (`claude` tool)

## Managed Files

| File | Purpose |
|------|---------|
| `~/.claude/CLAUDE.md` | Rules and behavioral config for Claude Code sessions |
| `~/.claude/settings.json` | Claude Code app settings |
| `~/.claude/statusline.sh` | Custom status line script (executable) |
| `~/.claude/hooks/git-push-guard.py` | PreToolUse hook restricting `git push` (executable) |

## Skills

Skills extend Claude Code with domain-specific workflows.

| Skill | Source |
|-------|--------|
| handoff | `nix/home/configs/.agents/skills/handoff/SKILL.md` |
| decompose | `nix/home/configs/.agents/skills/decompose/SKILL.md` |
| one-domain | `nix/home/configs/.agents/skills/one-domain/SKILL.md` |
| codex-edit | `nix/home/configs/.agents/skills/codex-edit/SKILL.md` |
| diagnose | `nix/home/configs/.agents/skills/diagnose/SKILL.md` |
| tdd | `nix/home/configs/.agents/skills/tdd/SKILL.md` |
| grill-me | `nix/home/configs/.agents/skills/grill-me/SKILL.md` |
| prototype | `nix/home/configs/.agents/skills/prototype/SKILL.md` |
| zoom-out | `nix/home/configs/.agents/skills/zoom-out/SKILL.md` |
| remove-dead-code | `nix/home/configs/.agents/skills/remove-dead-code/` (vendored from [qdhenry/Claude-Command-Suite](https://github.com/qdhenry/Claude-Command-Suite), MIT) |
| audit-env-variables | `nix/home/configs/.agents/skills/audit-env-variables/` (vendored from [qdhenry/Claude-Command-Suite](https://github.com/qdhenry/Claude-Command-Suite), MIT) |
| skill-creator | [anthropics/skills](https://github.com/anthropics/skills) (pinned rev) |
| frontend-design | [anthropics/skills](https://github.com/anthropics/skills) (pinned rev) |

The `anthropics/skills` repo is fetched via `pkgs.fetchFromGitHub` at a pinned revision and linked into `~/.claude/skills/`. The two vendored multi-file skills are linked as whole directories rather than a single `SKILL.md`, and their MIT provenance is declared in `REUSE.toml`.

## Statusline

`~/.claude/statusline.sh` renders a custom 3-line statusline from the session JSON Claude Code pipes to it:

- **Line 1:** folder / branch `+staged ~modified` / `#PR review_state` (color-coded) — right-aligned: model + effort + thinking (🧠)
- **Line 2:** `used $cost with N% contexts` — right-aligned: `+added -removed` and session duration
- **Line 3:** 5h and weekly rate-limit usage with time-to-reset (shown only when the data is present)

Git info is cached per session under `/tmp` (5s TTL) to avoid lag on large repos, and segments are right-justified against the real terminal width.

### Alternative considered: Starship native statusline

Starship ships [`starship statusline claude-code`](https://starship.rs/advanced-config/#statusline-for-claude-code) as a drop-in Claude Code statusline. Evaluated 2026-07-03 and **not adopted** — it is not feature-complete against the script above:

- Its three modules (`claude_model`, `claude_context`, `claude_cost`) cover only lines 1-2.
- Rate limits (line 3) exist only in the unmerged, stalled upstream PR [starship#7442](https://github.com/starship/starship/pull/7442) (`claude_usage` module), with no maintainer review as of 2026-06-21.
- There is no upstream module for effort/thinking, PR number + review state, or staged/modified file counts.

Revisit if #7442 merges and effort/PR modules land upstream.

## Hooks

### git-push-guard

A `PreToolUse` hook (registered in `settings.json` under the `Bash` matcher) that restricts `git push` to `claude/*` branches.

A static `deny` rule cannot express "deny all pushes except `claude/*`" because deny always wins over allow regardless of specificity. So the blanket `Bash(git push*)` deny was removed and replaced by this hook, which inspects each `git push` command and:

- **allows** pushes whose refspec destination targets a `claude/*` branch (e.g. `git push -u origin claude/topic`);
- **denies** everything else, failing safe to deny — bare `git push`, a remote with no refspec, non-`claude/*` destinations, and pushes chained with `&&`/`||`/`;`/`|`.
