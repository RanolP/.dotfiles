{ pkgs, ... }:
{
  programs.vscode = {
    enable = true;
    package = pkgs.vscode;

    profiles.default = {
      # TODO: audit these against current install (`code --list-extensions`).
      # Currently installed but undeclared (decide later):
      #   anthropic.claude-code
      #   mermaidchart.vscode-mermaid-chart
      #   terrastruct.d2
      #   thenuprojectcontributors.vscode-nushell-lang
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
      userSettings = {
        "editor.fontFamily" = "Iosevka Nerd Font Mono, Pretendard";
        "editor.fontSize" = 14;
        "editor.fontLigatures" = true;
        "editor.formatOnSave" = true;
        "editor.minimap.enabled" = true;
        "workbench.colorTheme" = "Nord";
        "workbench.iconTheme" = "vscode-icons";
        "terminal.integrated.defaultProfile.osx" = "nu";
        "scm.defaultViewMode" = "tree";
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
