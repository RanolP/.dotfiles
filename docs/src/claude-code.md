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
| `clm` | Folds earlier conversation turns into a ledger, provides the `/clm board` view, and coordinates co-worker sessions through the `clm_coworker` tool |
| `codex-subagent` | Starts a Codex app-server bridge for Codex-backed agent tools |
| `time-budget` | Gives estimate, checkpoint and overrun feedback; the `extend` tool records extra time in extensions.jsonl |

Mod tests (`mods/*/hooks/*.test.ts`) import `claude-code/testing`, a synthetic module the claude binary injects (`describe`, `expect`, `mock`, `test`, `tier`), so `bun test` fails with "Cannot find module" on every mod. Run them with `claude plugin test .` from the mod folder; it takes a folder and runs every `*.test.ts` under it. `claude test ...` is a different thing: the wrapper reads `test` as a prompt and starts a session. The loader also requires that `$` be passed only into a function declared in the same file as the hook, never across an import, so a helper module takes plain values.

### clm co-workers

The earlier clm later queue (deferred requests held in session state, the Later queue band and `/clm pop`) is gone. Deferred work is now a shared board issue that a co-worker session claims.

Roles: the main session is the orchestrator and plans, lands and reassigns issues; co-worker sessions claim ready issues and work them in their own worktrees. The co-worker count is scalable: main sets `maxCoworkers` through the `plan` action (default 2, positive integer).

Deferred work: the prompt intent classifier returns `deferred` items (up to five) for work the user bounds as later ("나중에", "이건 다음에", "todo로"). An item whose `quote` is not an exact substring of the prompt is dropped. Each remaining item becomes a `todo` issue on the board, reusing the pending create when the titles match. Co-worker sessions skip this; main sends each live co-worker the new issue ids.

Board issues carry `priority`, `ready` and a claimant, and the board shows them on each card. The `ready-to-land` status has its own board column; only the co-worker tool can set it, because fold ops cannot produce it.

The `clm_coworker` tool takes an `action`, and each action is limited to one role except `list`:

- `claim` (co-worker): takes the given or the next ready unclaimed issue of the repository (highest `priority`, then oldest), starts its worktree, and marks it `doing`.
- `ready` (co-worker): checkpoint-commits the worktree, records its base and head SHAs, sets `ready-to-land`, returns the co-worker to idle, and sends main `<issue> is ready to land (<base>..<head>).`
- `release` (co-worker): drops the claim and returns the issue to `todo`; the worktree stays attached to the issue.
- `plan` (main): sets `priority`, `ready` or `maxCoworkers`; setting `ready` triggers dispatch.
- `revoke` (main): clears the claim, returns the issue to `todo`, tells the old claimant to leave the worktree unchanged and, with `to` (a co-worker session id), tells that co-worker to claim it.
- `land` (main): see below.
- `list` (either): main's live session, co-workers with live or stale state, and the board with priority, ready and claimant.

Environment: a co-worker session starts with `CLM_COWORKER=1` and `CLM_MAIN_SESSION=<main session id>`; without `CLM_COWORKER=1` a session is a main. Each session registers its role and repository on `session.start`. The launch also passes main's own `CLAUDE_CONFIG_DIR`, so the two sessions run under the same configuration and can message each other.

On-disk state, all under `~/.claude-work/clm/` except the event log:

- `claims/<issue>/owner.json`: an `mkdir` lock per issue. A claim whose owner has no live registry record is reclaimed.
- `coworkers/<session>.json`: registry record (state `starting`, `idle` or `busy`, issue, heartbeat, mux; main also stores `maxCoworkers`). A heartbeat is written every 15 s and is live for 60 s.
- `worktrees/`: one worktree per claimed issue.
- `~/.claude-work/tracker/events/<session>.jsonl`: the event log that the board folds from every session.

Messaging: the hooks send every hand-off themselves with `$.session.send({ to: { sessionId }, text })`, the same delivery as the model's `SendMessage` tool, addressed by the recipient's registry `session` id. A message to main goes to the newest live registry record with role `main` and the same stable main id, because `/clear` gives main a new session id. When a send is not delivered, `$.ui.log` records the reason and the tool result says the recipient could not be notified. The receiving model can answer with `SendMessage` to the sender of the message. An idle session that receives a message wakes and acts on it.

Land: `land` runs in main for a `ready-to-land` issue with a claimant and worktree. It refuses a dirty main checkout. Otherwise it runs `git cherry-pick --no-commit <base>..<head>`, which stages the commits without committing; main commits them afterwards in the repository's own subject format. On success the worktree is removed, the issue becomes `done`, and the co-worker is told so. On a conflict the cherry-pick is aborted, the issue returns to `doing`, and the claimant is told to rebase onto the current main HEAD and call `ready` again.

Auto-spawn: main polls every 5 s and after `plan`, `revoke` and `land`. When a ready unclaimed issue exists and a live co-worker is idle, main sends that co-worker a claim request, once per co-worker and issue, so the 5 s poll does not repeat it. A new co-worker is launched only when no live co-worker of this main is idle or starting, the live count is below `maxCoworkers`, and the one-minute load average is under 0.75 times the core count. The launch is a `clm-coworker-<n>` session started unfocused in the repository root with a brief to claim, work only in the returned worktree, and call `ready`.

Multiplexer detection reads the environment: `HERDR_SOCKET_PATH` or `HERDR_ENV` selects herdr (`herdr tab create --no-focus`, then `herdr agent start`), `ZELLIJ` selects zellij (`zellij run --no-focus`), `TMUX` selects tmux (`tmux new-window -d`). With none, no co-worker starts and the debug log records a manual command. The tmux launch is unverified: tmux is not installed on this machine. Load reading uses `/proc/loadavg` and `nproc` when `/proc/loadavg` is readable (Linux), otherwise `sysctl -n vm.loadavg` and `sysctl -n hw.ncpu` (macOS).

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
