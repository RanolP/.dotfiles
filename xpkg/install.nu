#!/usr/bin/env nu

# xpkg -- the Windows counterpart to `nix`: install packages, then link configs.
# The config *content* lives in ../nix/home/configs (single source of truth);
# this tree carries only the Windows-specific pieces and the install glue.
use ~/.dotfiles/xpkg/utils/@windows/bootstrap.nu [relaunch-elevated refresh-path]

if ($nu.os-info.name == windows) and (not (is-admin)) {
    relaunch-elevated ~/.dotfiles/xpkg/install.nu
    return
}

echo $"(ansi green)==(ansi reset) Packages"
nu ~/.dotfiles/xpkg/windows/install.nu

# The configs step runs in a child process that inherits this PATH.
if $nu.os-info.name == windows { refresh-path }

if $nu.os-info.name == windows {
    echo $"(ansi green)==(ansi reset) Fonts"
    nu ~/.dotfiles/xpkg/apps/@fonts/install.nu
}

echo $"(ansi green)==(ansi reset) Configs"
nu ~/.dotfiles/xpkg/configs/install.nu
