#!/usr/bin/env bash
# Verify a Claude Code hook in a container, before it is deployed or registered.
#
# A PreToolUse hook on the `Bash` matcher runs in front of every Bash call in
# every session on this machine. A hook that crashes takes all of them down
# until the next rebuild, so it has to be proven against a clean interpreter
# that shares nothing with the live setup -- no ~/.claude, no site-packages,
# no network, and a read-only copy of the repo.
#
# Usage: scripts/verify-claude-hook.sh nix/home/configs/claude/hooks/<name>.py [...]
#        scripts/verify-claude-hook.sh --all
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

# Match the interpreter the hook actually runs under: the mise python on PATH
# at hook time. A hook that passes on 3.12 and crashes on 3.14 is not verified.
version="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
image="python:${version}-slim"

# macOS ships bash 3.2, which has no `mapfile` -- a plain glob covers it.
if [ "${1:-}" = "--all" ]; then
    hooks=(nix/home/configs/claude/hooks/*.py)
elif [ "$#" -gt 0 ]; then
    hooks=("$@")
else
    echo "usage: $0 <hook.py> [...] | --all" >&2
    exit 2
fi

# Paths as the container sees them: the repo is mounted read-only at /repo, so
# a hook that writes to a source path fails here instead of on the real tree.
container_hooks=()
for h in "${hooks[@]}"; do
    rel="${h#"$repo"/}"
    [ -f "$repo/$rel" ] || { echo "no such hook: $rel" >&2; exit 2; }
    container_hooks+=("/repo/$rel")
done

echo "image: $image (matching the host's python3 $version)"

exec docker run --rm \
    --network none \
    --read-only \
    --tmpfs /tmp:rw,size=64m \
    -v "$repo:/repo:ro" \
    -w /repo \
    "$image" \
    python3 /repo/scripts/hook-contract-test.py "${container_hooks[@]}"
