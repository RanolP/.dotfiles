{ pkgs, ... }:
let
  zjstatus = pkgs.fetchurl {
    url = "https://github.com/dj95/zjstatus/releases/download/v0.23.0/zjstatus.wasm";
    sha256 = "1zv173qh67x4bf4k4m5fpz22vy0pbp6f88c0c7dkjhjj4c9901p0";
  };
in
{
  programs.zellij = {
    enable = true;
    extraConfig = ''
      default_layout "default"
      on_force_close "quit"
      exit_on_close true
      show_release_notes false
      show_startup_tips false

      keybinds clear-defaults=false {
        normal {
          bind "Super d" { NewPane "Right"; }
          bind "Super Shift d" { NewPane "Down"; }
        }
      }
    '';
    layouts.default = ''
      layout {
        default_tab_template {
          children
        }
      }
    '';
  };
}
