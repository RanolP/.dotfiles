$env.PATH = (
  $env.PATH
  | prepend $"($env.HOME)/.nix-profile/bin"
)
$env.BROWSER = "wsl-open"
