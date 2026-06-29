{ pkgs, ... }:
let
  hostName = "ranolp-work-MBP-26";

  # Casks installed only on a specific machine. Git-managed, but scoped by
  # hostname so other Macs don't get them and re-imaging a host restores them.
  # Add a new hostname key when onboarding another Mac.
  casksByHost = {
    "ranolp-work-MBP-26" = [
      "displaylink" # external displays via USB-C dock
      "obs" # screen recording / streaming
      "steam" # games
      "tailscale-app" # tailnet VPN
    ];
  };
in
{
  # Touch ID for sudo
  security.pam.services.sudo_local.touchIdAuth = true;

  # Homebrew — GUI apps only (CLI tools go through nix)
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = false;
      cleanup = "zap";
    };
    brews = [
      "git-absorb"
      "git-filter-repo"
      "mdbook"
      "libmagic" # libmagic dylib for python-magic (reuse tool, via mise pipx)
    ];
    casks = [
      "claude"
      "ghostty"
      "raycast"
      "karabiner-elements"
      "linearmouse"
      "font-iosevka-nerd-font"
      "font-pretendard"
      "discord"
      "bitwarden"
      "figma"
      "slack"
      "android-commandlinetools"
      "temurin"
      "google-chrome"
      "notion"
      "keybase"
      "shottr"
    ]
    ++ (casksByHost.${hostName} or [ ]);
  };

  # macOS system defaults
  system.defaults = {
    dock = {
      autohide = true;
      show-recents = false;
      # hot corner: bottom-left → lock screen (modifier set via activation script)
      wvous-bl-corner = 13;
      persistent-apps = [ ];
    };
    finder = {
      AppleShowAllExtensions = true;
      AppleShowAllFiles = true;
      FXPreferredViewStyle = "clmv";
      ShowPathbar = true;
    };
    NSGlobalDomain = {
      AppleInterfaceStyle = "Dark";
      KeyRepeat = 2;
      InitialKeyRepeat = 15;
      ApplePressAndHoldEnabled = false; # key repeat instead of accent popup
      "com.apple.keyboard.fnState" = true; # F1~Fn 우선 사용
    };
    trackpad = {
      Clicking = true;
      TrackpadThreeFingerDrag = true;
    };
    NSGlobalDomain."com.apple.mouse.tapBehavior" = 1;
    controlcenter.Bluetooth = false;
  };

  # Extra tweaks not covered by nix-darwin options (runs as root, sudo -u for user prefs)
  system.activationScripts.extraActivation.text = ''
        # Chrome enterprise policy — declarative extension management
        mkdir -p /Library/Google/Chrome/policies/managed
        cat > /Library/Google/Chrome/policies/managed/extensions.json << 'CHROMEPOLICY'
    {"ExtensionInstallForcelist":["fcoeoabgfenejglbffodgkkbkcdhcgfn;https://clients2.google.com/service/update2/crx"]}
    CHROMEPOLICY
        chmod 644 /Library/Google/Chrome/policies/managed/extensions.json

        # Firefox: symlink to ~/Applications so macOS privacy dialogs can find it
        mkdir -p /Users/ranolp/Applications
        firefox_app=$(find /nix/store -maxdepth 4 -name "Firefox Developer Edition.app" -path "*/firefox-devedition-*/Applications/*" 2>/dev/null | head -1)
        if [ -n "$firefox_app" ]; then
          ln -sfn "$firefox_app" "/Users/ranolp/Applications/Firefox Developer Edition.app"
        fi

        xcode=$(find /Applications -maxdepth 1 -name 'Xcode*.app' -type d 2>/dev/null | sort -V | tail -1)
        if [ -n "$xcode" ]; then xcode-select -s "$xcode/Contents/Developer"; fi
        sudo -u ranolp defaults write com.apple.dock wvous-bl-modifier -int 1048576
        sudo -u ranolp defaults write com.apple.Spotlight "NSStatusItem Visible Item-0" -bool false
        sudo -u ranolp defaults write com.apple.AppleMultitouchTrackpad TrackpadThreeFingerDrag -bool true
        sudo -u ranolp defaults write com.apple.driver.AppleBluetoothMultitouch.trackpad TrackpadThreeFingerDrag -bool true
        sudo -u ranolp defaults write com.apple.AppleMultitouchTrackpad Dragging -bool true
        sudo -u ranolp defaults write com.apple.driver.AppleBluetoothMultitouch.trackpad Dragging -bool true
        sudo -u ranolp defaults write com.apple.HIToolbox TISRomanSwitchState -int 0
        # Liquid Glass 비활성화 (SwiftUI layer, macOS 26 Tahoe)
        # FeatureFlags plist approach caused fully transparent UI on 26.4+; use per-user SwiftUI default instead
        sudo -u ranolp defaults write -g com.apple.SwiftUI.DisableSolarium -bool YES
        # Remove old FeatureFlags plists that caused transparent UI corruption
        rm -f /Library/Preferences/FeatureFlags/Domain/SwiftUI.plist
        rm -f /Library/Preferences/FeatureFlags/Domain/IconServices.plist

        # Symbolic hotkeys: F18 → 한영 (ID 60), Spotlight Cmd+Space 비활성화 (ID 64),
        # Screenshot toolbar Cmd+Shift+S (ID 184, replaces default Cmd+Shift+5)
        sudo -u ranolp python3 - <<'EOF'
    import plistlib
    path = '/Users/ranolp/Library/Preferences/com.apple.symbolichotkeys.plist'
    with open(path, 'rb') as f:
        p = plistlib.load(f)
    h = p.setdefault('AppleSymbolicHotKeys', {})
    h['60']  = {'enabled': True,  'value': {'parameters': [65535, 79, 0],       'type': 'standard'}}
    h['64']  = {'enabled': False, 'value': {'parameters': [65535, 49, 1048576], 'type': 'standard'}}
    h['184'] = {'enabled': True,  'value': {'parameters': [115, 1, 1179648],    'type': 'standard'}}
    with open(path, 'wb') as f:
        plistlib.dump(p, f)
    EOF
        /System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings -u

        # sdkmanager uses bare 'awk' which isn't in PATH during nix-darwin activation;
        # patch to absolute path — idempotent, re-applied after each brew upgrade
        sdkmanager_real=$(readlink -f /opt/homebrew/bin/sdkmanager 2>/dev/null || true)
        if [ -f "$sdkmanager_real" ] && grep -q ' awk ' "$sdkmanager_real"; then
          sed -i ''' 's| awk | /usr/bin/awk |g' "$sdkmanager_real"
        fi
  '';

  # Nix settings
  nix.settings = {
    experimental-features = [
      "nix-command"
      "flakes"
    ];
  };

  # Primary user (required for homebrew, dock, finder, NSGlobalDomain options)
  system.primaryUser = "ranolp";

  networking.hostName = hostName;
  networking.localHostName = hostName;

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
      direnv = prev.direnv.overrideAttrs (_: {
        doCheck = false;
      });
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
