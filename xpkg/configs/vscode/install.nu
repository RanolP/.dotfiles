#!/usr/bin/env nu

if ($nu.os-info.kernel_version | str contains 'WSL2') {
    echo $'(ansi black)Skipped(ansi reset) VS Code Configuration not required in WSL2'
    return
}

# ref: https://code.visualstudio.com/docs/getstarted/settings#_settings-file-locations
let target = if $nu.os-info.name == macos {
    $'($nu.home-dir)/Library/Application Support/Code/User/settings.json'
} else if $nu.os-info.name == windows {
    $'($env.APPDATA)\Code\User\settings.json'
} else if $nu.os-info.family == unix {
    $'($nu.home-dir)/.config/Code/User/settings.json'
} else {
    ''
}
# @TODO
# It seems does not work now (seealso: https://github.com/microsoft/vscode/issues/194856)
# On Windows, msys `ln -s` silently makes a COPY (which also replaces an
# existing real link), so use New-Item, which needs the elevated shell
# configs/install.nu relaunches into; fall back to a copy when not elevated.
def link-file [src: string, dst: string] {
    if $nu.os-info.name == windows {
        let r = (do -i { ^powershell -NoProfile -Command $"New-Item -ItemType SymbolicLink -Force -Path '($dst)' -Value '($src)' -ErrorAction Stop | Out-Null" } | complete)
        if $r.exit_code != 0 {
            print -e $"(ansi yellow)!!(ansi reset) symlink needs elevation, copying ($dst)"
            cp -f $src $dst
        }
    } else {
        do -i { ln -s -f $src $dst }
    }
}
link-file $'($env.FILE_PWD)/settings.json' $target
link-file $'($env.FILE_PWD)/keybindings.json' ($target | path dirname | path join keybindings.json)

let installed = (code --list-extensions | from ssv -n | get column0)
let extensionList = (open $'($env.FILE_PWD)/extensions.toml' | values | flatten | parse --regex '^(?<name>[^@]+)(?:@(?<version>.+))?$')
for extension in $extensionList {
    if $extension.version in [null '' 'latest'] {
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
        echo $"     (ansi red)Out of Sync(ansi reset): Try configure (ansi yellow)($extension)(ansi reset) in ~/.dotfiles/xpkg/configs/vscode/extensions.toml."
        echo $"Try uninstall ($extension)"
    }
}
