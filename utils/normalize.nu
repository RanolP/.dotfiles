const os_file = if $nu.os-info.name == windows {
    '~/.dotfiles/utils/@windows/normalize.nu'
} else {
    '~/.dotfiles/'
}

if ($os_file | path type) != file {
    return
}

echo $'Applying ($os_file)'
use $os_file *