$env.PATH = (
  $env.PATH
  | prepend "/nix/var/nix/profiles/default/bin"
  | prepend $"($env.HOME)/.local/share/mise/shims"
  | prepend $"($env.HOME)/.local/bin"
)

$env.GITHUB_TOKEN = (try { ^gh auth token | str trim } catch { "" })
$env.EDITOR = "nvim"
$env.VISUAL = "code --wait"
