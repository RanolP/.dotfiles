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

# A profile dir gets the config mirror plus the shared store symlink, and the
# default ~/.claude/projects also resolves to the store.
HOME="$(mktemp -d)"; export HOME
mkdir -p "$HOME/.claude/agents"
echo '{}' > "$HOME/.claude/settings.json"
CLAUDE_CONFIG_DIR="$HOME/.claude-work" ; export CLAUDE_CONFIG_DIR
# shellcheck disable=SC1090
. "$SNIPPET"

store="$HOME/.local/share/claude-projects"
[ "$(readlink "$HOME/.claude/projects")" = "$store" ]
check "~/.claude/projects resolves to the store outside .claude" $?
[ "$(readlink "$HOME/.claude-work/settings.json")" = "$HOME/.claude/settings.json" ]
check "settings.json mirrors ~/.claude" $?
[ "$(readlink "$HOME/.claude-work/agents")" = "$HOME/.claude/agents" ]
check "agents/ mirrors ~/.claude" $?
[ ! -e "$HOME/.claude-work/CLAUDE.md" ]
check "absent base entry is skipped, not dangling" $?
[ "$(readlink "$HOME/.claude-work/projects")" = "$store" ]
check "cross-profile resume: projects/ links straight to the store" $?
# Sourcing twice must stay idempotent, not nest projects/ inside itself.
. "$SNIPPET"
[ "$(readlink "$HOME/.claude-work/projects")" = "$store" ]
check "re-running keeps profile projects/ a direct symlink" $?
[ "$(readlink "$HOME/.claude/projects")" = "$store" ]
check "re-running keeps ~/.claude/projects a direct symlink" $?

# Self-heal: a concurrent session recreated ~/.claude/projects as a real dir
# (e.g. it still had a launch in flight when the store migrated). A new
# top-level entry must be moved in, and an entry whose name already exists in
# the store must be merged into it (no-clobber) rather than skipped or
# overwritten -- both files must survive.
HOME="$(mktemp -d)"; export HOME
store="$HOME/.local/share/claude-projects"
mkdir -p "$HOME/.claude" "$store/-repo-b"
echo old > "$store/-repo-b/old.jsonl"
mkdir -p "$HOME/.claude/projects/-repo-a" "$HOME/.claude/projects/-repo-b"
echo a > "$HOME/.claude/projects/-repo-a/session.jsonl"
echo new > "$HOME/.claude/projects/-repo-b/new.jsonl"
CLAUDE_CONFIG_DIR=""
err="$(. "$SNIPPET" 2>&1 >/dev/null)"
[ -z "$err" ]
check "heal of a recreated real dir reports no failure" $?
[ "$(readlink "$HOME/.claude/projects")" = "$store" ]
check "healed ~/.claude/projects ends up a symlink to the store" $?
[ -f "$store/-repo-a/session.jsonl" ]
check "heal moves a non-colliding entry into the store" $?
[ -f "$store/-repo-b/old.jsonl" ] && [ -f "$store/-repo-b/new.jsonl" ]
check "heal merges a colliding entry's contents, keeping both files" $?

# Heal failure: an entry collides with a same-named FILE already in the
# store, so the merge (cp -Rn dir/. store/name/) cannot land -- the real dir
# must survive un-linked and the failure must name the path and exit code.
HOME="$(mktemp -d)"; export HOME
store="$HOME/.local/share/claude-projects"
mkdir -p "$HOME/.claude" "$store"
echo occupied > "$store/-repo-c"
mkdir -p "$HOME/.claude/projects/-repo-c"
echo c > "$HOME/.claude/projects/-repo-c/session.jsonl"
CLAUDE_CONFIG_DIR=""
err="$(. "$SNIPPET" 2>&1 >/dev/null)"
[ -n "$err" ]
check "heal failure is reported" $?
case "$err" in *"-repo-c"*"exit"*) true ;; *) false ;; esac
check "the report names the failing path and its exit code" $?
[ -d "$HOME/.claude/projects" ] && [ ! -L "$HOME/.claude/projects" ]
check "real dir survives un-linked after a heal failure" $?
[ -f "$HOME/.claude/projects/-repo-c/session.jsonl" ]
check "unmerged data is not lost after a heal failure" $?
[ "$(cat "$store/-repo-c")" = occupied ]
check "the store's own entry is never touched by a failed heal" $?

# A real profile projects/ dir holding sessions is healed the same way.
HOME="$(mktemp -d)"; export HOME
store="$HOME/.local/share/claude-projects"
mkdir -p "$HOME/.claude" "$HOME/.claude-old/projects/-some-repo"
echo x > "$HOME/.claude-old/projects/-some-repo/session.jsonl"
CLAUDE_CONFIG_DIR="$HOME/.claude-old"
err="$(. "$SNIPPET" 2>&1 >/dev/null)"
[ -z "$err" ]
check "heal of a real profile projects/ dir reports no failure" $?
[ "$(readlink "$HOME/.claude-old/projects")" = "$store" ]
check "healed profile projects/ ends up a symlink to the store" $?
[ -f "$store/-some-repo/session.jsonl" ]
check "heal moves the profile's session into the store" $?

# The default profile (~/.claude itself) still gets the store link, since the
# wiring for it runs unconditionally.
HOME="$(mktemp -d)"; export HOME
mkdir -p "$HOME/.claude"
CLAUDE_CONFIG_DIR=""
. "$SNIPPET"
[ "$(readlink "$HOME/.claude/projects")" = "$HOME/.local/share/claude-projects" ]
check "empty CLAUDE_CONFIG_DIR still links ~/.claude/projects to the store" $?

[ "$fails" = 0 ] && echo "all passed" || echo "$fails failed"
exit "$fails"
