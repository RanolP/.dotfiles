# Starship

Cross-shell prompt.

**Managed by:** `nix/home/programs/starship.nix`

## Prompt Modules (left to right)

`directory` → `git_branch` → `git_commit` → `git_state` → `git_status` → `nodejs` → `python` → `rust` → `golang` → `kotlin` → `java` → `swift` → `$fill` → `cmd_duration` → `time` → newline → `character`

The `$fill` module is a spacer — it pushes `cmd_duration` and `time` to the right edge of the terminal on the same line as the left modules.

When Nushell is in a WSL Windows-drive directory under `/mnt/`, it switches to `starship-winfs.toml`, which omits language modules that scan project files. The generated variant is declared in `nix/home/programs/starship.nix`.

## Module Settings

| Module | Setting | Value |
|--------|---------|-------|
| cmd_duration | min_time | 5000ms |
| cmd_duration | format | `[took $duration]($style) ` |
| cmd_duration | style | yellow |
| time | disabled | false |
| time | format | `[🕐 $time]($style)` |
| time | style | cyan |
