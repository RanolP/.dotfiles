# Wire a named Claude Code auth profile dir (~/.claude-<profile>, chosen by
# nushell's `ccc`): mirror ~/.claude's config into it, keep its auth token
# per-profile, and point every profile's (and the default's) projects/ at the
# shared store outside ~/.claude, so /resume lists every profile's sessions
# instead of only the running one's. The store lives at
# ~/.local/share/claude-projects rather than inside ~/.claude: Claude Code
# 2.1.280 treats any path with a ".claude" segment as protected, which allow
# rules cannot override, so memory writes through the old
# ~/.claude-personal/projects -> ~/.claude/projects symlink prompted every
# time.
#
# Sourced by both platform wrappers -- ~/.local/bin/claude on macOS
# (nix/home/darwin/default.nix) and the ~/.nix-profile/bin/claude shim on Linux
# (nix/home/linux/default.nix) -- at every launch, because a shell function
# like `ccc` is baked into running shells at startup and goes stale after a
# rebuild. `ccc` only picks the profile and sets CLAUDE_CONFIG_DIR.
#
# Checked by scripts/profile-wiring-test.sh.

# Link $2 -> $1, but only when $2 is absent or already a symlink. `ln -sfn`
# over a REAL directory does not fail: POSIX drops the link inside it, leaving
# $2/$2 and hiding whatever $2 already held. Report that instead.
_claude_link() {
  if [ -L "$2" ] || [ ! -e "$2" ]; then
    ln -sfn "$1" "$2"
  else
    echo "claude: $2 is a real path, so it is NOT shared with $1" >&2
    return 1
  fi
}

# Merge a real directory ($1) that should be the symlink back into the store
# ($2), then replace it with the symlink. A concurrent claude session can
# recreate $1 as a real dir between this session's launches, so this runs on
# every launch rather than once: move each top-level entry into the store
# when the store lacks that name, otherwise copy its contents in with
# no-clobber and drop the source copy only once that copy succeeds. Never
# touches anything already inside the store. On any per-entry failure, $1 is
# left in place (not linked) and the failing path plus exit code is reported.
_claude_heal() {
  real="$1" store="$2" ok=1
  for entry in "$real"/* "$real"/.[!.]*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    if [ ! -e "$store/$name" ]; then
      mv "$entry" "$store/$name"; rc=$?
    elif [ -d "$entry" ]; then
      cp -Rn "$entry/." "$store/$name/"; rc=$?
      [ "$rc" -eq 0 ] && rm -rf "$entry"
    else
      cp -n "$entry" "$store/$name"; rc=$?
      [ "$rc" -eq 0 ] && rm -f "$entry"
    fi
    if [ "$rc" -ne 0 ]; then
      echo "claude: heal of $entry into $store failed (exit $rc)" >&2
      ok=0
    fi
  done
  [ "$ok" = 1 ] || return 1
  rmdir "$real" && ln -sfn "$store" "$real"
}

# Heal $2 into $1 first when a concurrent session left it a real dir, then
# link it -- so a launch that races another session's migration still ends
# with $2 pointed at the store instead of failing on a real dir that just
# reappeared.
_claude_link_or_heal() {
  if [ -e "$2" ] && [ ! -L "$2" ]; then
    _claude_heal "$2" "$1"
  fi
  _claude_link "$1" "$2"
}

# Outside the case so the default profile (CLAUDE_CONFIG_DIR unset) also gets
# ~/.claude/projects pointed at the unprotected store.
store="$HOME/.local/share/claude-projects"
mkdir -p "$store"
_claude_link_or_heal "$store" "$HOME/.claude/projects"

case "$CLAUDE_CONFIG_DIR" in
  "$HOME/.claude-"*)
    base="$HOME/.claude"
    dir="$CLAUDE_CONFIG_DIR"
    mkdir -p "$dir"
    # Config mirrors ~/.claude so nix updates track; runtime state and the
    # auth token stay per-profile in $dir.
    # output-styles must be listed: settings.json mirrors "outputStyle" by
    # name, so without the definitions the profile fails silently.
    for entry in settings.json CLAUDE.md agents skills plugins output-styles; do
      [ -e "$base/$entry" ] && _claude_link "$base/$entry" "$dir/$entry"
    done
    # Sessions live in projects/; sharing one store across profiles is what
    # lets /resume reach a session another account started.
    _claude_link_or_heal "$store" "$dir/projects"
    ;;
esac
