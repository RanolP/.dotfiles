def --wrapped claude [...args] {
  if ($env | get -o ZELLIJ | is-empty) {
    let layout = if ($args | is-empty) {
      'layout { pane command="claude" close_on_exit=true; }'
    } else {
      let args_kdl = ($args | each { |a| $"\"($a)\"" } | str join " ")
      $"layout { pane command=\"claude\" close_on_exit=true { args ($args_kdl) } }"
    }
    ^zellij --layout-string $layout
  } else {
    ^claude ...$args
  }
}

$env.PATH = (
  $env.PATH
  | prepend "/nix/var/nix/profiles/default/bin"
  | prepend "/etc/profiles/per-user/ranolp/bin"
  | prepend "/Users/ranolp/.local/share/mise/shims"
  | prepend "/Users/ranolp/.local/bin"
  | prepend "/Users/ranolp/Library/Android/sdk/platform-tools"
  | prepend "/Users/ranolp/Library/Android/sdk/emulator"
)
$env.ANDROID_HOME = "/Users/ranolp/Library/Android/sdk"
$env.GITHUB_TOKEN = (^/Users/ranolp/.local/share/mise/shims/gh auth token | str trim)

# nix-your-shell: nix develop / nix-shell -> nushell
source ~/.cache/nix-your-shell.nu

# banner off (after starship sets render_right_prompt_on_last_line)
$env.config = ($env.config | upsert show_banner false)
