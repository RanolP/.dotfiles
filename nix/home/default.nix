{ pkgs, lib, ... }:
let
  # Copy local.nix.example → local.nix and fill in secrets (gpg signing key, etc.)
  # local.nix is gitignored.
  hasLocal = builtins.pathExists ./local.nix;
  local = if hasLocal then import ./local.nix else { };
in
{
  imports = [
    ./programs/firefox.nix
    ./programs/nushell.nix
    ./programs/starship.nix
    ./programs/zsh.nix
    ./programs/vscode.nix
    ./programs/git.nix
    ./programs/zellij.nix
  ];

  home.username = "ranolp";
  home.homeDirectory = "/Users/ranolp";
  home.stateVersion = "24.11";

  home.packages = with pkgs; [
    # crypto / gpg
    gnupg
    pinentry_mac
    pinentry-tty

    # nix shell integration for nushell
    nix-your-shell

    # xcodes CLI (prebuilt — brew formula builds from source, needs xcbuild = Xcode 닭달걀 문제)
    (import ./packages/xcodes.nix { inherit pkgs; })
  ];

  # mise is managed by homebrew — only write the config file
  home.file.".config/mise/config.toml".source = ./configs/mise/config.toml;

  home.file.".config/karabiner/karabiner.json" = {
    force = true;
    source = ./configs/karabiner/karabiner.json;
  };

  home.file.".claude/CLAUDE.md".source = ./configs/claude/CLAUDE.md;
  home.file.".claude/commands/handoff.md".source = ./configs/claude/commands/handoff.md;
  home.file.".claude/commands/decompose.md".source = ./configs/claude/commands/decompose.md;
  home.file.".claude/commands/one-domain.md".source = ./configs/claude/commands/one-domain.md;
  home.file.".claude/settings.json".source = ./configs/claude/settings.json;

  home.file.".config/ghostty/config".source = ./configs/ghostty/config;
  home.file.".gnupg/gpg-agent.conf" = {
    source = ./configs/gnupg/gpg-agent.conf;
    onChange = "/etc/profiles/per-user/ranolp/bin/gpgconf --kill gpg-agent";
  };
  home.file.".config/linearmouse/linearmouse.json".source = ./configs/linearmouse/linearmouse.json;

  services.syncthing.enable = true;

  home.activation.miseInstall = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:$PATH"
    /opt/homebrew/bin/mise install --quiet
  '';

  home.activation.nixYourShellCache = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    mkdir -p "$HOME/.cache"
    /etc/profiles/per-user/ranolp/bin/nix-your-shell nu > "$HOME/.cache/nix-your-shell.nu" 2>/dev/null || touch "$HOME/.cache/nix-your-shell.nu"
  '';

  home.activation.androidSdk = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
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
  '';
}
