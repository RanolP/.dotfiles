# Zsh

Fallback shell and Claude Code Bash-tool shell.

**Managed by:** `nix/darwin/default.nix` (system), `nix/home/darwin/default.nix` (Claude wrapper), `nix/home/darwin/programs/zsh.nix` (home), `nix/home/default.nix` (mise zsh integration)

## Configuration

The account login shell is `/bin/sh`. Home Manager makes the user-profile `zsh` resolve to Apple's `/bin/zsh`.

The Claude Code wrapper sets `SHELL=/bin/zsh` to short-circuit Claude Code's shell probe, which would otherwise select the nix zsh and encounter its SIGCHLD startup hang.

Ghostty launches [Nushell](./nushell.md) as the primary interactive shell. Interactive Zsh remains configured with aliases and the `mise activate` hook.

Non-interactive Zsh reads `.zshenv`, which adds `~/.local/bin` and the mise shims to `PATH`, disables the Claude Code autoupdater, and configures the Android SDK paths.

Only shells with `CLAUDECODE` set disable history. Guards in both `.zshenv` and `.zshrc` unset `HISTFILE` and zero the history sizes because Home Manager's `.zshrc` history block can restore `HISTFILE` after `.zshenv` runs.

Shared history, autosuggestions, and syntax highlighting are disabled.

Home Manager sets `completionInit = ""`, leaving completion initialization out of the user's `.zshrc`.

nix-darwin sets `enableCompletion = false` and `enableBashCompletion = false`, leaving `compinit` and `bashcompinit` out of `/etc/zshrc`. These commands slowly scan nix-store paths in `$fpath`.
