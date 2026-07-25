{ pkgs, ... }:
{
  # minimal zsh as fallback
  programs.zsh = {
    enable = true;
    # Apple's /bin/zsh instead of the nix build: nix zsh 5.9 loses SIGCHLD
    # during $(...) command substitution when spawned as a session leader with
    # piped stdio (how Claude Code spawns its Bash-tool shell) and blocks
    # forever in sigsuspend; Apple's build is immune. The stub keeps the nix
    # package's share/ so HELPDIR and fpath entries stay valid. This makes
    # /etc/profiles/per-user/ranolp/bin/zsh resolve to Apple's binary, which
    # shadows the system-profile nix zsh everywhere on PATH (nix-darwin's
    # programs.zsh has no package option, so /run/current-system/sw/bin/zsh
    # stays the nix build -- nothing resolves zsh through it).
    package = pkgs.runCommandLocal "zsh-apple-system" { } ''
      mkdir -p $out/bin
      ln -s /bin/zsh $out/bin/zsh
      ln -s ${pkgs.zsh}/share $out/share
    '';
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
    # init stays cheap. Interactive zsh additionally runs the `mise activate`
    # hook from .zshrc (safe again on Apple's /bin/zsh); these shims remain the
    # sole tool source for non-interactive zsh.
    envExtra = ''
      export PATH="/Users/ranolp/.local/bin:/Users/ranolp/.local/share/mise/shims:$PATH"
      export ANDROID_HOME="$HOME/Library/Android/sdk"
      export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
      # Claude Code shells (CLAUDECODE=1) keep zero history: no HISTFILE and
      # zero sizes means no history-file open/lock can ever stall a tool call,
      # regardless of what setopts the shell snapshot replays.
      if [[ -n "''${CLAUDECODE:-}" ]]; then
        unset HISTFILE
        HISTSIZE=0
        SAVEHIST=0
      fi
    '';
    # Static replacement for `eval "$(brew shellenv zsh)"` that used to live in
    # an unmanaged ~/.zprofile. That command substitution forks during login-
    # shell init; under bursts of parallel Claude Bash calls (zsh -c -l) the
    # SIGCHLD gets lost and zsh blocks forever in waitforpid/signal_suspend
    # inside run_init_scripts. Plain exports fork nothing, so the race is gone.
    # Mirror of the .zshenv CLAUDECODE guard: Claude Code's shell snapshot
    # sources .zshrc, whose home-manager history block re-sets HISTFILE after
    # .zshenv ran. Dropping it again here keeps any snapshot-captured state
    # history-free too.
    initContent = ''
      if [[ -n "''${CLAUDECODE:-}" ]]; then
        unset HISTFILE
        HISTSIZE=0
        SAVEHIST=0
      fi
    '';
    profileExtra = ''
      export HOMEBREW_PREFIX="/opt/homebrew"
      export HOMEBREW_CELLAR="/opt/homebrew/Cellar"
      export HOMEBREW_REPOSITORY="/opt/homebrew/Library/.homebrew-is-managed-by-nix"
      export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
      export INFOPATH="/opt/homebrew/share/info:''${INFOPATH:-}"
      fpath[1,0]="/opt/homebrew/share/zsh/site-functions"
    '';
  };
}
