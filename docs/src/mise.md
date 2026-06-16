# Mise

Tool version manager. Replaces nvm, pyenv, rbenv, etc.

**Managed by:** `nix/home/default.nix` via `programs.mise` (home-manager)

## Settings

| Setting | Value |
|---------|-------|
| experimental | true |
| pipx.uvx | true (use uv as pipx backend) |

## Tools

| Tool | Version | Purpose |
|------|---------|---------|
| node | 24.16.0 | JavaScript runtime |
| python | 3.14.5 | Python runtime |
| uv | 0.11.14 | Fast Python package manager |
| colima | 0.10.3 | Docker-compatible container runtime |
| lima | 2.1.2 | Linux VM (colima dependency) |
| docker-cli | 29.5.3 | Docker CLI |
| fzf | 0.73.1 | Fuzzy finder |
| bat | 0.26.1 | `cat` with syntax highlighting |
| eza | 0.23.4 | Modern `ls` |
| ripgrep | 15.1.0 | Fast `grep` |
| fd | 10.4.2 | Fast `find` |
| jq | 1.8.1 | JSON processor |
| vim | 9.2.0623 | Editor |
| gh | 2.93.0 | GitHub CLI |
| delta | 0.19.2 | Git diff pager |
| claude | 2.1.175 | Claude Code CLI |
| npm:@mariozechner/pi-coding-agent | 0.73.1 | Pi coding agent |
| npm:@getgrit/cli | 0.1.0-alpha.1743007075 | Grit codemods CLI |
| npm:@openai/codex | 0.139.0 | OpenAI Codex CLI |
