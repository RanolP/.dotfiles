$env.PATH = (
  $env.PATH
  | prepend $"($env.HOME)/.nix-profile/bin"
)
$env.BROWSER = "wsl-open"
$env.AGENT_BROWSER_EXECUTABLE_PATH = $"($env.HOME)/.nix-profile/bin/google-chrome-stable"
