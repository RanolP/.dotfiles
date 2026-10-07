# Xcodes

Xcode version manager CLI.

**Managed by:** `nix/home/darwin/packages/xcodes.nix` (Home Manager package from the GitHub release binary, version 1.6.2)

## Why Not Homebrew?

The Homebrew formula for `xcodes` builds from source using `xcbuild`, which requires Xcode to already be installed — a chicken-and-egg problem. This package uses the prebuilt binary from GitHub releases instead.

The package fetches the aarch64 macOS release archive from GitHub and installs its `xcodes` executable.

## Xcode Selection

The activation script in `nix/darwin/default.nix` runs `xcode-select -s` for the latest installed `Xcode*.app` when one is present.
