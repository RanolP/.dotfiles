#!/usr/bin/env nu

# Install the Windows packages declared in ./default.toml via winget.
# The declaration is a flat homebrew-style block; this just walks the lists.

use ~/.dotfiles/xpkg/utils/yesno.nu

def install-winget [id: string, skip_deps: bool, allow_upgrade: bool] {
    mut args = ["install" "-eh" "--disable-interactivity" "--accept-package-agreements" "--accept-source-agreements" "--id" $id]
    if $skip_deps { $args = ($args | append "--skip-dependencies") }
    if not $allow_upgrade { $args = ($args | append "--no-upgrade") }

    # winget is extremely noisy (progress bars, source-update retries, "already
    # installed" spam). Capture all of it; surface only a one-line status.
    let r = (^winget ...$args | complete)
    let out = $"($r.stdout)($r.stderr)"

    if ($out | str contains --ignore-case "already installed") {
        print $"     (ansi dark_gray)==(ansi reset) ($id) (ansi dark_gray)already installed(ansi reset)"
    } else if $r.exit_code == 0 {
        print $"     (ansi green)++(ansi reset) ($id)"
    } else {
        print $"     (ansi red)!!(ansi reset) ($id) (ansi red)\(exit ($r.exit_code)\)(ansi reset)"
        for l in ($out | lines | where ($it | str trim | is-not-empty) | last 3) { print $"        ($l)" }
    }
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
