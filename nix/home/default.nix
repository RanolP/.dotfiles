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

    # dev tools
    gh
    nodejs_24
    pnpm
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
    initContent = ''
      eval "$(zoxide init zsh)"
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
