# Codex

OpenAI coding agent CLI, configured through Home Manager and mise.

**Managed by:** `nix/home/configs/codex/config.toml` and `nix/home/default.nix`.

## Main Settings

| Setting | Value |
|---------|-------|
| model | `gpt-5.6-terra` |
| model reasoning | high; plan mode uses xhigh |
| service tier | fast |
| approvals | on-request, reviewed by auto-review |
| sandbox | workspace-write, with network access |
| web search | live |
| file opener | VS Code |
| startup update check | disabled |
| default subagent | `gpt-6-luna`, xhigh reasoning |

The `agents` section caps depth at 2 and concurrent threads per session at 8. The TUI status line shows the current directory, Git branch, model reasoning, context use, and five-hour and weekly limits.

## Agents and Hooks

Home Manager links the `code-reviewer`, `oracle`, and `prose-editor` agent definitions from `nix/home/configs/codex/agents/`.

Codex runs shared policy scripts through `nix/home/configs/codex/hooks/claude-hook-adapter.py`. `nix/home/configs/codex/config.toml` registers them for Bash and `apply_patch` calls, tool completion, prompt submission, and session stop.

The generated Codex agent instructions combine `nix/home/configs/.agents/AGENTS.md`, `nix/home/configs/codex/AGENTS.md`, and the shared `nix/home/configs/.agents/output-manner.md`. The skills declared in `nix/home/default.nix` are linked for both Codex and Claude Code.

Home Manager generates the writable Codex config from the repository file during activation and retains local project trust and MCP server entries outside this repository.
