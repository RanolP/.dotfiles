{ ... }:
{
  programs.ghostty = {
    enable = true;
    package = null;
    settings = {
      theme = "Nord";
      font-family = [
        "Iosevka Nerd Font Mono"
        "Pretendard"
      ];
      font-size = 16;
      command = "/etc/profiles/per-user/ranolp/bin/nu";
      keybind = [
        "super+d=new_split:right"
        "super+shift+d=new_split:down"
      ];
    };
  };
}
