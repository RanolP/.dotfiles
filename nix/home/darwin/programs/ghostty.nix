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
        # Fallback path for ~/.local/bin/herdr-key: Karabiner swallows super+d
        # and super+t before Ghostty sees them, so when the front window is NOT
        # herdr the script re-dispatches the action on these alt chords.
        "super+alt+d=new_split:right"
        "super+alt+shift+d=new_split:down"
        # cmd+t / cmd+w outside herdr keep their Ghostty meaning.
        "super+alt+t=new_tab"
        "super+alt+w=close_surface"
      ];
    };
  };
}
