source ~/.dotfiles/utils/normalize.nu

if not (is-admin) {
    echo "Relaunch ~/.dotfiles/configs/install.nu with admin privileges"
    sudo source ~/.dotfiles/configs/install.nu
    return
}

echo $"(ansi purple)>>(ansi reset) Hardlinking nushell configs"
do -i { ln -P -f $'($nu.home-path)/.dotfiles/configs/$nu/config.nu' $nu.config-path }
do -i { ln -P -f $'($nu.home-path)/.dotfiles/configs/$nu/env.nu' $nu.env-path }

echo $"(ansi purple)>>(ansi reset) Updating .gitconfig"
nu $'($env.FILE_PWD)/$home/gitconfig.nu'

echo $"(ansi purple)>>(ansi reset) Symlinking VS Code settings"
nu $'($env.FILE_PWD)/$vscode/install.nu'
