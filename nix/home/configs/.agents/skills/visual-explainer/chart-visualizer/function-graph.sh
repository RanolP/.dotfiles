#!/bin/sh
# Renders a function-graph spec to a static HTML fragment.
# usage: function-graph.sh <spec.json> <out.html>
# Installs the pinned packages into a cache outside the repository, reinstalling only when the lockfile changes.
# `install -m 0644` because the sources come from the read-only nix store and a plain cp cannot overwrite them.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
cache=${XDG_CACHE_HOME:-$HOME/.cache}/visual-explainer/chart-visualizer
mkdir -p "$cache"
if ! cmp -s "$here/package-lock.json" "$cache/package-lock.json" || [ ! -d "$cache/node_modules" ]; then
  install -m 0644 "$here/package.json" "$here/package-lock.json" "$cache/"
  npm ci --prefix "$cache" --no-audit --no-fund >&2
fi
install -m 0644 "$here/function-graph.mjs" "$cache/function-graph.mjs"
exec node "$cache/function-graph.mjs" "$@"
