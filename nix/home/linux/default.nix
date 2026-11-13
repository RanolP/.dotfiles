{ lib, pkgs, ... }:
{
  home.homeDirectory = "/home/ranolp";

  home.packages = with pkgs; [

    # Claude Code's named auth profiles (~/.claude-<profile>, picked by
    # nushell's `ccc`) need their config mirrored from ~/.claude and their
    # projects/ pointed at the shared store outside ~/.claude, or /resume
    # lists only the running profile's sessions. macOS carries that in its
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

  # A GUI prompt through WSLg, so a signed commit from an agent's non-TTY shell
  # can still ask for the passphrase. pinentry-qt falls back to curses when
  # there is no display. Arch has no fontconfig config nix's Qt can read
  # ("Fontconfig error: Cannot load default config file"), so the wrapper hands
  # it one with real fonts.
  home.file.".gnupg/gpg-agent.conf" = {
    source = lib.mkForce (
      pkgs.writeText "gpg-agent.conf" ''
        ${builtins.readFile ../configs/gnupg/gpg-agent.conf}
        pinentry-program ${pkgs.writeShellScript "pinentry-qt-fonts" ''
          export FONTCONFIG_FILE=${
            pkgs.makeFontsConf {
              fontDirectories = [
                pkgs.dejavu_fonts
                pkgs.noto-fonts-cjk-sans
              ];
            }
          }
          # WSLg hands Qt a 1x surface even on a 4K Windows display.
          export QT_SCALE_FACTOR=2
          exec ${pkgs.pinentry-qt}/bin/pinentry-qt "$@"
        ''}
      ''
    );
    onChange = "${pkgs.gnupg}/bin/gpgconf --kill gpg-agent";
  };

  # chsh needs root, which home-manager lacks, so WSL keeps bash as the login
  # shell and bash hands the top-level interactive session to nushell. A bash
  # started from inside nu (SHLVL > 1) or by Claude Code stays bash.
  home.file.".bash_profile".text = ''
    [[ -f ~/.profile ]] && . ~/.profile
    [[ -f ~/.bashrc ]] && . ~/.bashrc
  '';
  home.file.".bashrc".text = ''
    [[ $- != *i* ]] && return
    if [[ -z $CLAUDECODE && $SHLVL -le 1 && -t 0 && -x ~/.nix-profile/bin/nu ]]; then
      exec ~/.nix-profile/bin/nu --login
    fi
  '';

  programs.nushell.shellAliases = {
    rebuild = "home-manager switch --flake /home/ranolp/.dotfiles/nix#ranolp-archwsl -b before-hm";
  };
}
