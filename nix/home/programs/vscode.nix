{ pkgs, ... }:
{
  programs.vscode = {
    enable = true;
    package = pkgs.vscode;

    # Workaround for home-manager bug #8793 (regression in Feb 2026 commit b593765):
    # profiles.default.extensions breaks extension path resolution on macOS.
    # Fix: move extensions to top-level + mutableExtensionsDir = false.
    # Revert once upstream fix lands.
    mutableExtensionsDir = false;
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

    profiles.default = {
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
