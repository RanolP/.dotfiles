# Rules for Claude

- **Rebuild after dotfiles edits**: After modifying any file under `nix/home/configs/`, run `sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26`. Changes are not applied until rebuild completes.
- **Never edit global config directly**: Never edit `~/.claude/settings.json` or any file under `~/.claude/` directly. All Claude config lives in `nix/home/configs/claude/` in this repo -- edit there instead.
