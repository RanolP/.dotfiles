#!/usr/bin/env nu
source ~/.dotfiles/utils/normalize.nu

if ($nu.os-info.name == windows) and (not (is-admin)) {
    echo $"(ansi yellow)!!(ansi reset) Relaunch ~/.dotfiles/configs/install.nu with admin privileges"
    sudo nu ~/.dotfiles/configs/install.nu
    return
}

echo $"(ansi purple)>>(ansi reset) Hardlinking nushell configs"
do -i { ln -P -f $'($nu.home-path)/.dotfiles/configs/$nu/config.nu' $nu.config-path }
do -i { ln -P -f $'($nu.home-path)/.dotfiles/configs/$nu/env.nu' $nu.env-path }

echo $"(ansi purple)>>(ansi reset) Updating .gitconfig"
nu $'($env.FILE_PWD)/$home/gitconfig.nu'

if not (which code | is-empty) {
    echo $"(ansi purple)>>(ansi reset) Symlinking VS Code settings"
    nu $'($env.FILE_PWD)/$vscode/install.nu'    
}