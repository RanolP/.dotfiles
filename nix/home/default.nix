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
    pinentry-tty

    # nix shell integration for nushell
    nix-your-shell

    # xcodes CLI (prebuilt — brew formula builds from source, needs xcbuild = Xcode 닭달걀 문제)
    (import ./xcodes.nix { inherit pkgs; })
  ];

  # mise is managed by homebrew — only write the config file
  home.file.".config/mise/config.toml".source = ./configs/mise/config.toml;

  home.file.".config/karabiner/karabiner.json" = {
    force = true;
    source = ./configs/karabiner/karabiner.json;
  };

  home.file.".config/ghostty/config".source = ./configs/ghostty/config;
  home.file.".gnupg/gpg-agent.conf" = { source = ./configs/gnupg/gpg-agent.conf; onChange = "/etc/profiles/per-user/ranolp/bin/gpgconf --kill gpg-agent"; };
  home.file.".config/linearmouse/linearmouse.json".source = ./configs/linearmouse/linearmouse.json;


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

  programs.nushell = {
    enable = true;
    extraConfig = ''
      $env.PATH = ($env.PATH | prepend "/etc/profiles/per-user/ranolp/bin" | prepend "/Users/ranolp/.local/share/mise/shims" | prepend "/Users/ranolp/.local/bin" | prepend "/Users/ranolp/Library/Android/sdk/platform-tools" | prepend "/Users/ranolp/Library/Android/sdk/emulator")
      $env.ANDROID_HOME = "/Users/ranolp/Library/Android/sdk"
      $env.GITHUB_TOKEN = (^/Users/ranolp/.local/share/mise/shims/gh auth token | str trim)
      $env.EZA_OPTS = "--icons=auto --git --group-directories-first --header --time-style=relative"

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

  programs.vscode = {
    enable = true;
    package = pkgs.vscode;
    profiles.default = {
      extensions = with pkgs.vscode-extensions; [
        dbaeumer.vscode-eslint
        esbenp.prettier-vscode
        arcticicestudio.nord-visual-studio-code
        vscode-icons-team.vscode-icons
      ];
      userSettings = {
        "editor.fontFamily" = "Iosevka Nerd Font Mono";
        "editor.fontSize" = 14;
        "editor.fontLigatures" = true;
        "editor.formatOnSave" = true;
        "editor.minimap.enabled" = true;
        "workbench.colorTheme" = "Nord";
        "workbench.iconTheme" = "vscode-icons";
        "terminal.integrated.defaultProfile.osx" = "nu";
        "scm.defaultViewMode" = "tree";
        "terminal.integrated.profiles.osx" = {
          "nu" = {
            "path" = "/run/current-system/sw/bin/nu";
          };
        };
      };
    };
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
      user.signingKey = "BB9C29B5FA1C8305";
    };
  };
}
