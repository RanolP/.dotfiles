# fast-apply

Local file-edit command for exact replacements and anchored block merges.

**Managed by:** `nix/home/configs/bin/fast-apply`, installed by `nix/home/default.nix` as an executable.

## Modes

| Command | Behavior |
|---------|----------|
| `fast-apply FILE --old OLD --new NEW` | Replaces exactly one match; `--all` opts into replacing every match |
| `fast-apply FILE --lazy` | Reads a snippet from stdin and merges text between ordered, exact-match anchors |
| Either edit mode with `--dry-run` | Prints the proposed diff without writing |
| `fast-apply --selftest` | Runs the script's offline assertions |

Edits refuse ambiguous or missing matches, write atomically, and print a diff. `nix/home/configs/claude/hooks/file-edit-guard.py` can direct shell-based file edits to this command.
