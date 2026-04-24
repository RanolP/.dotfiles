{ pkgs, ... }:
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
        devices = [];
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
          rules = [{
            description = "MacBook internal keyboard: Windows-style layout";
            manipulators = [
              { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ is_built_in_keyboard = true; }]; }]; from.key_code = "fn";            to = [{ key_code = "left_command"; }]; }
              { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ is_built_in_keyboard = true; }]; }]; from.key_code = "left_control";  to = [{ key_code = "left_option";  }]; }
              { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ is_built_in_keyboard = true; }]; }]; from.key_code = "left_option";   to = [{ key_code = "fn";           }]; }
              { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ is_built_in_keyboard = true; }]; }]; from.key_code = "left_command";  to = [{ key_code = "left_control"; }]; }
              { type = "basic"; conditions = [{ type = "device_if"; identifiers = [{ is_built_in_keyboard = true; }]; }]; from.key_code = "right_command"; to = [{ key_code = "f18"; }]; }
            ];
          }];
        };
      }];
    };
  };

  home.file.".config/ghostty/config".text = ''
    theme = Nord
    font-family = Iosevka Nerd Font Mono
    command = /run/current-system/sw/bin/nu
  '';

  programs.direnv = {
    enable = true;
    nix-direnv.enable = true;
  };

  programs.nushell = {
    enable = true;
    extraConfig = ''
      $env.PATH = ($env.PATH | prepend "/Users/ranolp/.local/share/mise/shims")

      # nix-your-shell: nix develop / nix-shell → nushell
      nix-your-shell nu | save --force ~/.cache/nix-your-shell.nu
      source ~/.cache/nix-your-shell.nu
    '';
    shellAliases = {
      rebuild = "sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-MBP-26";
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
    } // (if local ? gpgKey then {
      user.signingKey = local.gpgKey;
      commit.gpgSign = true;
    } else {});
  };
}
