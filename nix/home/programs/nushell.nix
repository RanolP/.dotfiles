{ ... }:
{
  programs.nushell = {
    enable = true;
    extraConfig = builtins.readFile ../configs/nushell/config.nu;
    shellAliases = {
      rebuild = "sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26";
      cat = "bat";
      ls = "eza --icons=auto --git --group-directories-first --header --time-style=relative";
    };
  };
}
