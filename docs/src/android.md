# Android SDK

Android development environment.

**Managed by:** `nix/home/default.nix` (activation script + casks)

## Components

| Component | Source |
|-----------|--------|
| android-commandlinetools | Homebrew cask |
| temurin (JDK) | Homebrew cask |
| SDK packages | installed by home-manager activation |

## Environment

| Variable | Value |
|----------|-------|
| `ANDROID_HOME` | `~/Library/Android/sdk` |
| `JAVA_HOME` | resolved via `/usr/libexec/java_home` |

Android SDK paths are also prepended to `PATH` in `env.nu` — see [Nushell](./nushell.md).

## SDK Packages (auto-installed on activation)

- `platform-tools`
- `platforms;android-35`
- `build-tools;35.0.0`
- `emulator`

## sdkmanager awk Workaround

`sdkmanager` is a bash script that calls bare `awk`, which isn't in `PATH` during nix-darwin activation. The activation script patches the `sdkmanager` binary to use `/usr/bin/awk` — applied after every `darwin-rebuild` to survive brew upgrades.
