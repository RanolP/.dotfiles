$env.PATH = (
  $env.PATH
  | prepend $"($env.HOME)/.nix-profile/bin"
)
