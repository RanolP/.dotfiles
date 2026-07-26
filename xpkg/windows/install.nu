#!/usr/bin/env nu

# Install the Windows packages declared in ./default.toml via winget.
# Declarative & nix-style: a common [winget].packages set plus per-profile
# ([profiles.<hostname>]) additions. Reads `winget list` once (bulk), skips
# whatever is already installed, installs the rest, and only WARNS about
# winget-source packages installed but not declared -- it never uninstalls (no
# zap). The install progress bar is left on for real installs.

# Parse `winget list` into {id, source} records. Column-offset based: piped
# output is not truncated, and the header row fixes each column's start.
def installed-packages [] {
    let raw = (^winget list --disable-interactivity | complete | get stdout | lines)
    let matches = ($raw | enumerate | where {|r| ($r.item | str contains "Id") and ($r.item | str contains "Version") } | get index)
    if ($matches | is-empty) { return [] }
    let hidx = ($matches | first)
    let header = ($raw | get $hidx)
    let id_start = ($header | str index-of "Id")
    let ver_start = ($header | str index-of "Version")
    let src_start = ($header | str index-of "Source")
    $raw | skip ($hidx + 2) | each {|line|
        if ($line | str length) > $id_start {
            let id = ($line | str substring $id_start..<$ver_start | str trim)
            let src = (if $src_start > 0 and ($line | str length) > $src_start { $line | str substring $src_start.. | str trim } else { "" })
            {id: $id, source: $src}
        }
    } | where ($it.id | is-not-empty)
}

def install-winget [id: string, skip_deps: bool] {
    mut args = ["install" "-eh" "--disable-interactivity" "--accept-package-agreements" "--accept-source-agreements" "--id" $id]
    if $skip_deps { $args = ($args | append "--skip-dependencies") }
    print $"     (ansi green)++(ansi reset) ($id)"
    let r = (^winget ...$args | complete)
    if $r.exit_code != 0 {
        print $"     (ansi red)!!(ansi reset) ($id) (ansi red)exit ($r.exit_code)(ansi reset)"
        for l in ($"($r.stdout)($r.stderr)" | lines | where ($it | str trim | is-not-empty) | last 3) { print $"        ($l)" }
    }
}

export def main [] {
    if $nu.os-info.name != windows {
        print $"    (ansi red)Unsupported OS(ansi reset): xpkg is Windows-only; use nix on macOS/Linux"
        return
    }

    let def = (open ~/.dotfiles/xpkg/windows/default.toml)
    let host = (sys host | get hostname)
    let skip = ($def.skip_dependencies? | default [])
    let common = ($def.winget?.packages? | default [])
    let profile = ($def.profiles? | get -i $host | get -i packages | default [])
    let declared = ($common ++ $profile | uniq)

    print $"(ansi green)==(ansi reset) profile (ansi cyan)($host)(ansi reset): ($declared | length) declared \(($common | length) common + ($profile | length) profile\)"

    let pkgs = (installed-packages)
    let installed_ids = ($pkgs | get id)

    # Install declared-but-missing; skip declared-and-present.
    for id in $declared {
        if ($id in $installed_ids) {
            print $"     (ansi dark_gray)==(ansi reset) ($id)"
        } else {
            install-winget $id ($id in $skip)
        }
    }

    # Manual (not on winget).
    for entry in ($def.manual? | default {} | transpose name url) {
        print $"     (ansi yellow)[!](ansi reset) manual: ($entry.name) -> ($entry.url)"
    }

    # Drift: winget-source packages installed but NOT declared. Warn only, never zap.
    let undeclared = ($pkgs | where source == "winget" | get id | where ($it not-in $declared) | uniq | sort)
    if not ($undeclared | is-empty) {
        print ""
        print $"(ansi yellow)!!(ansi reset) ($undeclared | length) winget package\(s\) installed but not declared \(not removed -- add to a profile or ignore\):"
        for id in $undeclared { print $"     (ansi yellow)?(ansi reset) ($id)" }
    }
}
