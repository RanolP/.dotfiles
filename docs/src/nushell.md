# Nushell

Primary interactive shell.

**Managed by:** `nix/home/programs/nushell.nix`, `nix/home/configs/nushell/`

## Config Files

| File | Purpose |
|------|---------|
| `env.nu` | PATH, environment variables |
| `config.nu` | Shell init (nix-your-shell, banner off) |

## PATH Order (highest to lowest priority)

1. `~/Library/Android/sdk/emulator`
2. `~/Library/Android/sdk/platform-tools`
3. `~/.local/bin`
4. `~/.local/share/mise/shims`
5. `/etc/profiles/per-user/ranolp/bin` (nix per-user)
6. `/nix/var/nix/profiles/default/bin` (nix default)
7. `/opt/homebrew/bin`, `/opt/homebrew/sbin`

## Environment Variables

| Variable | Value |
|----------|-------|
| `ANDROID_HOME` | `~/Library/Android/sdk` |
| `GITHUB_TOKEN` | `gh auth token` (auto-populated) |
| `DOCKER_HOST` | `unix://~/.colima/default/docker.sock` |
| `EDITOR` | `nvim` |
| `VISUAL` | `code --wait` |

## Aliases

| Alias | Expands To |
|-------|-----------|
| `cat` | `bat` |
| `ls` | `eza --icons=auto --git --group-directories-first --header --time-style=relative` |
| `rebuild` | `sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26` |
| `pr` | `gh pr view -w` |
| `repo` | `gh repo view -w` |
| `g` | `git` |
| `gst` | `git status` |
| `gl` | `git pull` |
| `gp` | `git push` |
| `gc` | `git commit -v` |

## nix-your-shell

`nix develop` and `nix-shell` drop into nushell instead of bash. The nushell snippet is generated at home-manager activation and cached at `~/.cache/nix-your-shell.nu`.
