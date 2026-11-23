{ ... }:
{
  programs.ghostty = {
    enable = true;
    package = null;
    settings = {
      theme = "Nord";
      # Bright black (palette 8) is the dim/comment gray for CLI tools; Nord's
      # #596377 is 2.0:1 on the background. Same #7b88a1 as VS Code's comments.
      palette = [ "8=#7b88a1" ];
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
