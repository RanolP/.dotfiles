#!/usr/bin/env nu

# ref: https://code.visualstudio.com/docs/getstarted/settings#_settings-file-locations
let target = if $nu.os-info.name == macos {
    $'($nu.home-path)/Library/Application Support/Code/User/settings.json'
} else if $nu.os-info.name == windows {
    $'($env.APPDATA)\Code\User\settings.json'
} else if $nu.os-info.family == unix {
    $'$(nu.home-path)/.config/Code/User/settings.json'
} else {
    ''
}
# @TODO
# It seems does not work now (seealso: https://github.com/microsoft/vscode/issues/194856)
do -i { ln -s -f $'($nu.home-path)/.dotfiles/configs/$vscode/settings.json' $target }

let installed = (code --list-extensions | from ssv -n | get column1)
let extensionList = (open $'($env.FILE_PWD)/extensions.toml' | values | flatten | parse --regex '^(?<name>[^@]+)(?:@(?<version>.+))?$')
for extension in $extensionList {
    if $extension.version == '' or $extension.version == 'latest' {
        if ($installed | find $extension.name | is-empty) {
            echo $"     (ansi blue)Install(ansi reset) ($extension.name)"
            code --force --install-extension $extension.name
        } else {
            echo $"     (ansi black)Checked(ansi reset) ($extension.name)"
        }
    } else {
        echo $"     (ansi blue)Install(ansi reset) ($extension.name)"
        code --force --install-extension $'($extension.name)@($extension.version)'
    }
}

for extension in $installed {
    if ($extensionList | get name | find $extension | is-empty) {
        echo $"     (ansi red)Out of Sync(ansi reset): Try configure (ansi yellow)($extension)(ansi reset) in ~/.dotfiles/configs/$vscode/extensions.toml."
        echo $"Try uninstall ($extension)"
    }
}
