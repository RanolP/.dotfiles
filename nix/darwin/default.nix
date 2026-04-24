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
    casks = [
      "claude"
      "firefox@developer-edition"
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
    auto-optimise-store = true;
  };

  # Primary user (required for homebrew, dock, finder, NSGlobalDomain options)
  system.primaryUser = "ranolp";

  # User definition (needed for home-manager homeDirectory derivation)
  users.users.ranolp = {
    name = "ranolp";
    home = "/Users/ranolp";
  };

  # Allow unfree packages
  nixpkgs.config.allowUnfree = true;

  system.stateVersion = 6;
}
