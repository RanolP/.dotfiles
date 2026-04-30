{ ... }:
{
  programs.starship = {
    enable = true;
    enableNushellIntegration = true;
    settings = {
      right_format = "$cmd_duration$time";

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
