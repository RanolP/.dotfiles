source ~/.cache/nix-your-shell.nu

$env.config = ($env.config | upsert show_banner false)

# --- Per-folder terminal background (Ghostty / Windows Terminal, OSC 11) ---
# Tints the terminal background per project so it's obvious which repo you're in.
# Active in bare Ghostty and Windows Terminal; Zellij owns its own rendering, so it's skipped there.
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
  # `complete` captures stderr into the record so "fatal: not a git repository"
  # never leaks to the terminal when cd-ing into a non-repo.
  let res = (^git rev-parse --show-toplevel | complete)
  let root = (if $res.exit_code == 0 { $res.stdout | str trim } else { null })
  # Not inside a repo -> restore the default Nord background.
  if ($root | is-empty) { return "2e3440" }
  let hit = ($overrides | where path == $root)
  if ($hit | is-not-empty) { return ($hit | first | get color) }
  let idx = ($root | hash sha256 | str substring 0..7 | into int --radix 16) mod ($palette | length)
  $palette | get $idx
}

# Report WSL CWD to Windows Terminal so duplicate tabs/panes inherit it.
# WT >=1.22 no longer exports WT_SESSION, so detect it as "WSL, and no
# terminal that names itself via TERM_PROGRAM (ghostty/wezterm would
# misread OSC 9;9)".
def _windows-terminal-cwd []: nothing -> nothing {
  if ($env.WSL_DISTRO_NAME? | is-not-empty) and ($env.TERM_PROGRAM? | is-empty) {
    let cwd = (^wslpath -w $env.PWD | str trim)
    print -n $"(char -u '1b')]9;9;($cwd)(char -u '07')"
  }
}

$env.config.hooks.pre_prompt = (
  ($env.config.hooks?.pre_prompt? | default [])
  | append {|| _windows-terminal-cwd }
)

$env.config.hooks.env_change.PWD = (
  ($env.config.hooks?.env_change?.PWD? | default [])
  | append {|before, after|
      if (($env.TERM_PROGRAM? == "ghostty") or ($env.WSL_DISTRO_NAME? | is-not-empty)) and ($env.ZELLIJ? | is-empty) {
        print -n $"(char -u '1b')]11;#(_folder-bg-color)(char -u '07')"
      }
    }
)

# Launch Claude Code under a named auth profile.
# With no profile, prompt with a picker: (default) ~/.claude, any existing
# ~/.claude-<profile>, or create a new one. A chosen profile uses
# ~/.claude-<profile>, which mirrors ~/.claude's config but keeps its own
# auth token in that dir's .credentials.json. All profile-dir wiring (config
# symlinks, shared projects/) lives in the ~/.local/bin/claude wrapper
# (nix/home/darwin/default.nix), resolved fresh at every launch -- this
# function only picks the profile and sets CLAUDE_CONFIG_DIR.
def --wrapped ccc [
  profile: string = ""  # auth profile name; empty = pick interactively
  ...rest               # extra args and flags forwarded to claude
] {
  # A leading flag (ccc --chrome) is an arg for claude, not a profile.
  let flag_first = ($profile | str starts-with "-")
  let rest = if $flag_first { [$profile] ++ $rest } else { $rest }
  mut profile = if $flag_first { "" } else { $profile }

  # No profile named: pick one instead of silently using the default.
  if ($profile | is-empty) {
    let existing = (
      glob ($env.HOME | path join ".claude-*")
      | where ($it | path type) == "dir"
      | path basename
      | str replace ".claude-" ""
      | sort
    )
    let default_label = "(default)"
    let new_label = "+ new profile"
    let choice = ([$default_label] ++ $existing ++ [$new_label] | input list --fuzzy "Claude profile")
    if ($choice | is-empty) { return }  # Esc / no selection aborts
    $profile = if $choice == $default_label {
      ""
    } else if $choice == $new_label {
      let name = (input "New profile name: " | str trim)
      if ($name | is-empty) { return }
      $name
    } else {
      $choice
    }
  }

  if ($profile | is-empty) {
    ^claude ...$rest
  } else {
    with-env { CLAUDE_CONFIG_DIR: ($env.HOME | path join $".claude-($profile)") } { ^claude ...$rest }
  }
}
