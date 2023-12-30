source ~/.dotfiles/utils/normalize.nu

if not (is-admin) {
    echo "Relaunch ~/.dotfiles/configs/install.nu with admin privileges"
    sudo source ~/.dotfiles/configs/install.nu
    return
}

echo ">> Hardlinking nushell configs"
do -i { ln -f $'($nu.home-path)/.dotfiles/configs/$nu/config.nu' $nu.config-path }
do -i { ln -f $'($nu.home-path)/.dotfiles/configs/$nu/env.nu' $nu.env-path }

echo ">> Updating .gitconfig"
source ./$home/gitconfig.nu
