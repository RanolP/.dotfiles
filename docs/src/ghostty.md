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
| Super+D | New split to the right |
| Super+Shift+D | New split below |

`package = null` in home-manager — config is managed declaratively but the app binary comes from the Homebrew cask.
