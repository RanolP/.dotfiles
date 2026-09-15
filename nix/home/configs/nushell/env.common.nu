$env.PATH = (
  $env.PATH
  | prepend "/nix/var/nix/profiles/default/bin"
  | prepend $"($env.HOME)/.local/share/mise/shims"
  | prepend $"($env.HOME)/.local/bin"
)

# gh returns $env.GITHUB_TOKEN verbatim when it is already set, so reading it back into
# itself copies a stale token forever. Clear it for the read so gh falls through to the keyring.
$env.GITHUB_TOKEN = (with-env {GITHUB_TOKEN: null} { try { ^gh auth token | str trim } catch { "" } })
# Claude Code's autoupdater would `npm install --global @anthropic-ai/claude-code`
# every 30 minutes, and mise puts node/<ver>/bin ahead of mise/shims, so that copy
# shadows the pinned aqua build. The pin in mise-global.toml is the only source of
# the version. Mirrors the same export in zsh's .zshenv.
$env.DISABLE_AUTOUPDATER = "1"
$env.EDITOR = "nvim"
$env.VISUAL = "code --wait"
