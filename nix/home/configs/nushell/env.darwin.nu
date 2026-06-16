$env.PATH = (
  $env.PATH
  | append "/opt/homebrew/bin"
  | append "/opt/homebrew/sbin"
  | prepend "/etc/profiles/per-user/ranolp/bin"
  | prepend "/Users/ranolp/Library/Android/sdk/platform-tools"
  | prepend "/Users/ranolp/Library/Android/sdk/emulator"
)

$env.ANDROID_HOME = "/Users/ranolp/Library/Android/sdk"
$env.DOCKER_HOST = $"unix://($env.HOME)/.colima/default/docker.sock"
