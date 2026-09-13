{ pkgs, ... }:
{
  home.homeDirectory = "/home/ranolp";

  home.packages = with pkgs; [
    pinentry-curses

    # Claude Code's named auth profiles (~/.claude-<profile>, picked by
    # nushell's `ccc`) need their config mirrored from ~/.claude and their
    # projects/ pointed at the shared ~/.claude/projects, or /resume lists only
    # the running profile's sessions. macOS carries that in its
    # ~/.local/bin/claude wrapper; here the native installer owns that path and
    # rewrites it on every self-update, so the shim goes in ~/.nix-profile/bin,
    # which env.linux.nu prepends ahead of ~/.local/bin.
    (writeShellScriptBin "claude" ''
      real="$HOME/.local/bin/claude"
      if [ ! -x "$real" ]; then
        echo "claude: no native install at $real -- run the Claude Code installer" >&2
        exit 127
      fi
      . ${../configs/claude/profile-wiring.sh}
      exec "$real" "$@"
    '')
  ];

  home.file.".gnupg/gpg-agent.conf".onChange = "${pkgs.gnupg}/bin/gpgconf --kill gpg-agent";

  programs.nushell.shellAliases = {
    rebuild = "home-manager switch --flake /home/ranolp/.dotfiles/nix#ranolp-archwsl -b before-hm";
  };
}
