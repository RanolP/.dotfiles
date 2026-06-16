# macOS Bootstrap

End-to-end setup for a fresh Mac, from OOBE to a fully-applied `nix-darwin` config.

## 1. Make the Filesystem Case-Sensitive

- Boot into [Recovery Mode](https://support.apple.com/en-asia/102518)
- Open Disk Utility
- Erase every volume. When you delete the last volume, the dialog appears — pick `APFS (Case-Sensitive)` for **Format**.
- Reinstall macOS

## 2. macOS Setup Assistant

- Language: English
- Country/Region: South Korea
- Accessibility: Not now
- Wi-Fi: connect
- Migration Assistant: Not now
- Apple ID: Set Up Later
- Create computer account
- Time Zone: Seoul
- Analytics: uncheck "Share Mac Analytics with Apple"
- Siri: uncheck "Enable Ask Siri"
- Look: Dark

## 3. Initial System Settings

Things easier to do by hand before `nix-darwin` takes over:

- System Settings → Trackpad
  - Check "Use trackpad for dragging"
  - Dragging Style: "Three Finger Drag"
- System Settings → Control Center
  - Battery: "Show Percentage"
  - Spotlight: "Don't Show in Menu Bar"
- Finder → Settings
  - New windows show: `<username>`
  - Sidebar: uncheck Recents, AirDrop, Applications, Bonjour, Recent Tags
  - Advanced: "Show all filename extensions"
- Strip dock down to essentials

## 4. Homebrew (+ Xcode CLI tools)

Open **Safari**, go to [brew.sh](https://brew.sh), and copy the install command into **Terminal**. The Homebrew installer will trigger the Xcode Command Line Tools install along the way — let it finish.

## 5. Browser & Bitwarden

```sh
brew install --cask firefox@developer-edition claude
```

In Firefox:

- Install the **Bitwarden** extension and sign in (vault is needed for the rest of the credentials below)
- Sign in to Claude

## 6. Pre-Nix CLI tools via Homebrew + mise

These exist temporarily so the rest of bootstrap (clone, auth, GPG) works before `nix-darwin` takes over. `nix-darwin` will later re-install them through `nix-homebrew` + `mise`, which is fine — the configs converge.

```sh
brew install mise gpg

mise use -g gh
mise use -g node@24
mise use -g pnpm@10

gh auth login   # scope: read:packages (see Manual Setup.md)
```

## 7. Install Nix

Multi-user install via the official installer:

```sh
sh <(curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install)
```

The installer:

- creates build users (`_nixbld1`..`_nixbld32`) and the `nixbld` group
- mounts a dedicated `/nix` APFS volume
- installs the `nix-daemon` LaunchDaemon
- patches `/etc/zshrc` and `/etc/bashrc` to source `nix-daemon.sh`

Open a **new** terminal so the patched rc loads, then verify:

```sh
nix --version
```

### Enable flakes

The flake-based config needs flakes + the new CLI. Append to `/etc/nix/nix.conf`:

```
experimental-features = nix-command flakes
```

## 8. Clone the dotfiles

```sh
mkdir -p ~/.dotfiles
git clone https://github.com/RanolP/.dotfiles.git ~/.dotfiles
```

## 9. Apply the nix-darwin config

First-time apply — `darwin-rebuild` isn't on PATH yet, so bootstrap it through `nix run`:

```sh
sudo nix run nix-darwin -- switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26
```

Subsequent rebuilds use the `rebuild` alias (or `darwin-rebuild switch` directly).

## 10. Manual app setup

See [Manual Setup](../Manual%20Setup.md) for things that can't be configured via Nix (Cursor login, Bitwarden toggles, Firefox extensions, Safari devtools, GitHub CLI scopes, etc.).
