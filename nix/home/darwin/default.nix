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

  # espanso ships its macOS build as an APFS .dmg nested inside a release .zip.
  # nixpkgs only source-builds it on darwin (GOLDEN RULE: never compile), the
  # Homebrew cask's nested-dmg unpack is broken under nix-homebrew (Homebrew
  # 5.1.7), and unpacking the app with 7zz breaks its code signature ("Espanso
  # is damaged"). So: fetch the release, keep the *intact* nested dmg here (pure
  # download, no build), then mount + ditto the notarized app into place at
  # activation (see home.activation.espanso below) -- exactly what the cask
  # does, preserving the developer signature. Bump `version`/`hash` together.
  espansoApp = "${config.home.homeDirectory}/Applications/Espanso.app";
  espansoDmg = pkgs.stdenvNoCC.mkDerivation {
    pname = "espanso-dmg";
    version = "2.3.0";
    src = pkgs.fetchurl {
      url = "https://github.com/espanso/espanso/releases/download/v2.3.0/Espanso-Mac-Universal.zip";
      hash = "sha256-54VUO8N+mGBDTi4AzMGKXfdAmrmyDR9Bv8SAG15UPq4=";
    };
    nativeBuildInputs = [ pkgs.unzip ];
    dontConfigure = true;
    dontBuild = true;
    unpackPhase = ''unzip -q "$src"'';
    installPhase = ''install -Dm444 espanso/Espanso.dmg "$out/Espanso.dmg"'';
  };
  # Orca (onorca.dev) Agent IDE: no Homebrew cask and not in nixpkgs, so fetch
  # the notarized release dmg (pure download, GOLDEN RULE) and mount + ditto it
  # into ~/Applications at activation, same as espanso. Bump url/hash together.
  orcaApp = "${config.home.homeDirectory}/Applications/Orca.app";
  orcaDmg = pkgs.fetchurl {
    url = "https://github.com/stablyai/orca/releases/download/v1.4.150/orca-macos-arm64.dmg";
    hash = "sha256-s5eJFMv6fdPam29rt1aixbmZI9yXaA5F9HyiGirqum4=";
  };
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
  # The wrapper also wires named auth profiles (~/.claude-<profile>): shell
  # functions like nushell's `ccc` are baked into running shells at startup
  # and go stale after a rebuild, so the wiring lives here, resolved fresh at
  # every launch. `ccc` only picks the profile and sets CLAUDE_CONFIG_DIR.
  home.file.".local/bin/claude" = {
    executable = true;
    text = ''
      #!/bin/sh
      case "$CLAUDE_CONFIG_DIR" in
        "$HOME/.claude-"*)
          base="$HOME/.claude"
          dir="$CLAUDE_CONFIG_DIR"
          mkdir -p "$dir"
          # Config mirrors ~/.claude so nix updates track; runtime state and
          # the auth token stay per-profile in $dir.
          for entry in settings.json CLAUDE.md agents skills plugins; do
            [ -e "$base/$entry" ] && ln -sfn "$base/$entry" "$dir/$entry"
          done
          # Sessions live in projects/; symlinking it into ~/.claude/projects
          # makes /resume see every profile's sessions. If a real dir ever
          # lands here, ln fails loudly instead of hiding data.
          mkdir -p "$base/projects"
          ln -sfn "$base/projects" "$dir/projects"
          ;;
      esac
      SHELL=/bin/zsh exec "$HOME/.local/share/mise/shims/claude" "$@"
    '';
  };

  services.syncthing.enable = true;

  services.espanso = {
    enable = true;
    # The real binary is the notarized app ditto'd into ~/Applications at
    # activation (below). This stub just points the HM module + PATH at it;
    # it's pure symlinks (instant, no build). `version` satisfies the module.
    package = pkgs.runCommand "espanso-2.3.0" { version = "2.3.0"; } ''
      mkdir -p "$out/bin" "$out/Applications"
      ln -s "${espansoApp}" "$out/Applications/Espanso.app"
      ln -s "${espansoApp}/Contents/MacOS/espanso" "$out/bin/espanso"
    '';
    matches = {
      default.matches = [ ];
    };
  };

  # Install the notarized app from the intact dmg, preserving its signature
  # (7zz/unzip extraction corrupts the seal; hdiutil+ditto does not). Idempotent:
  # only re-mounts when the source dmg store path changes.
  home.activation.espanso = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    dmg="${espansoDmg}/Espanso.dmg"
    stamp="${config.home.homeDirectory}/Applications/.espanso-dmg-source"
    if [ ! -d "${espansoApp}" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$dmg" ]; then
      $DRY_RUN_CMD mkdir -p "${config.home.homeDirectory}/Applications"
      mnt="$($DRY_RUN_CMD mktemp -d)"
      $DRY_RUN_CMD /usr/bin/hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mnt"
      $DRY_RUN_CMD rm -rf "${espansoApp}"
      $DRY_RUN_CMD /usr/bin/ditto "$mnt/Espanso.app" "${espansoApp}"
      $DRY_RUN_CMD /usr/bin/hdiutil detach "$mnt"
      $DRY_RUN_CMD sh -c "printf '%s' '$dmg' > '$stamp'"
    fi
  '';

  # Same mount + ditto install as espanso above: preserves the notarized
  # signature and only re-runs when the pinned dmg store path changes (an
  # in-app auto-update is left alone until the pin bumps).
  home.activation.orca = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    dmg="${orcaDmg}"
    stamp="${config.home.homeDirectory}/Applications/.orca-dmg-source"
    if [ ! -d "${orcaApp}" ] || [ "$(cat "$stamp" 2>/dev/null)" != "$dmg" ]; then
      $DRY_RUN_CMD mkdir -p "${config.home.homeDirectory}/Applications"
      mnt="$($DRY_RUN_CMD mktemp -d)"
      $DRY_RUN_CMD /usr/bin/hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$mnt"
      $DRY_RUN_CMD rm -rf "${orcaApp}"
      $DRY_RUN_CMD /usr/bin/ditto "$mnt/Orca.app" "${orcaApp}"
      $DRY_RUN_CMD /usr/bin/hdiutil detach "$mnt"
      $DRY_RUN_CMD sh -c "printf '%s' '$dmg' > '$stamp'"
    fi
  '';

  # Use `daemon` instead of `launcher` so espanso doesn't self-register a second plist
  launchd.agents.espanso.config.ProgramArguments = lib.mkForce [
    "${espansoApp}/Contents/MacOS/espanso"
    "daemon"
  ];

  xdg.configFile."espanso/match/packages/typsi".source = "${typsi}/packages/typsi";

  # GUI apps inherit $SHELL from the login shell, which is deliberately /bin/sh
  # (the Claude Code hang guard in nix/darwin/default.nix) -- so Orca, whose
  # macOS terminals spawn `$SHELL || /bin/zsh` with no shell setting of its own,
  # opened bare sh. Set the GUI session's SHELL to Apple's zsh at login: Orca
  # fully supports zsh (shell-ready markers, env scan), /bin/zsh is immune to
  # the nix-zsh SIGCHLD hang, and the ~/.local/bin/claude wrapper already pins
  # the same value. Login shell itself stays /bin/sh.
  launchd.agents.gui-shell = {
    enable = true;
    config = {
      ProgramArguments = [
        "/bin/launchctl"
        "setenv"
        "SHELL"
        "/bin/zsh"
      ];
      RunAtLoad = true;
    };
  };

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
