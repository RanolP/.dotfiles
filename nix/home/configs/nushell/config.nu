source ~/.cache/nix-your-shell.nu

$env.config = ($env.config | upsert show_banner false)
