{ ... }:
{
  programs.nushell = {
    enable = true;
    extraConfig = builtins.readFile ../configs/nushell/config.nu;
    shellAliases = import ./aliases.nix;
  };
}
