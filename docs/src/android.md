# Android SDK

Android development environment.

**Managed by:** Homebrew casks in `nix/darwin/default.nix` and SDK activation in `nix/home/darwin/default.nix`

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

Android SDK paths are also prepended to `PATH` in `nix/home/configs/nushell/env.darwin.nu` — see [Nushell](./nushell.md).

## SDK Packages (auto-installed on activation)

- `platform-tools`
- `platforms;android-35`
- `build-tools;35.0.0`
- `emulator`
- `system-images;android-35;google_apis;arm64-v8a`

## sdkmanager awk Workaround

`nix/darwin/default.nix` patches `sdkmanager` to use `/usr/bin/awk` during activation when its script contains a bare `awk` command.
