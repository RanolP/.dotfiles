# Nix

System configuration layer. Managed by nix-darwin with home-manager.

**Managed by:** nix flake (`nix/flake.nix`)

## Flake Inputs

| Input | Source | Notes |
|-------|--------|-------|
| nixpkgs | nixpkgs-unstable | Main package set |
| nixpkgs-mise | pinned nixpkgs revision | Supplies the cached aarch64-darwin mise package |
| nix-darwin | LnL7/nix-darwin master | macOS system config |
| home-manager | nix-community master | User config |
| homebrew-brew | Homebrew/brew | Locked Homebrew source |
| nix-homebrew | zhaofengli/nix-homebrew | Declarative Homebrew integration |
| nur | nix-community/NUR | Community package set, including Firefox add-ons |

## Overlays

- **nixpkgs-mise:** overlays the pinned `mise` package on macOS to use the cached aarch64-darwin binary.
- **nur:** exposes the NUR package set as `pkgs.nur` (Firefox add-ons).

## Nix Settings

| Setting | Value |
|---------|-------|
| experimental-features | `nix-command`, `flakes` |
| optimise.automatic | true |

## Home Packages (nix, not mise)

| Package | Purpose |
|---------|---------|
| age | Encryption tool |
| bun | Runtime for the Herdr browser plugin |
| ffmpeg | Composes Jira QA review videos |
| gnupg | GPG toolchain |
| nix-your-shell | nix develop/nix-shell → nushell |

macOS adds `pinentry_mac`, `pinentry-tty`, `xcodes`, `docker-compose`, `gmp`, and `libyaml` in `nix/home/darwin/default.nix`. Home Manager links the Compose plugin and installs the Xcodes release binary from `nix/home/darwin/packages/xcodes.nix`.

## macOS Defaults

`nix/darwin/default.nix` enables Touch ID for `sudo`, hides the Dock automatically, disables recent apps, shows file extensions and hidden files in Finder, selects dark appearance, speeds up key repeat, and enables trackpad clicking and three-finger drag. It also disables the Bluetooth menu-bar item.

The activation script assigns the bottom-left Dock hot corner to Lock Screen, maps F18 to the Korean input toggle, disables Spotlight's Cmd+Space shortcut, and maps Cmd+Shift+S to the screenshot toolbar. It also disables the macOS 26 SwiftUI glass effect and patches `sdkmanager` to call `/usr/bin/awk`.

## Services

macOS enables Syncthing and Espanso through Home Manager. Espanso's signed 2.3.0 app is downloaded and copied during activation; its match packages are declared in `nix/home/darwin/default.nix`.
