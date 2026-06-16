# Ghostty

Terminal emulator.

**Managed by:** `nix/home/programs/ghostty.nix` (config), installed via Homebrew cask

## Settings

| Setting | Value |
|---------|-------|
| theme | Nord |
| font-family | Iosevka Nerd Font Mono, Pretendard |
| font-size | 16 |
| command | `/etc/profiles/per-user/ranolp/bin/nu` (nushell) |

## Keybinds

| Binding | Action |
|---------|--------|
| Super+D | unbound (handed to [Zellij](./zellij.md)) |
| Super+Shift+D | unbound (handed to [Zellij](./zellij.md)) |

`package = null` in home-manager — config is managed declaratively but the app binary comes from the Homebrew cask.
