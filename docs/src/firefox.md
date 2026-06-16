# Firefox

Firefox Developer Edition browser.

**Managed by:** `nix/home/programs/firefox.nix` via NUR (not a Homebrew cask)

## ~/Applications Symlink

macOS privacy dialogs (camera, microphone, screen recording, etc.) look for the app in `~/Applications` or `/Applications`. Because Firefox is installed via Nix into the store, it's not in either location by default.

The darwin activation script symlinks the Nix store path into `~/Applications/Firefox Developer Edition.app` so macOS privacy access works correctly.
