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

    # shell utilities
    ripgrep
    fd
    jq
    curl
    vim
    tmux
  ];

# mise is managed by homebrew — only write the config file
  home.file.".config/mise/config.toml".text = ''
    [settings]
    experimental = true
  '';

  programs.nushell = {
    enable = true;
    extraConfig = ''
      $env.PATH = ($env.PATH | prepend "/Users/ranolp/.local/share/mise/shims")
    '';
    shellAliases = {
      rebuild = "sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-MBP-26";
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
