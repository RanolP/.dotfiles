# Shell

## Nushell

Primary shell. Configured via home-manager with:

- `cat` → `bat`
- `ls` → `eza --icons=auto --git --group-directories-first --header --time-style=relative`
- `rebuild` → `sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26`
- `GITHUB_TOKEN` auto-populated from `gh auth token`
- `nix develop` / `nix-shell` drop into nushell via [nix-your-shell](https://github.com/MercurialX/nix-your-shell)

## Starship

Prompt shows: directory, git branch/status, language versions (node, python, rust, go, kotlin, java, swift), command duration (≥5s), time. Right-aligned duration and clock via `$fill`.

## Zsh

Present for compatibility (macOS default), but `compinit` is disabled — it's slow with nix store paths.
