# Zsh

Compatibility shell only — not the interactive shell.

**Managed by:** `nix/darwin/default.nix` (system), `nix/home/programs/zsh.nix` (home)

## Configuration

`compinit` and `bashcompinit` are disabled in `/etc/zshrc`. They scan every path in `$fpath` for completion functions, which is slow when that list includes thousands of nix store paths.

The interactive shell is [Nushell](./nushell.md).
