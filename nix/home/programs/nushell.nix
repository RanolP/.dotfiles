{ ... }:
{
  programs.nushell = {
    enable = true;
    extraConfig = ''
      $env.PATH = ($env.PATH | prepend "/etc/profiles/per-user/ranolp/bin" | prepend "/Users/ranolp/.local/share/mise/shims" | prepend "/Users/ranolp/.local/bin" | prepend "/Users/ranolp/Library/Android/sdk/platform-tools" | prepend "/Users/ranolp/Library/Android/sdk/emulator")
      $env.ANDROID_HOME = "/Users/ranolp/Library/Android/sdk"
      $env.GITHUB_TOKEN = (^/Users/ranolp/.local/share/mise/shims/gh auth token | str trim)

      # nix-your-shell: nix develop / nix-shell → nushell
      source ~/.cache/nix-your-shell.nu

      # banner off (after starship sets render_right_prompt_on_last_line)
      $env.config = ($env.config | upsert show_banner false)
    '';
    shellAliases = {
      rebuild = "sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26";
      cat = "bat";
      ls = "eza --icons=auto --git --group-directories-first --header --time-style=relative";
    };
  };
}
