source ~/.cache/nix-your-shell.nu

$env.config = ($env.config | upsert show_banner false)

# Launch Claude Code under a named auth profile.
# Empty profile uses the default ~/.claude. Any other profile uses
# ~/.claude-<profile>, which mirrors ~/.claude's config (settings, agents,
# skills, plugins) but keeps its own auth token in that dir's .credentials.json.
def ccc [
  profile: string = ""  # auth profile name; empty = default ~/.claude
  ...rest               # extra args forwarded to claude
] {
  if ($profile | is-empty) {
    ^claude ...$rest
  } else {
    let base = ($env.HOME | path join ".claude")
    let dir = ($env.HOME | path join $".claude-($profile)")
    mkdir $dir
    # Config Claude reads from CLAUDE_CONFIG_DIR; runtime state and the auth
    # token stay per-profile. Links point at ~/.claude/* so nix updates track.
    for entry in [settings.json CLAUDE.md agents skills plugins] {
      let src = ($base | path join $entry)
      if ($src | path exists) {
        ^ln -sfn $src ($dir | path join $entry)
      }
    }
    with-env { CLAUDE_CONFIG_DIR: $dir } { ^claude ...$rest }
  }
}
