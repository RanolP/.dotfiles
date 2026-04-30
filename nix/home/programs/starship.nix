{ ... }:
{
  programs.starship = {
    enable = true;
    enableNushellIntegration = true;
    settings = {
      format = "$all$fill$cmd_duration$time\n$character";

      fill = {
        symbol = " ";
      };

      cmd_duration = {
        min_time = 0;
        format = "[$duration]($style) ";
        style = "yellow";
      };

      time = {
        disabled = false;
        format = "[$time]($style)";
        style = "cyan";
      };
    };
  };
}
