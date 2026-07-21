{
  pkgs,
  lib,
  config,
  ...
}:
let
  typsi = pkgs.fetchFromGitHub {
    owner = "RanolP";
    repo = "typsi";
    rev = "b871faf98997bd0f49ef6170297ea0f34ea765d3";
    hash = "sha256-Ui8y3oo/rMEW8eWGzG+ecJSdmfDk9ipQ6qwGFkVY5qo=";
  };
  # Absolute path: sudo resets PATH, so bare `darwin-rebuild` isn't found.
  rebuildCmd = "sudo /run/current-system/sw/bin/darwin-rebuild switch --flake /Users/ranolp/.dotfiles/nix#ranolp-work-MBP-26";
in
{
  imports = [
    ./programs/firefox.nix
    ./programs/ghostty.nix
    ./programs/vscode.nix
    ./programs/zsh.nix
  ];

  home.homeDirectory = "/Users/ranolp";

  home.packages = with pkgs; [
    pinentry_mac
    pinentry-tty

    (import ./packages/xcodes.nix { inherit pkgs; })

    docker-compose

    # required by cocoapods
    gmp
    libyaml
  ];

  home.file.".docker/cli-plugins/docker-compose".source = "${pkgs.docker-compose}/bin/docker-compose";

  home.file.".config/karabiner/karabiner.json" = {
    force = true;
    source = ./configs/karabiner/karabiner.json;
  };

  home.file.".config/linearmouse/linearmouse.json".source = ./configs/linearmouse/linearmouse.json;

  home.file.".gnupg/gpg-agent.conf".onChange = "${pkgs.gnupg}/bin/gpgconf --kill gpg-agent";

  # Claude Code's Bash tool probes $SHELL/PATH for a zsh and picks the
  # nix-built one, which (when spawned as a session leader with piped stdio,
  # exactly how Claude Code spawns it) loses SIGCHLD during $(...) command
  # substitution and blocks forever in sigsuspend -- ~50% repro. Apple's
  # /bin/zsh is immune, reads the same ~/.zshenv//.zprofile, so force it via
  # $SHELL, which short-circuits Claude Code's shell probing. ~/.local/bin
  # precedes mise's claude on PATH, so this wrapper wins.
  home.file.".local/bin/claude" = {
    executable = true;
    text = ''
      #!/bin/sh
      SHELL=/bin/zsh exec "$HOME/.local/share/mise/shims/claude" "$@"
    '';
  };

  services.syncthing.enable = true;

  services.espanso = {
    enable = true;
    matches = {
      default.matches = [ ];
    };
  };

  # Use `daemon` instead of `launcher` so espanso doesn't self-register a second plist
  launchd.agents.espanso.config.ProgramArguments = lib.mkForce [
    "${pkgs.espanso}/Applications/Espanso.app/Contents/MacOS/espanso"
    "daemon"
  ];

  xdg.configFile."espanso/match/packages/typsi".source = "${typsi}/packages/typsi";

  # Dependabot-style weekly mise pin bumper. Fires daily at 10:30; a 7-day guard
  # inside the script gates real work to weekly (survives sleep/missed runs). No
  # RunAtLoad so it doesn't fire on every rebuild/login.
  launchd.agents.mise-bump = {
    enable = true;
    config = {
      ProgramArguments = [
        "${pkgs.python3}/bin/python3"
        "${../configs/mise/bump.py}"
      ];
      StartCalendarInterval = [
        {
          Hour = 10;
          Minute = 30;
        }
      ];
      EnvironmentVariables = {
        PATH = "${pkgs.mise}/bin:${pkgs.git}/bin:/usr/bin:/bin";
        HOME = config.home.homeDirectory;
      };
      StandardOutPath = "${config.home.homeDirectory}/.local/state/mise-bump/launchd.out.log";
      StandardErrorPath = "${config.home.homeDirectory}/.local/state/mise-bump/launchd.err.log";
    };
  };

  programs.nushell.shellAliases = {
    rebuild = rebuildCmd;
  };

  programs.zsh.shellAliases = {
    rebuild = rebuildCmd;
  };

  home.activation.androidSdk = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    (
      export PATH="/usr/bin:/bin:$PATH"
      export ANDROID_HOME="$HOME/Library/Android/sdk"
      export JAVA_HOME=$(/usr/libexec/java_home 2>/dev/null || echo "/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home")
      sdkmanager=/opt/homebrew/bin/sdkmanager
      if [ -x "$sdkmanager" ]; then
        yes | "$sdkmanager" --sdk_root="$ANDROID_HOME" --licenses > /dev/null 2>&1 || true
        "$sdkmanager" --sdk_root="$ANDROID_HOME" \
          "platform-tools" \
          "platforms;android-35" \
          "build-tools;35.0.0" \
          "emulator" \
          "system-images;android-35;google_apis;arm64-v8a"
      fi
    )
  '';
}
