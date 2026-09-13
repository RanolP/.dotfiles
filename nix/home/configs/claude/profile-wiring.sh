# Wire a named Claude Code auth profile dir (~/.claude-<profile>, chosen by
# nushell's `ccc`): mirror ~/.claude's config into it, keep its auth token
# per-profile, and point its projects/ at the shared ~/.claude/projects so
# /resume lists every profile's sessions instead of only the running one's.
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
    mkdir -p "$base/projects"
    _claude_link "$base/projects" "$dir/projects" || cat >&2 <<MERGE
claude: this profile's sessions stay out of /resume until its store is merged.
claude: with no claude running, merge once:
claude:   cp -rn "$dir/projects/." "$base/projects/" && rm -rf "$dir/projects"
MERGE
    ;;
esac
