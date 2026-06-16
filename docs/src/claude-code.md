# Claude Code

AI coding assistant CLI.

**Managed by:** `nix/home/default.nix` (home.file declarations), installed via mise (`claude` tool)

## Managed Files

| File | Purpose |
|------|---------|
| `~/.claude/CLAUDE.md` | Rules and behavioral config for Claude Code sessions |
| `~/.claude/settings.json` | Claude Code app settings |
| `~/.claude/statusline.sh` | Custom status line script (executable) |

## Skills

Skills extend Claude Code with domain-specific workflows.

| Skill | Source |
|-------|--------|
| handoff | `nix/home/configs/claude/skills/handoff/SKILL.md` |
| decompose | `nix/home/configs/claude/skills/decompose/SKILL.md` |
| one-domain | `nix/home/configs/claude/skills/one-domain/SKILL.md` |
| skill-creator | [anthropics/skills](https://github.com/anthropics/skills) (pinned rev) |
| frontend-design | [anthropics/skills](https://github.com/anthropics/skills) (pinned rev) |

The `anthropics/skills` repo is fetched via `pkgs.fetchFromGitHub` at a pinned revision and linked into `~/.claude/skills/`.
