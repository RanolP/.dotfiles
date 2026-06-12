$env.PATH = (
  $env.PATH
  | append "/opt/homebrew/bin"
  | append "/opt/homebrew/sbin"
  | prepend "/nix/var/nix/profiles/default/bin"
  | prepend "/etc/profiles/per-user/ranolp/bin"
  | prepend "/Users/ranolp/.local/share/mise/shims"
  | prepend "/Users/ranolp/.local/bin"
  | prepend "/Users/ranolp/Library/Android/sdk/platform-tools"
  | prepend "/Users/ranolp/Library/Android/sdk/emulator"
)
$env.ANDROID_HOME = "/Users/ranolp/Library/Android/sdk"
$env.GITHUB_TOKEN = (^/Users/ranolp/.local/share/mise/shims/gh auth token | str trim)

$env.DOCKER_HOST = $"unix://($env.HOME)/.colima/default/docker.sock"

$env.EDITOR = "nvim"
$env.VISUAL = "code --wait"
