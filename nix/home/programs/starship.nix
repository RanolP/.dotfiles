{ ... }:
{
  programs.starship = {
    enable = true;
    enableNushellIntegration = true;
    # `starship init zsh` used to hang every interactive zsh at startup, but
    # that was the nix zsh 5.9 SIGCHLD race in $(...); Apple's /bin/zsh (served
    # from the user profile since 4f85605) is immune, so the hook is safe again.
    enableZshIntegration = true;
    settings = {
      format = "$directory$git_branch$git_commit$git_state$git_status$nodejs$python$rust$golang$kotlin$java$swift$fill$cmd_duration$time$line_break$character";

      fill = {
        symbol = " ";
      };

      cmd_duration = {
        min_time = 5000;
        format = "[took $duration]($style) ";
        style = "yellow";
      };

      time = {
        disabled = false;
        format = "[🕐 $time]($style)";
        style = "cyan";
      };
    };
  };
}
