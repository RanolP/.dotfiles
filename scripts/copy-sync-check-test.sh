#!/bin/sh
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/copy-sync-check-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

mkdir -p "$tmp/web/nested" "$tmp/app/nested"
printf 'same\n' > "$tmp/web/nested/shared.txt"
cp "$tmp/web/nested/shared.txt" "$tmp/app/nested/shared.txt"
cat > "$tmp/manifest.toml" <<EOF
[roots]
web = "$tmp/web"
app = "$tmp/app"
files = ["nested/shared.txt"]
EOF

# Catch a regression that stops comparing copies after the matching case.
output=$("$repo/nix/home/configs/bin/copy-sync-check" "$tmp/manifest.toml")
printf '%s\n' "$output" | grep -F '1 files match across web, app' >/dev/null
printf 'changed\n' > "$tmp/app/nested/shared.txt"
if output=$("$repo/nix/home/configs/bin/copy-sync-check" "$tmp/manifest.toml" 2>&1); then
  printf '%s\n' 'expected differing copies to exit 1' >&2
  exit 1
else
  status=$?
fi
[ "$status" -eq 1 ]
printf '%s\n' "$output" | grep -F 'nested/shared.txt' >/dev/null
