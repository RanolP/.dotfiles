{ ... }:
{
  programs.starship = {
    enable = true;
    enableNushellIntegration = true;
    # `starship init zsh` hangs every interactive zsh at startup (even with
    # stdin redirected), so keep starship out of zsh entirely. zsh is only a
    # fallback shell; the real prompt lives in nushell.
    enableZshIntegration = false;
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
