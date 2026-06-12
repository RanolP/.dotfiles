# nix-your-shell: nix develop / nix-shell -> nushell
source ~/.cache/nix-your-shell.nu

# banner off (after starship sets render_right_prompt_on_last_line)
$env.config = ($env.config | upsert show_banner false)
