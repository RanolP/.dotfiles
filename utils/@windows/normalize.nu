use ~/.dotfiles/utils/@windows/git-bash.nu

#!/usr/bin/env nu
export alias ln = coreutils ln

export def --wrapped gpg [...args] {
    git-bash $"gpg ($args | str join ' ')"
}
