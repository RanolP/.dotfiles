# Karabiner-Elements

Keyboard remapping.

**Managed by:** `nix/home/configs/karabiner/karabiner.json` (via `home.file`, `force = true`), installed via Homebrew cask

## MacBook Internal Keyboard — Windows-style Layout

Remaps the built-in keyboard so modifier positions match a standard Windows keyboard muscle memory.

| Physical Key | Remapped To |
|-------------|-------------|
| Fn | Left Command |
| Left Control | Fn |
| Left Command | Left Control |
| Right Command | F18 (한영 toggle) |

## Dareu Z82 (vendor 9741, product 48)

External keyboard remapping for the Dareu Z82.

| Physical Key | Remapped To |
|-------------|-------------|
| Left Control | Left Command |
| Left Command | Left Option |
| Left Option | Left Control |
| Right Option | F18 (한영 toggle) |

## F18 → 한영

F18 is mapped to the Korean input method toggle (symbolic hotkey ID 60) via the macOS activation script in `nix/darwin/default.nix`.
