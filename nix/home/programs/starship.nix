{ ... }:
{
  programs.starship = {
    enable = true;
    enableNushellIntegration = true;
    settings = {
      format = "$directory$git_branch$git_commit$git_state$git_status$nodejs$python$ruby$rust$golang$kotlin$java$swift$fill$cmd_duration$time$line_break$character";

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
