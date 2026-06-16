{ pkgs, ... }:
{
  home.homeDirectory = "/home/ranolp";

  home.packages = with pkgs; [
    pinentry-curses
  ];

  home.file.".gnupg/gpg-agent.conf".onChange = "${pkgs.gnupg}/bin/gpgconf --kill gpg-agent";

  programs.nushell.shellAliases = {
    rebuild = "home-manager switch --flake /home/ranolp/.dotfiles/nix#ranolp-archwsl -b before-hm";
  };
}
