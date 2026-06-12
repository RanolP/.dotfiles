{ ... }:
{
  programs.nushell = {
    enable = true;
    extraEnv = builtins.readFile ../configs/nushell/env.nu;
    extraConfig = builtins.readFile ../configs/nushell/config.nu;
    shellAliases = import ./aliases.nix;
  };
}
