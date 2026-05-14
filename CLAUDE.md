# Rules for Claude

- **Rebuild after dotfiles edits**: After modifying any file under `nix/home/configs/`, run `sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26`. Changes are not applied until rebuild completes.
