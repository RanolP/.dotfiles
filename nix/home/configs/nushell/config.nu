source ~/.cache/nix-your-shell.nu

$env.config = ($env.config | upsert show_banner false)

# --- Per-folder terminal background (Ghostty, OSC 11) ---
# Tints the Ghostty background per project so it's obvious which repo you're in.
# Only active in bare Ghostty; Zellij owns its own rendering, so it's skipped there.
# Backgrounds stay dark so the Nord foreground keeps its contrast.
def _folder-bg-color []: nothing -> string {
  # Explicit overrides win; matched against the absolute project-root path.
  let overrides = [
    { path: ($env.HOME | path join ".dotfiles"), color: "3b3042" }
  ]
  # Dark Nord-family tints used as the auto-hash fallback.
  let palette = [
    "2e3b3b" "3b382e" "2e343f" "3b2e2e"
    "2e3b30" "34303b" "3b3630" "303b38"
  ]
  let root = (try { ^git rev-parse --show-toplevel | str trim } catch { null })
  # Not inside a repo -> restore the default Nord background.
  if ($root | is-empty) { return "2e3440" }
  let hit = ($overrides | where path == $root)
  if ($hit | is-not-empty) { return ($hit | first | get color) }
  let idx = ($root | hash sha256 | str substring 0..7 | into int --radix 16) mod ($palette | length)
  $palette | get $idx
}

$env.config.hooks.env_change.PWD = (
  ($env.config.hooks?.env_change?.PWD? | default [])
  | append {|before, after|
      if ($env.TERM_PROGRAM? == "ghostty") and ($env.ZELLIJ? | is-empty) {
        print -n $"(char -u '1b')]11;#(_folder-bg-color)(char -u '07')"
      }
    }
)

# Launch Claude Code under a named auth profile.
# Empty profile uses the default ~/.claude. Any other profile uses
# ~/.claude-<profile>, which mirrors ~/.claude's config (settings, agents,
# skills, plugins) but keeps its own auth token in that dir's .credentials.json.
def --wrapped ccc [
  profile: string = ""  # auth profile name; empty = default ~/.claude
  ...rest               # extra args and flags forwarded to claude
] {
  # A leading flag (ccc --chrome) is an arg for claude, not a profile.
  let flag_first = ($profile | str starts-with "-")
  let rest = if $flag_first { [$profile] ++ $rest } else { $rest }
  let profile = if $flag_first { "" } else { $profile }
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
