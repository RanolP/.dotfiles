# Espanso

Cross-platform text expander written in Rust.

**Managed by:** home-manager service (`services.espanso`)

Runs as a background launchd agent (`org.nix-community.home.espanso`). Configured to start with `espanso daemon` directly to prevent espanso from self-registering a second launchd plist.

## Packages

| Package | Source | Notes |
|---------|--------|-------|
| [typsi](https://github.com/RanolP/typsi) | `pkgs.fetchFromGitHub` pinned to a commit | Typst-y symbol/emoji expansions via `\subset.eq\`, `:arm.mech:`, etc. |

Packages are placed at `~/.config/espanso/match/packages/` via `xdg.configFile` — no `espanso install` needed.
