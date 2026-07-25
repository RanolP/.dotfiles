#!/usr/bin/env bash
# Encrypt a plaintext directory into the passphrase-protected vault (age/scrypt).
# You are prompted for the passphrase; it is never stored.
# Usage: vault-seal.sh <plaintext-dir>
set -euo pipefail
SRC="${1:?usage: vault-seal.sh <plaintext-dir>}"
SRC="${SRC%/}"
HERE="$(cd "$(dirname "$0")" && pwd)"
name="$(basename "$SRC")"
parent="$(dirname "$SRC")"
command -v age >/dev/null || { echo "age not found (add pkgs.age + darwin-rebuild)"; exit 1; }
tar -czf - -C "$parent" "$name" | age -p -a -o "$HERE/store.age"
echo "sealed '$name' -> $HERE/store.age"
