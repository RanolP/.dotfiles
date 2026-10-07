# Notion

Notes and documents, with the `ntn` CLI and its matching agent skill.

**Managed by:** Homebrew cask

The CLI version is pinned as `npm:ntn` in `nix/home/mise-global.toml`. `nix/home/default.nix` also links the pinned Notion `notion-cli` skill into both agent skill trees. On macOS, `nix/home/darwin/default.nix` provides a `notion` shim that directs callers to the official `ntn` command.
