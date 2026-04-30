{ pkgs, lib, ... }:
let
  # Copy local.nix.example → local.nix and fill in secrets (gpg signing key, etc.)
  # local.nix is gitignored.
  hasLocal = builtins.pathExists ./local.nix;
  local = if hasLocal then import ./local.nix else {};
in {
  home.username = "ranolp";
  home.homeDirectory = "/Users/ranolp";
  home.stateVersion = "24.11";

  home.packages = with pkgs; [
    # crypto / gpg
    gnupg
    pinentry_mac

    # nix shell integration for nushell
    nix-your-shell

    # xcodes CLI (prebuilt — brew formula builds from source, needs xcbuild = Xcode 닭달걀 문제)
    (import ./xcodes.nix { inherit pkgs; })
  ];

# mise is managed by homebrew — only write the config file
  home.file.".config/mise/config.toml".text = ''
    [settings]
    experimental = true

    [tools]
    node = "lts"
    python = "latest"
    fzf = "latest"
    bat = "latest"
    eza = "latest"
    ripgrep = "latest"
    fd = "latest"
    jq = "latest"
    vim = "latest"
    tmux = "latest"
    gh = "latest"
    "npm:@anthropic-ai/claude-code" = "latest"
  '';

  # karabiner.json — fully declarative
  # keyboard_type + keyboard_type_v2 둘 다 있어야 마법사 안 뜸
  home.file.".config/karabiner/karabiner.json" = {
    force = true;
    text = builtins.toJSON {
      global = {
        ask_for_confirmation_before_quitting = true;
        check_for_updates_at_startup = true;
        show_in_menu_bar = true;
        show_profile_name_in_menu_bar = false;
        unsafe_ui = false;
      };
      profiles = [{
        name = "Default profile";
        selected = true;
        simple_modifications = [];
        devices = [{
          identifiers = {
            vendor_id = 9741;
            product_id = 48;
            is_keyboard = true;
            is_pointing_device = true;
          };
          ignore = false;
        }];
        fn_function_keys = [];
        parameters.delay_milliseconds_before_open_device = 1000;
        virtual_hid_keyboard = {
          country_code = 0;
          indicate_sticky_modifier_keys_state = true;
          keyboard_type = "ansi";
          keyboard_type_v2 = "ansi";
          mouse_key_xy_scale = 100;
        };
        complex_modifications = {
          parameters = {
            "basic.simultaneous_threshold_milliseconds" = 50;
            "basic.to_delayed_action_delay_milliseconds" = 500;
            "basic.to_if_alone_timeout_milliseconds" = 1000;
            "basic.to_if_held_down_threshold_milliseconds" = 500;
            "mouse_motion_to_scroll.speed" = 100;
          };
          rules = [
            {
              description = "MacBook internal keyboard: Windows-style layout";
              manipulators = [
                { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ is_built_in_keyboard = true; }]; }]; from.key_code = "fn";            to = [{ key_code = "left_command"; }]; }
                { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ is_built_in_keyboard = true; }]; }]; from.key_code = "left_control";  to = [{ key_code = "fn";           }]; }
                { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ is_built_in_keyboard = true; }]; }]; from.key_code = "left_command";  to = [{ key_code = "left_control"; }]; }
                { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ is_built_in_keyboard = true; }]; }]; from.key_code = "right_command"; to = [{ key_code = "f18"; }]; }
              ];
            }
            {
              description = "Dareu Z82: swap lctrl <-> lcmd, ropt to F18";
              manipulators = [
                { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ vendor_id = 9741; product_id = 48; }]; }]; from.key_code = "left_control"; to = [{ key_code = "left_command"; }]; }
                { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ vendor_id = 9741; product_id = 48; }]; }]; from.key_code = "left_command"; to = [{ key_code = "left_control"; }]; }
                { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ vendor_id = 9741; product_id = 48; }]; }]; from.key_code = "right_option"; to = [{ key_code = "f18";          }]; }
              ];
            }
          ];
        };
      }];
    };
  };

  home.file.".config/ghostty/config".text = ''
    theme = Nord
    font-family = Iosevka Nerd Font Mono
    command = /run/current-system/sw/bin/nu
  '';

  home.file.".yabairc" = {
    executable = true;
    text = ''
      #!/usr/bin/env sh

      yabai -m config layout bsp

      # Gaps
      yabai -m config top_padding    8
      yabai -m config bottom_padding 8
      yabai -m config left_padding   8
      yabai -m config right_padding  8
      yabai -m config window_gap     8

      # Mouse
      yabai -m config mouse_follows_focus on
      yabai -m config focus_follows_mouse autoraise
      yabai -m config mouse_modifier       alt
      yabai -m config mouse_action1        move
      yabai -m config mouse_action2        resize

      # Window appearance
      yabai -m config window_shadow off
      yabai -m config window_opacity off

      # Split ratios
      yabai -m config split_ratio 0.5
      yabai -m config auto_balance off

      # Ignore apps that don't tile well
      yabai -m rule --add app="^System Settings$"  manage=off
      yabai -m rule --add app="^Calculator$"        manage=off
      yabai -m rule --add app="^Finder$"            manage=off
      yabai -m rule --add app="^Raycast$"           manage=off
      yabai -m rule --add app="^Bitwarden$"         manage=off
    '';
  };

  home.file.".config/skhd/skhdrc".text = ''
    # Focus window
    alt - h : yabai -m window --focus west
    alt - j : yabai -m window --focus south
    alt - k : yabai -m window --focus north
    alt - l : yabai -m window --focus east

    # Swap window
    shift + alt - h : yabai -m window --swap west
    shift + alt - j : yabai -m window --swap south
    shift + alt - k : yabai -m window --swap north
    shift + alt - l : yabai -m window --swap east

    # Move window to another display
    shift + alt - 1 : yabai -m window --display 1 && yabai -m display --focus 1
    shift + alt - 2 : yabai -m window --display 2 && yabai -m display --focus 2
    shift + alt - 3 : yabai -m window --display 3 && yabai -m display --focus 3

    # Resize window
    ctrl + alt - h : yabai -m window --resize left:-40:0
    ctrl + alt - j : yabai -m window --resize bottom:0:40
    ctrl + alt - k : yabai -m window --resize top:0:-40
    ctrl + alt - l : yabai -m window --resize right:40:0

    # Float / fullscreen
    alt - f : yabai -m window --toggle zoom-fullscreen
    alt - t : yabai -m window --toggle float; yabai -m window --grid 4:4:1:1:2:2

    # Rotate layout
    alt - r : yabai -m space --rotate 90

    # Open Ghostty
    alt - return : open -n /Applications/Ghostty.app
  '';


  home.activation.miseInstall = lib.hm.dag.entryAfter ["writeBoundary"] ''
    export PATH="$HOME/.local/share/mise/shims:/opt/homebrew/bin:$PATH"
    /opt/homebrew/bin/mise install --quiet
  '';

  home.activation.nixYourShellCache = lib.hm.dag.entryAfter ["writeBoundary"] ''
    mkdir -p "$HOME/.cache"
    /etc/profiles/per-user/ranolp/bin/nix-your-shell nu > "$HOME/.cache/nix-your-shell.nu" 2>/dev/null || touch "$HOME/.cache/nix-your-shell.nu"
  '';

  home.activation.androidSdk = lib.hm.dag.entryAfter ["writeBoundary"] ''
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


  programs.firefox = {
    enable = true;
    package = pkgs.firefox-devedition;
    profiles.dev-edition-default = {
      id = 0;
      isDefault = true;
      extensions.packages = let
        addons = pkgs.nur.repos.rycee.firefox-addons;
      in [
        addons.bitwarden
        addons.ublock-origin
        addons.darkreader
        addons.tampermonkey
        (addons.buildFirefoxXpiAddon {
          pname = "react-devtools";
          version = "6.1.1";
          addonId = "@react-devtools";
          url = "https://addons.mozilla.org/firefox/downloads/latest/react-devtools/latest.xpi";
          sha256 = "0iicv47qdnx3f84db8aknjmxrmmi2n4r8cyqqy5npg820hi9xmmj";
          meta = {};
        })
        (addons.buildFirefoxXpiAddon {
          pname = "kagi-search";
          version = "0.7.6";
          addonId = "search@kagi.com";
          url = "https://addons.mozilla.org/firefox/downloads/latest/kagi-search-for-firefox/latest.xpi";
          sha256 = "03wrf2shznnw16gj9476h2id73ls06k6dpq2smqpcgbyyprc1jji";
          meta = {};
        })
        (addons.buildFirefoxXpiAddon {
          pname = "maxfocus";
          version = "1";
          addonId = "{4bda55a4-25fc-4958-aca3-4b3261605398}";
          url = "https://addons.mozilla.org/firefox/downloads/latest/maxfocus-link-preview/latest.xpi";
          sha256 = "1lihhnbwz8cky8a0s36vvb46cf5mc4nkgyhaw3wqqx4qs3dqfkbh";
          meta = {};
        })
        (addons.buildFirefoxXpiAddon {
          pname = "simple-translate";
          version = "3.0.1";
          addonId = "simple-translate@sienori";
          url = "https://addons.mozilla.org/firefox/downloads/latest/simple-translate/latest.xpi";
          sha256 = "15n9jc36512b06vrxba0c948pacjhqdp9y1szl038pxs7jbjwi7q";
          meta = {};
        })
        (addons.buildFirefoxXpiAddon {
          pname = "multi-account-containers";
          version = "8.3.7";
          addonId = "@testpilot-containers";
          url = "https://addons.mozilla.org/firefox/downloads/latest/multi-account-containers/latest.xpi";
          sha256 = "0rai82dlwfbqkydzwlhq9dw7zl3540xfbifjk4dkvlq6n7vmwvvz";
          meta = {};
        })
      ];
    };
  };

  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };

  programs.nushell = {
    enable = true;
    extraConfig = ''
      $env.PATH = ($env.PATH | prepend "/Users/ranolp/.local/share/mise/shims" | prepend "/Users/ranolp/.local/bin" | prepend "/Users/ranolp/Library/Android/sdk/platform-tools" | prepend "/Users/ranolp/Library/Android/sdk/emulator")
      $env.ANDROID_HOME = "/Users/ranolp/Library/Android/sdk"
      $env.GITHUB_TOKEN = (^/Users/ranolp/.local/share/mise/shims/gh auth token | str trim)

      # nix-your-shell: nix develop / nix-shell → nushell
      source ~/.cache/nix-your-shell.nu
    '';
    shellAliases = {
      rebuild = "sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26";
      cat = "bat";
      ls = "eza";
    };
  };

  # minimal zsh as fallback
  programs.zsh = {
    enable = true;
    autosuggestion.enable = false;
    syntaxHighlighting.enable = false;
    completionInit = "";
    initContent = ''
      export PATH="/Users/ranolp/.local/share/mise/shims:$PATH"
      export ANDROID_HOME="$HOME/Library/Android/sdk"
      export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
    '';
  };

  programs.git = {
    enable = true;
    signing.format = null;
    settings = {
      user.name = "RanolP";
      user.email = "me@ranolp.dev";
      init.defaultBranch = "main";
      push.autoSetupRemote = true;
      pull.rebase = true;
      merge.conflictstyle = "zdiff3";
      rerere.enabled = true;
      commit.gpgSign = true;
    } // (if local ? gpgKey then {
      user.signingKey = local.gpgKey;
    } else {});
  };
}
