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
        "extensions.autoUpdate" = false;
        "extensions.autoCheckUpdates" = false;
        "editor.fontFamily" = "Iosevka Nerd Font Mono, Pretendard";
        "editor.fontSize" = 14;
        "editor.fontLigatures" = true;
        "editor.formatOnSave" = true;
        "editor.minimap.enabled" = true;
        "workbench.colorTheme" = "Nord";
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
