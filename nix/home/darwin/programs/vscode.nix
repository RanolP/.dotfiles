{ pkgs, ... }:
{
  programs.vscode = {
    enable = true;
    package = pkgs.vscode;
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
          "nu" = {
            "path" = "/run/current-system/sw/bin/nu";
          };
        };
      };
    };
  };
}
