#!/usr/bin/env nu

# Install the Windows packages declared in ./default.toml via winget.
# The declaration is a flat homebrew-style block; this just walks the lists.

use ~/.dotfiles/xpkg/utils/yesno.nu

def install-winget [id: string, skip_deps: bool, allow_upgrade: bool] {
    echo $"     (ansi green)++(ansi reset) ($id)"
    nu -c $"do -i { winget install -eh --accept-package-agreements --accept-source-agreements --id ($id) (
        if $skip_deps { '--skip-dependencies' } else { '' }
    ) (if $allow_upgrade { '' } else { '--no-upgrade' }) }"
}

export def main [--allow-upgrade = false] {
    if $nu.os-info.name != windows {
        echo $"    (ansi red)Unsupported OS(ansi reset): ($nu.os-info.name) \(xpkg installs on Windows only; use nix on macOS/Linux\)"
        return
    }

    let def = (open ~/.dotfiles/xpkg/windows/default.toml)
    let winget = ($def.winget? | default {})
    let skip = ($winget.skip_dependencies? | default [])

    for id in ($winget.packages? | default []) {
        install-winget $id ($id in $skip) $allow_upgrade
    }

    for id in ($winget.optional? | default []) {
        if (yesno $"    (ansi blue)??(ansi reset) Install optional ($id)?" true) {
            install-winget $id ($id in $skip) $allow_upgrade
        } else {
            echo $"    (ansi black)Skipped(ansi reset) ($id)"
        }
    }

    for entry in ($def.manual? | default {} | transpose name url) {
        echo $"    (ansi yellow)[!](ansi reset) Install ($entry.name) manually: ($entry.url)"
    }
}
