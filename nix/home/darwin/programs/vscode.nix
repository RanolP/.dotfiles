{ config, pkgs, ... }:
{
  programs.vscode = {
    enable = true;
    # nixpkgs' vscode generic.nix chmods the bundled ripgrep under
    # `node_modules/`, but vscode 1.129.x ships it under
    # `node_modules.asar.unpacked/`, so the stock path 404s and the darwin
    # build fails in patchPhase. Re-point the chmod at wherever rg actually is.
    package = pkgs.vscode.overrideAttrs (_: {
      postPatch = ''
        find 'Contents/Resources/app' -path '*@vscode/ripgrep-universal/bin/*/rg' \
          -exec chmod +x {} +
      '';
    });
    mutableExtensionsDir = false;

    profiles.default = {
      # TODO: audit these against current install (`code --list-extensions`).
      # Currently installed but undeclared (decide later):
      #   anthropic.claude-code
      #   mermaidchart.vscode-mermaid-chart
      #   terrastruct.d2
      #   tintinweb.graphviz-interactive-preview
      extensions =
        (with pkgs.vscode-extensions; [
          dbaeumer.vscode-eslint
          esbenp.prettier-vscode
          arcticicestudio.nord-visual-studio-code
          vscode-icons-team.vscode-icons
          eamodio.gitlens
          github.copilot
          github.copilot-chat
          github.vscode-pull-request-github
          thenuprojectcontributors.vscode-nushell-lang
        ])
        ++ [
          (pkgs.vscode-utils.buildVscodeMarketplaceExtension {
            mktplcRef = {
              publisher = "shd101wyy";
              name = "markdown-preview-enhanced";
              version = "0.8.25";
              sha256 = "sha256-0yOtvHL24eJizmzXAC956Tx9eNJaWDPl/OAhmFv2KJk=";
            };
          })
          # Official JetBrains Kotlin LSP; per-platform VSIX, so pin the arch.
          (pkgs.vscode-utils.buildVscodeMarketplaceExtension {
            mktplcRef = {
              publisher = "JetBrains";
              name = "kotlin-server";
              version = "0.0.86";
              arch = "darwin-arm64";
              sha256 = "sha256-ItQ/7pDIZoUzg7IGO0MYj1X9aFcdcJJ7jAcLhNGviCs=";
            };
            # The store copy is read-only and the launcher is already executable; skip the extension's chmod (EPERM).
            postPatch = ''
              substituteInPlace out/dist/extension.js --replace-fail '(0,external_fs_.chmodSync)(t,493)' 'void 0'
            '';
          })
        ];
      keybindings = [
        {
          key = "cmd+d";
          command = "workbench.action.terminal.split";
          when = "terminalFocus";
        }
        {
          key = "cmd+shift+d";
          command = "workbench.action.terminal.split";
          when = "terminalFocus";
        }
      ];
      userSettings = {
        # VSCode is pinned by nixpkgs; disable the in-app updater nag.
        "update.mode" = "none";
        # VSCode deprecated the boolean form; leaving it as `false` makes VSCode
        # rewrite the file to "off" on every launch, which fails against the
        # read-only nix store symlink.
        "extensions.autoUpdate" = "off";
        "extensions.autoCheckUpdates" = false;
        "editor.fontFamily" = "Iosevka Nerd Font Mono, Pretendard";
        "editor.fontSize" = 14;
        "editor.fontLigatures" = true;
        "editor.formatOnSave" = true;
        "editor.minimap.enabled" = true;
        "editor.unicodeHighlight.nonBasicASCII" = false;
        "workbench.colorTheme" = "Nord";
        # Nord's comment color (#616E88) sits at 2.4:1 on nord0. #7b88a1 is the
        # +20% step from Nord's own comment-brightness table (nordtheme/nord#94),
        # 3.5:1, and still clear of nord9 keywords. Same value as Ghostty and
        # Rex palette 8.
        "editor.tokenColorCustomizations" = {
          "[Nord]" = {
            textMateRules = [
              {
                scope = [ "comment" "punctuation.definition.comment" ];
                settings.foreground = "#7b88a1";
              }
            ];
          };
        };
        "workbench.iconTheme" = "vscode-icons";
        "terminal.integrated.defaultProfile.osx" = "nu";
        "scm.defaultViewMode" = "tree";
        "git.autofetch" = "all";
        "git.autofetchPeriod" = 60;
        "diffEditor.hideUnchangedRegions.enabled" = true;
        "files.autoSave" = "onFocusChange";
        "terminal.integrated.profiles.osx" = {
          # nushell is installed per-user by home-manager, not into the system
          # profile — /run/current-system/sw/bin/nu does not exist, and VSCode
          # silently falls back to the login shell (/bin/sh) on a bad path.
          "nu" = {
            "path" = "${config.home.profileDirectory}/bin/nu";
          };
        };
      };
    };
  };
}
