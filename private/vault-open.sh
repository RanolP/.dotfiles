#!/usr/bin/env bash
# Decrypt the vault and install its contents into ~/.claude/skills/.
# You are prompted for the passphrase.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${HOME}/.claude/skills"
command -v age >/dev/null || { echo "age not found (add pkgs.age + darwin-rebuild)"; exit 1; }
[ -f "$HERE/store.age" ] || { echo "no store.age yet — run vault-seal.sh first"; exit 1; }
mkdir -p "$DEST"
age -d "$HERE/store.age" | tar -xzf - -C "$DEST"
echo "opened -> $DEST"
