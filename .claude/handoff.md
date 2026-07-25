# Handoff: Recommend good VS Code options

## Context
- Repo: `/Users/ranolp/.dotfiles` (Nix flake dotfiles, macOS/darwin)
- Stack: Nix home-manager, VS Code config managed via `nix/home/programs/vscode.nix`
- Apply changes with: `sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26`

## Completed
- [x] Added Pretendard as font fallback in VS Code (`editor.fontFamily = "Iosevka Nerd Font Mono, Pretendard"`) to fix Korean text rendering glitch with Claude Code extension

## Not Yet Done
- [ ] Review and recommend additional useful VS Code settings for the user

## Failed Approaches (Do Not Repeat)
- Tried editing `/Users/ranolp/Library/Application Support/Code/User/settings.json` directly -- it is a Nix symlink pointing to the Nix store; writes are refused. Edit `nix/home/programs/vscode.nix` instead.

## Key Decisions
| Decision | Rationale |
|----------|-----------|
| Edit `vscode.nix`, not the live `settings.json` | settings.json is a read-only Nix store symlink |
| Pretendard as font fallback | User already has Pretendard in Ghostty; fixes CJK rendering in Claude Code VS Code extension |

## Current State
**Working:** `vscode.nix` updated with Pretendard fallback; darwin-rebuild not yet run.
**Broken:** Nothing broken; Korean rendering glitch fix pending rebuild.
**Uncommitted changes:** `nix/home/programs/vscode.nix` modified (font fallback), plus several other unrelated staged/unstaged files from prior sessions.

## Files to Know
| File | Why it matters |
|------|----------------|
| `nix/home/programs/vscode.nix` | All VS Code settings -- edit here, not in Library |
| `nix/home/default.nix` | Home-manager entrypoint, imports vscode.nix |

## Resume Instructions

1. Read `nix/home/programs/vscode.nix` to see current settings.
   - Expected: `editor.fontFamily = "Iosevka Nerd Font Mono, Pretendard"` and the existing userSettings block.
   - If it fails: check `nix/home/default.nix` for the correct import path.

2. Review the current `userSettings` block and identify gaps.
   - Categories to consider: editor ergonomics, formatting, Git UX, terminal, accessibility, performance.

3. Propose additions to the user before editing.

4. After user approves, edit `vscode.nix` and remind user to run:
   `sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26`

## Your Task
Recommend good VS Code `userSettings` options to add to `nix/home/programs/vscode.nix`.
Look at what is already configured, identify what is missing, and suggest useful additions with rationale.
Acceptance criteria: user reviews suggestions and selects which to apply; selected options are added to `vscode.nix`.
