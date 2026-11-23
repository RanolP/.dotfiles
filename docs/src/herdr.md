# Herdr

Terminal workspace manager configured for Nushell and the pinned browser and hands-free plugins.

**Managed by:** the macOS mise overlay and Home Manager configuration in `nix/home/default.nix`.

## Configuration

Home Manager writes the Herdr configuration with Nushell as the default shell, Nord theme, and tab actions unbound. Workspaces remain the grouping level, with the tab bar hidden; the agent panel sorts by priority. `prefix+d` toggles dictation and `prefix+g` toggles gaze mouse through the hands-free plugin.

The activation entries in `nix/home/default.nix` link the pinned `herdr-browser` and `herdr-handsfree` plugin sources. The hands-free plugin uses a prebuilt macOS release binary. The browser plugin manifest is adjusted to call the declared Bun runtime.
