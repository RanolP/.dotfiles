#!/usr/bin/env nu
source ~/.dotfiles/xpkg/utils/normalize.nu

if ($nu.os-info.name == windows) and (not (is-admin)) {
    echo $"(ansi yellow)!!(ansi reset) Relaunch ~/.dotfiles/xpkg/configs/install.nu with admin privileges"
    sudo nu ~/.dotfiles/xpkg/configs/install.nu
    return
}

let configs = $env.FILE_PWD

echo $"(ansi purple)>>(ansi reset) Hardlinking nushell configs"
do -i { ln -P -f $'($configs)/nushell/config.nu' $nu.config-path }
do -i { ln -P -f $'($configs)/nushell/env.nu' $nu.env-path }

echo $"(ansi purple)>>(ansi reset) Updating .gitconfig"
nu $'($configs)/gitconfig.nu'

if not (which code | is-empty) {
    echo $"(ansi purple)>>(ansi reset) Symlinking VS Code settings"
    nu $'($configs)/vscode/install.nu'
}

if not (which claude | is-empty) {
    echo $"(ansi purple)>>(ansi reset) Installing Claude Code configs"
    nu $'($configs)/claude/install.nu'
}

if not (which codex | is-empty) {
    echo $"(ansi purple)>>(ansi reset) Installing Codex configs"
    nu $'($configs)/codex/install.nu'
}

if ($nu.os-info.kernel_version | str contains 'WSL2') {
    echo $"(ansi purple)>>(ansi reset) Integrating Windows fonts for WSL2"
    do -i { sudo mkdir /etc/fonts/ }
    do -i { sudo ln -s -f $'($configs)/fonts/local.conf' '/etc/fonts/local.conf' }
}
