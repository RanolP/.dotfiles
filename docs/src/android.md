# Android SDK

Android development environment.

**Managed by:** Homebrew casks in `nix/darwin/default.nix` and SDK activation in `nix/home/darwin/default.nix`

## Components

| Component | Source |
|-----------|--------|
| android-commandlinetools | Homebrew cask |
| temurin (JDK) | Homebrew cask |
| SDK packages, AVD | installed by home-manager activation through Android CLI (`android`, launched by the commandlinetools cask) |

## Environment

| Variable | Value |
|----------|-------|
| `ANDROID_HOME` | `~/Library/Android/sdk` |
| `JAVA_HOME` | resolved via `/usr/libexec/java_home` |

Android SDK paths are also prepended to `PATH` in `nix/home/configs/nushell/env.darwin.nu` — see [Nushell](./nushell.md).

## SDK Packages (auto-installed on activation)

- `platform-tools`
- `platforms/android-35`
- `build-tools/35.0.0`
- `emulator`
- `system-images/android-36/google_apis_playstore/arm64-v8a`

## Emulator

Activation creates the `medium_phone` AVD once with `android emulator create medium_phone`, which uses the Google Play system image above. Start it with `android emulator start medium_phone`.

The commandlinetools cask stays, because its `zap` trashes `~/.android`, which holds every AVD and Android CLI itself. The standalone `android-cli` cask would also collide with it on the `android` binary.
