# Homebrew

Declarative Homebrew managed by [nix-homebrew](https://github.com/zhaofengli/nix-homebrew), locked to the `Homebrew/brew` flake input.

**Managed by:** `nix/darwin/default.nix`

## Activation Policy

| Setting | Value |
|---------|-------|
| autoUpdate | true |
| cleanup | `zap` (removes everything not declared) |

## Brews (CLI formulas)

| Formula | Purpose |
|---------|---------|
| git-absorb | Auto-fixup commits |
| git-filter-repo | Rewrite git history |
| mdbook | Build this documentation |

## Casks (GUI apps)

| Cask | App |
|------|-----|
| claude | Anthropic Claude desktop |
| ghostty | Terminal emulator |
| raycast | Launcher |
| karabiner-elements | Keyboard remapping |
| linearmouse | Mouse/trackpad customization |
| discord | Messaging |
| bitwarden | Password manager |
| figma | Design tool |
| slack | Messaging |
| android-commandlinetools | Android SDK manager |
| temurin | OpenJDK (for Android builds) |
| google-chrome | Browser |
| notion | Notes |
| keybase | Encrypted messaging / file storage |

## Fonts (casks)

| Cask | Font |
|------|------|
| font-iosevka-nerd-font | Iosevka Nerd Font — terminal / editor |
| font-pretendard | Pretendard — UI / Korean text |
