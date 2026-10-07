# Mise

Tool version manager. Replaces nvm, pyenv, rbenv, etc.

**Managed by:** `nix/home/default.nix` via `programs.mise` (home-manager). Shared pins live in `nix/home/mise-global.toml`; macOS adds a small platform-specific set.

## Settings

| Setting | Value |
|---------|-------|
| experimental | true |
| pipx.uvx | true (use uv as pipx backend) |
| Nushell integration | disabled; shims are on PATH |
| Zsh integration | enabled |

## Tools

| Tool | Version | Scope |
|------|---------|-------|
| node | 24.18.0 | Shared |
| python | 3.14.6 | Shared |
| rust | 1.96.1 | Shared |
| uv | 0.11.29 | Shared |
| fzf | 0.74.0 | Shared |
| bat | 0.26.1 | Shared |
| eza | 0.23.4 | Shared |
| ripgrep | 15.2.0 | Shared |
| fd | 10.4.2 | Shared |
| jq | 1.8.2 | Shared |
| duckdb | 1.5.4 | Shared |
| gh | 2.100.0 | Shared |
| delta | 0.19.2 | Shared |
| difftastic | 0.70.0 | Shared |
| claude | 2.1.288 | Shared |
| npm:@earendil-works/pi-coding-agent | 0.80.10 | Shared |
| npm:@getgrit/cli | 0.1.0-alpha.1743007075 | Shared |
| codex | 0.155.1 | Shared |
| npm:agent-browser | 0.34.0 | Shared |
| npm:agent-device | 0.20.9 | Shared |
| npm:ntn | 0.21.8 | Shared |
| npm:slopless | 0.2.23 | Shared |
| pipx:reuse | 6.2.0 | Shared |
| pipx:google-colab-cli | 0.7.4 | Shared |
| ubi:namespacelabs/foundation (`nsc`) | 0.0.573 | Shared |
| colima | 0.10.3 | macOS |
| lima | 2.1.4 | macOS |
| docker-cli | 29.6.0 | macOS |
| herdr | 0.7.5 | macOS |

On macOS, a Home Manager launchd agent runs the pin-bump script daily at 10:30; the script's seven-day guard limits successful updates to weekly. Its source is `nix/home/configs/mise/bump.py`.
