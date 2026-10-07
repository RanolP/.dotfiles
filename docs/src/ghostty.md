# Ghostty

Terminal emulator.

**Managed by:** `nix/home/darwin/programs/ghostty.nix` (config), installed via Homebrew cask

## Settings

| Setting | Value |
|---------|-------|
| theme | Nord |
| font-family | Iosevka Nerd Font Mono, Pretendard |
| font-size | 16 |
| command | Nushell from the Home Manager profile |

## Keybinds

| Binding | Action |
|---------|--------|
| Super+D | New split to the right |
| Super+Shift+D | New split below |
| Super+Alt+D | Fallback split to the right |
| Super+Alt+Shift+D | Fallback split below |
| Super+Alt+T | New tab |
| Super+Alt+W | Close surface |

Karabiner routes the unmodified Super shortcuts through `herdr-key`; the Alt shortcuts are Ghostty fallbacks when Herdr is not active.

`package = null` in home-manager — config is managed declaratively but the app binary comes from the Homebrew cask.
