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
      "git-absorb"
      "git-filter-repo"
    ];
    casks = [
      "claude"
      "firefox@developer-edition"
      "ghostty"
      "raycast"
      "karabiner-elements"
      "linearmouse"
      "xcodes-app"
      "font-iosevka-nerd-font"
    ];
  };

  # macOS system defaults
  system.defaults = {
    dock = {
      autohide = true;
      show-recents = false;
      # hot corner: bottom-left → lock screen (modifier set via activation script)
      wvous-bl-corner = 13;
    };
    finder = {
      AppleShowAllExtensions = true;
      FXPreferredViewStyle = "clmv";
      ShowPathbar = true;
    };
    NSGlobalDomain = {
      AppleInterfaceStyle = "Dark";
      KeyRepeat = 2;
      InitialKeyRepeat = 15;
      ApplePressAndHoldEnabled = false; # key repeat instead of accent popup
    };
    trackpad = {
      TrackpadThreeFingerDrag = true;
    };
    controlcenter.Bluetooth = false;
  };

  # Extra tweaks not covered by nix-darwin options (runs as root, sudo -u for user prefs)
  system.activationScripts.extraActivation.text = ''
    sudo -u ranolp defaults write com.apple.dock wvous-bl-modifier -int 1048576
    sudo -u ranolp defaults write com.apple.Spotlight "NSStatusItem Visible Item-0" -bool false
    sudo -u ranolp defaults write com.apple.AppleMultitouchTrackpad TrackpadThreeFingerDrag -bool true
    sudo -u ranolp defaults write com.apple.driver.AppleBluetoothMultitouch.trackpad TrackpadThreeFingerDrag -bool true

    # Symbolic hotkeys: F18 → 한영 (ID 60), Spotlight Cmd+Space 비활성화 (ID 64)
    sudo -u ranolp python3 - <<'EOF'
import plistlib
path = '/Users/ranolp/Library/Preferences/com.apple.symbolichotkeys.plist'
with open(path, 'rb') as f:
    p = plistlib.load(f)
h = p.setdefault('AppleSymbolicHotKeys', {})
h['60'] = {'enabled': True,  'value': {'parameters': [65535, 79, 0], 'type': 'standard'}}
h['64'] = {'enabled': False, 'value': {'parameters': [65535, 49, 1048576], 'type': 'standard'}}
with open(path, 'wb') as f:
    plistlib.dump(p, f)
EOF
    /System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings -u
  '';

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

  # direnv 테스트가 macOS Nix 샌드박스에서 hang함
  # 원인: FSEvents/임시 디렉토리/프로세스 스폰이 샌드박스에서 차단됨
  # 이벤트를 영원히 기다리며 빌드가 멈춤. upstream fix 없음, doCheck=false가 공식 workaround
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
