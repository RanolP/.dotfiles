{ pkgs, ... }:
{
  home.homeDirectory = "/home/ranolp";

  home.packages = with pkgs; [
    pinentry-curses

    # Claude Code's named auth profiles (~/.claude-<profile>, picked by
    # nushell's `ccc`) need their config mirrored from ~/.claude and their
    # projects/ pointed at the shared ~/.claude/projects, or /resume lists only
    # the running profile's sessions. macOS carries that in its
    # ~/.local/bin/claude wrapper; here the shim goes in ~/.nix-profile/bin,
    # which env.linux.nu prepends ahead of everything else.
    #
    # It execs mise's pinned build, never ~/.local/bin/claude: that path belongs
    # to the native installer, which rewrites it on every self-update and so
    # sets the version outside any declaration. mise-global.toml is the single
    # place a claude version changes here (2.1.278 ran while the pin said
    # 2.1.280, 2026-09-26).
    (writeShellScriptBin "claude" ''
      real="$HOME/.local/share/mise/shims/claude"
      if [ ! -x "$real" ]; then
        echo "claude: no mise shim at $real -- run 'mise install' (pin: nix/home/mise-global.toml)" >&2
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
