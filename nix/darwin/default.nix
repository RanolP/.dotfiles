{ pkgs, ... }: {
  # Touch ID for sudo
  security.pam.services.sudo_local.touchIdAuth = true;

  # Homebrew — GUI apps only (CLI tools go through nix)
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      cleanup = "zap";
    };
    brews = [
      "mise"
      "paneru"
    ];
    casks = [
      "claude"
      "firefox@developer-edition"
      "ghostty"
      "raycast"
      "karabiner-elements"
      "shottr"
      "linearmouse"
      "xcodes"
    ];
  };

  # macOS system defaults
  system.defaults = {
    dock = {
      autohide = true;
      show-recents = false;
    };
    finder = {
      AppleShowAllExtensions = true;
      FXPreferredViewStyle = "clmv"; # column view
      ShowPathbar = true;
    };
    NSGlobalDomain = {
      AppleInterfaceStyle = "Dark";
      KeyRepeat = 2;
      InitialKeyRepeat = 15;
    };
  };

  # Nix settings
  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
  };

  # Primary user (required for homebrew, dock, finder, NSGlobalDomain options)
  system.primaryUser = "ranolp";

  # User definition (needed for home-manager homeDirectory derivation)
  users.users.ranolp = {
    name = "ranolp";
    home = "/Users/ranolp";
    shell = pkgs.nushell;
  };

  # Allow unfree packages
  nixpkgs.config.allowUnfree = true;

  # Skip direnv tests (hangs on macOS)
  nixpkgs.overlays = [
    (final: prev: {
      direnv = prev.direnv.overrideAttrs (_: { doCheck = false; });
    })
  ];

  nix.optimise.automatic = true;

  # Disable compinit + bashcompinit in /etc/zshrc — slow with nix store paths
  programs.zsh = {
    enable = true;
    enableCompletion = false;
    enableBashCompletion = false;
  };

  system.stateVersion = 6;
}
