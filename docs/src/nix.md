# Nix

System configuration layer. Managed by nix-darwin with home-manager.

**Managed by:** nix flake (`nix/flake.nix`)

## Flake Inputs

| Input | Source | Notes |
|-------|--------|-------|
| nixpkgs | nixpkgs-unstable | Main package set |
| nixpkgs-mise | pinned nixpkgs rev | Avoids Rust source build for mise on aarch64-darwin |
| nix-darwin | LnL7/nix-darwin master | macOS system config |
| home-manager | nix-community master | User config |
| nix-homebrew | zhaofengli/nix-homebrew | Declarative Homebrew |
| NUR | nix-community/NUR | Community packages (Firefox Dev Edition) |

## Overlays

- **nixpkgs-mise:** pulls `mise` from a pinned nixpkgs rev where the aarch64-darwin binary is cached — avoids building from Rust source on every `darwin-rebuild`
- **direnv:** `doCheck = false` — direnv's test suite hangs in the macOS Nix sandbox (FSEvents/tmpdir/process-spawn blocked); upstream has no fix

## Nix Settings

| Setting | Value |
|---------|-------|
| experimental-features | `nix-command`, `flakes` |
| optimise.automatic | true |

## Home Packages (nix, not mise)

| Package | Purpose |
|---------|---------|
| gnupg | GPG toolchain |
| pinentry_mac | GPG passphrase prompt (macOS) |
| pinentry-tty | GPG passphrase prompt (TTY fallback) |
| nix-your-shell | nix develop/nix-shell → nushell |
| xcodes | Xcode version manager (prebuilt) |
| docker-compose | Compose CLI, linked into `~/.docker/cli-plugins/` |
| gmp | Required by cocoapods |
| libyaml | Required by cocoapods |
