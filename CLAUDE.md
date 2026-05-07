# Rules for Claude

Be brief.

- **No hallucinations**: Before suggesting config options, CLI flags, or nix options, verify against official docs, man pages, or source. Use WebSearch/WebFetch if unsure — never write unverified options into code.
- **Rebuild after dotfiles edits**: After modifying any file under `nix/home/configs/`, run `sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26`. Changes are not applied until rebuild completes.
