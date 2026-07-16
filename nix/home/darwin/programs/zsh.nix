{ ... }:
{
  # minimal zsh as fallback
  programs.zsh = {
    enable = true;
    shellAliases = import ../../programs/aliases.nix;
    # SHARE_HISTORY makes every zsh lock+append the one shared HISTFILE after
    # each command; combined with HIST_FCNTL_LOCK that lock is a blocking
    # fcntl(F_SETLKW) wait. Claude Code's shell snapshot captures these setopts,
    # so every per-call tool zsh joins the contention -- under a burst of
    # parallel Bash calls they queue for minutes (a killed shell can leave the
    # lock held). Disabling share drops the per-command lock and fixes the hang.
    history.share = false;
    autosuggestion.enable = false;
    syntaxHighlighting.enable = false;
    completionInit = "";
    # These live in .zshenv (envExtra), not .zshrc (initContent): Claude Code's
    # Bash tool spawns a NON-interactive zsh, which reads .zshenv but skips
    # .zshrc. Keeping the mise shims here is what lets Claude find rg/fd/jq/gh/
    # node/etc. by bare name. Plain exports (no subprocess) so per-call shell
    # init stays cheap. The `mise activate` hook is disabled everywhere (it
    # deadlocked zsh at startup), so these shims are the sole tool source in
    # both interactive and non-interactive zsh.
    envExtra = ''
      export PATH="/Users/ranolp/.local/bin:/Users/ranolp/.local/share/mise/shims:$PATH"
      export ANDROID_HOME="$HOME/Library/Android/sdk"
      export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
    '';
  };
}
