# Rules for Agents

- **Rebuild after dotfiles edits**: After modifying any file under `nix/home/configs/`, run `sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26`. Changes are not applied until rebuild completes.
- **Direct main git workflow allowed here**: When requested, agents should create commits on `main` and push `main` to `origin` in this repository. Inspect status/diff first, stage explicit paths, and keep PR workflows out of scope.
- **Never edit global config directly**: Never edit `~/.claude/settings.json` or any file under `~/.claude/` directly. All Claude config lives in `nix/home/configs/claude/` in this repo -- edit there instead.
