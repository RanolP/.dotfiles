#!/usr/bin/env nu

# xpkg -- the Windows counterpart to `nix`: install packages, then link configs.
# The config *content* lives in ../nix/home/configs (single source of truth);
# this tree carries only the Windows-specific pieces and the install glue.

if ($nu.os-info.name == windows) and (not (is-admin)) {
    echo $"(ansi yellow)!!(ansi reset) Relaunch ~/.dotfiles/xpkg/install.nu with admin privileges"
    sudo nu ~/.dotfiles/xpkg/install.nu
    return
}

echo $"(ansi green)==(ansi reset) Packages"
nu ~/.dotfiles/xpkg/windows/install.nu

echo $"(ansi green)==(ansi reset) Configs"
nu ~/.dotfiles/xpkg/configs/install.nu
