# Claude Code

AI coding assistant CLI.

**Managed by:** `nix/home/default.nix`; the CLI version is pinned through mise in `nix/home/mise-global.toml`.

## Configuration

| Source | Purpose |
|--------|---------|
| `nix/home/configs/.agents/AGENTS.md` and `nix/home/configs/claude/CLAUDE.md` | Shared and Claude-specific session rules |
| `nix/home/configs/claude/settings.json` | Claude Code settings, plugins, and hook registration |
| `nix/home/configs/claude/statusline.sh` | Three-line statusline |
| `nix/home/configs/claude/agents/` | Custom agent definitions |
| `nix/home/configs/claude/hooks/` | Hook scripts linked by Home Manager |
| `nix/home/configs/claude/mods/` | Local Claude Code plugins |
| `nix/home/configs/.agents/skills/` | Skills shared with Codex |
| `nix/home/configs/claude/mcp.json` and `nix/home/configs/claude/profile-wiring.sh` | MCP server list and profile wiring |

Home Manager generates a writable settings file from the repository config during activation. The selected `concise-adhd-korean` output style is generated from the shared `nix/home/configs/.agents/output-manner.md` rules.

The shared skill list in `nix/home/default.nix` links local skills into both Claude Code and Codex. It also fetches pinned skill sources for Anthropic, Notion, and TypeSafe, plus a Supermemory search skill.

## Local Plugins

`nix/home/configs/claude/settings.json` loads three plugins from `nix/home/configs/claude/mods/`:

| Plugin | Role |
|--------|------|
| `clm` | Folds earlier conversation turns into a ledger and provides the `/clm board` view |
| `codex-subagent` | Starts a Codex app-server bridge for Codex-backed agent tools |
| `time-budget` | Tracks estimated work budgets, requests checkpoint reports, and gates tools as a task approaches its limit |

## Statusline

`nix/home/configs/claude/statusline.sh` renders three lines from the session data:

- **Line 1:** account email, folder, branch, staged and modified file counts, and pull request review state; model, effort, and thinking state appear at the right.
- **Line 2:** cost and context percentage, changed line counts, and session duration.
- **Line 3:** five-hour and weekly rate-limit usage, with reset times when available and `unknown` when the usage data is absent.

The script caches Git status briefly per session and right-aligns each row to the detected terminal width.

### Alternative considered: Starship native statusline

Starship ships [`starship statusline claude-code`](https://starship.rs/advanced-config/#statusline-for-claude-code) as a drop-in Claude Code statusline. Evaluated 2026-07-03 and **not adopted** — it is not feature-complete against the script above:

- Its three modules (`claude_model`, `claude_context`, `claude_cost`) cover only lines 1-2.
- Rate limits (line 3) exist only in the unmerged, stalled upstream PR [starship#7442](https://github.com/starship/starship/pull/7442) (`claude_usage` module), with no maintainer review as of 2026-06-21.
- There is no upstream module for effort/thinking, PR number + review state, or staged/modified file counts.

Revisit if #7442 merges and effort/PR modules land upstream.

## Hooks

The scripts under `nix/home/configs/claude/hooks/` are registered in `nix/home/configs/claude/settings.json` by event and tool matcher. For example, `git-push-guard.py` restricts pushes to `claude/*` branches unless the repository's explicit local bypass is enabled; `git-integrity-guard.py` separately denies force-push and commit bypass flags.
