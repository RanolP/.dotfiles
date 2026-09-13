#!/usr/bin/env bash
# Self-check for nix/home/configs/claude/profile-wiring.sh -- the snippet both
# platform `claude` wrappers source to wire ~/.claude-<profile> dirs.
# Run: ./scripts/profile-wiring-test.sh
set -uo pipefail

SNIPPET="$(cd "$(dirname "$0")/.." && pwd)/nix/home/configs/claude/profile-wiring.sh"
fails=0
check() { # check <label> <condition-result>
  if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FAIL $1"; fails=$((fails + 1)); fi
}

# A profile dir gets the config mirror plus the shared projects/ symlink.
HOME="$(mktemp -d)"; export HOME
mkdir -p "$HOME/.claude/agents" "$HOME/.claude/projects/-some-repo"
echo '{}' > "$HOME/.claude/settings.json"
CLAUDE_CONFIG_DIR="$HOME/.claude-work" ; export CLAUDE_CONFIG_DIR
# shellcheck disable=SC1090
. "$SNIPPET"

[ "$(readlink "$HOME/.claude-work/settings.json")" = "$HOME/.claude/settings.json" ]
check "settings.json mirrors ~/.claude" $?
[ "$(readlink "$HOME/.claude-work/agents")" = "$HOME/.claude/agents" ]
check "agents/ mirrors ~/.claude" $?
[ ! -e "$HOME/.claude-work/CLAUDE.md" ]
check "absent base entry is skipped, not dangling" $?
[ -d "$HOME/.claude-work/projects/-some-repo" ]
check "cross-profile resume: projects/ reaches ~/.claude/projects" $?
# Sourcing twice must stay idempotent, not nest projects/ inside itself.
. "$SNIPPET"
[ "$(readlink "$HOME/.claude-work/projects")" = "$HOME/.claude/projects" ]
check "re-running keeps projects/ a direct symlink" $?

# A real projects/ dir holding sessions must fail loudly, never be hidden.
HOME="$(mktemp -d)"; export HOME
mkdir -p "$HOME/.claude" "$HOME/.claude-old/projects/-some-repo"
CLAUDE_CONFIG_DIR="$HOME/.claude-old"
err="$(. "$SNIPPET" 2>&1 >/dev/null)"
[ -n "$err" ] && [ -d "$HOME/.claude-old/projects/-some-repo" ]
check "real projects/ dir survives and is reported" $?
[ ! -e "$HOME/.claude-old/projects/projects" ]
check "no link nested inside the real projects/ dir" $?
case "$err" in *"cp -rn"*) true ;; *) false ;; esac
check "the report names the merge command" $?

# The default profile (~/.claude itself) is left completely alone.
HOME="$(mktemp -d)"; export HOME
mkdir -p "$HOME/.claude"
CLAUDE_CONFIG_DIR=""
. "$SNIPPET"
[ ! -e "$HOME/.claude/projects" ]
check "empty CLAUDE_CONFIG_DIR wires nothing" $?

[ "$fails" = 0 ] && echo "all passed" || echo "$fails failed"
exit "$fails"
