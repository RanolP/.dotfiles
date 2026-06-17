{ pkgs, lib, ... }:
let
  typsi = pkgs.fetchFromGitHub {
    owner = "RanolP";
    repo = "typsi";
    rev = "b871faf98997bd0f49ef6170297ea0f34ea765d3";
    hash = "sha256-Ui8y3oo/rMEW8eWGzG+ecJSdmfDk9ipQ6qwGFkVY5qo=";
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

  home.file.".gnupg/gpg-agent.conf".onChange =
    "/etc/profiles/per-user/ranolp/bin/gpgconf --kill gpg-agent";

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

  programs.nushell.shellAliases = {
    rebuild = "sudo darwin-rebuild switch --flake /Users/ranolp/.dotfiles/nix#ranolp-work-MBP-26";
  };

  programs.zsh.shellAliases = {
    rebuild = "sudo darwin-rebuild switch --flake /Users/ranolp/.dotfiles/nix#ranolp-work-MBP-26";
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
          "emulator"
      fi
    )
  '';
}
