# Homebrew

Declarative Homebrew managed by [nix-homebrew](https://github.com/zhaofengli/nix-homebrew), locked to the `Homebrew/brew` flake input.

**Managed by:** `nix/darwin/default.nix`

## Activation Policy

| Setting | Value |
|---------|-------|
| autoUpdate | false |
| upgrade | true |
| greedyCasks | true |
| cleanup | `zap` |
| extraFlags | `--force` |

## Brews (CLI formulas)

| Formula | Purpose |
|---------|---------|
| git-absorb | Auto-fixup commits |
| git-filter-repo | Rewrite git history |
| mdbook | Build this documentation |
| libmagic | Library used by the `reuse` pipx tool |

## Casks (GUI apps)

| Cask | App |
|------|-----|
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
| openusage | Usage monitor |
| shottr | Screenshot utility |
| menubarx | Menu bar browser |
| proxyman | HTTP debugging proxy |
| thaw | Menu bar utility |

The `displaylink`, `obs`, `steam`, and `tailscale-app` casks are scoped to `ranolp-work-MBP-26` in `nix/darwin/default.nix`.

## Fonts (casks)

| Cask | Font |
|------|------|
| font-iosevka-nerd-font | Iosevka Nerd Font — terminal / editor |
| font-pretendard | Pretendard — UI / Korean text |
