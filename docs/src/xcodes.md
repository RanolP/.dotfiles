# Xcodes

Xcode version manager CLI.

**Managed by:** `nix/home/packages/xcodes.nix` (prebuilt nix derivation)

## Why Not Homebrew?

The Homebrew formula for `xcodes` builds from source using `xcbuild`, which requires Xcode to already be installed — a chicken-and-egg problem. This package uses the prebuilt binary from GitHub releases instead.

## Xcode Selection

After each `darwin-rebuild`, the activation script runs `xcode-select -s` pointing to the latest installed `Xcode*.app` in `/Applications`.
