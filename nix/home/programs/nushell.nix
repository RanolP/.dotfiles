{ pkgs, lib, ... }:
{
  programs.nushell = {
    enable = true;
    extraEnv =
      builtins.readFile ../configs/nushell/env.common.nu
      + lib.optionalString pkgs.stdenv.isDarwin (builtins.readFile ../configs/nushell/env.darwin.nu)
      + lib.optionalString pkgs.stdenv.isLinux (builtins.readFile ../configs/nushell/env.linux.nu);
    extraConfig = builtins.readFile ../configs/nushell/config.nu;
    shellAliases = import ./aliases.nix;
  };
}
