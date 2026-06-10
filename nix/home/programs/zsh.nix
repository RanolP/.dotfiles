{ ... }:
{
  # minimal zsh as fallback
  programs.zsh = {
    enable = true;
    shellAliases = import ./aliases.nix;
    autosuggestion.enable = false;
    syntaxHighlighting.enable = false;
    completionInit = "";
    initContent = ''
      export PATH="/Users/ranolp/.local/share/mise/shims:$PATH"
      export ANDROID_HOME="$HOME/Library/Android/sdk"
      export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
    '';
  };
}
