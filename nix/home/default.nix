{ pkgs, ... }:
let
  # Copy local.nix.example → local.nix and fill in secrets (gpg signing key, etc.)
  # local.nix is gitignored.
  hasLocal = builtins.pathExists ./local.nix;
  local = if hasLocal then import ./local.nix else {};
in {
  home.stateVersion = "24.11";

  home.packages = with pkgs; [
    # crypto / gpg
    gnupg
    pinentry_mac

    # dev tools
    gh
    nodejs_24
    nodePackages.pnpm
    python312
    zig
    uv

    # shell utilities
    ripgrep
    fd
    jq
    curl
    vim
    tmux
    zoxide
  ];

  programs.zsh = {
    enable = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;
    initExtra = ''
      eval "$(zoxide init zsh)"
    '';
  };

  programs.git = {
    enable = true;
    userName = "RanolP";
    userEmail = "me@ranolp.dev";
    signing = if local ? gpgKey then {
      key = local.gpgKey;
      signByDefault = true;
    } else {};
    extraConfig = {
      init.defaultBranch = "main";
      push.autoSetupRemote = true;
      pull.rebase = true;
    };
  };
}
