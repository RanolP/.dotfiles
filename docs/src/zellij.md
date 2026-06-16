# Zellij

Terminal multiplexer.

**Managed by:** `nix/home/programs/zellij.nix`

## Keybinds

| Shortcut | Action |
|----------|--------|
| Super+D | New pane to the right |
| Super+Shift+D | New pane below |

These mirror the bindings unbound in [Ghostty](./ghostty.md).

## Behaviour

| Setting | Value |
|---------|-------|
| exit_on_close | true |
| on_force_close | quit |
| show_release_notes | false |
| show_startup_tips | false |
| default_layout | default |

## Layout

Bare default layout — no tab bar, just a pane area (`children`).

## zjstatus

Status bar plugin. Pinned at v0.23.0, fetched as a `.wasm` binary from GitHub releases.
