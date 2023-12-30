source ~/.dotfiles/utils/normalize.nu

if not (is-admin) {
    echo "Relaunch ~/.dotfiles/configs/install.nu with admin privileges"
    sudo source ~/.dotfiles/configs/install.nu
    exit 0
}

echo "Symlinking nushell configs..."
ln -f $'($nu.home-path)/.dotfiles/configs/$nu/config.nu' $nu.config-path
ln -f $'($nu.home-path)/.dotfiles/configs/$nu/env.nu' $nu.env-path
