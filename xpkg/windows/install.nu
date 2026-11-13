#!/usr/bin/env nu

# Install the Windows packages declared in ./default.toml via winget.
# Declarative & nix-style: a common [winget].packages set plus per-profile
# ([profiles.<hostname>]) additions. Reads `winget list` once (bulk), skips
# whatever is already installed, installs the rest, and only WARNS about
# winget-source packages installed but not declared -- it uninstalls only the
# ids listed under `remove` (no zap). The install progress bar is left on for
# real installs.

# Parse `winget list` into {name, id, source} records. Column-offset based: piped
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
            let name = ($line | str substring 0..<$id_start | str trim)
            let id = ($line | str substring $id_start..<$ver_start | str trim)
            let src = (if $src_start > 0 and ($line | str length) > $src_start { $line | str substring $src_start.. | str trim } else { "" })
            {name: $name, id: $id, source: $src}
        }
    } | where ($it.id | is-not-empty)
}

def install-winget [id: string, skip_deps: bool, override?: string] {
    mut args = ["install" "-eh" "--disable-interactivity" "--accept-package-agreements" "--accept-source-agreements" "--id" $id]
    if $skip_deps { $args = ($args | append "--skip-dependencies") }
    if $override != null { $args = ($args | append ["--override" $override]) }
    print $"     (ansi green)++(ansi reset) ($id)"
    let r = (^winget ...$args | complete)
    if $r.exit_code != 0 {
        print $"     (ansi red)!!(ansi reset) ($id) (ansi red)exit ($r.exit_code)(ansi reset)"
        for l in ($"($r.stdout)($r.stderr)" | lines | where ($it | str trim | is-not-empty) | last 3) { print $"        ($l)" }
    }
}

# `member`, when set, is the installer's path inside a zip download; an .msi
# installer runs through msiexec, anything else is executed directly.
def install-direct [name: string, url: string, args: list<string>, member?: string] {
    print $"     (ansi green)++(ansi reset) ($name) (ansi dark_gray)\(($url)\)(ansi reset)"
    let stem = ($nu.temp-dir | path join $"xpkg-($name | str replace -a ' ' '-')")
    let download = if $member == null { $"($stem).exe" } else { $"($stem).zip" }
    try { http get --raw $url | save -f $download } catch {|e|
        print $"     (ansi red)!!(ansi reset) ($name) (ansi red)download failed(ansi reset): ($e.msg)"
        return
    }
    let installer = if $member == null { $download } else {
        mkdir $stem
        # System32's bsdtar reads zip; a bare `tar` may resolve to Git's GNU tar, which does not.
        ^($env.SystemRoot | path join System32 tar.exe) -xf $download -C $stem
        # `member` uses `/`; msiexec only opens a backslash path.
        $stem | path join $member | str replace -a '/' '\'
    }
    let is_msi = ($installer | str ends-with '.msi')
    let log = $"($stem).log"
    let r = if $is_msi {
        ^msiexec /i $installer ...$args /l*v $log | complete
    } else {
        ^$installer ...$args | complete
    }
    rm -rf $download $stem
    # 3010: msiexec succeeded and asks for a reboot.
    if $r.exit_code not-in [0 3010] {
        print $"     (ansi red)!!(ansi reset) ($name) (ansi red)exit ($r.exit_code)(ansi reset)"
        if $is_msi and ($log | path exists) {
            # msiexec writes its verbose log as UTF-16LE.
            let errors = (open --raw $log | decode utf-16le | lines | where ($it =~ '(?i)error \d|return value 3') | last 5)
            for l in $errors { print $"        ($l)" }
            print $"        full log: ($log)"
        }
    } else {
        rm -f $log
    }
}

# Names from `wsl -l -q`; the output is UTF-16LE.
def installed-wsl [] {
    ^wsl.exe -l -q | decode utf-16le | str replace -a "\r" "" | str replace -a (char nul) "" | lines | where ($it | is-not-empty)
}

def install-wsl [name: string, user: string] {
    print $"     (ansi green)++(ansi reset) wsl ($name)"
    let r = (^wsl.exe --install $name --no-launch | complete)
    if $r.exit_code != 0 {
        print $"     (ansi red)!!(ansi reset) wsl ($name) (ansi red)exit ($r.exit_code)(ansi reset)"
        # wsl.exe prints UTF-16LE; stripping NULs leaves it readable.
        for l in ($"($r.stdout)($r.stderr)" | str replace -a (char nul) "" | lines | where ($it | str trim | is-not-empty) | last 3) { print $"        ($l)" }
        return
    }
    # On a machine without Virtual Machine Platform, `--install` only turns the
    # feature on and exits 0 with "Changes will not be effective until the
    # system is rebooted"; the distro does not exist yet.
    if ($name not-in (installed-wsl)) {
        print $"     (ansi yellow)[!](ansi reset) wsl ($name) (ansi yellow)not installed yet -- reboot Windows, then run `rebuild` again(ansi reset)"
        for l in ($"($r.stdout)($r.stderr)" | str replace -a (char nul) "" | lines | where ($it | str trim | is-not-empty) | last 3) { print $"        ($l)" }
        return
    }
    # Strip CR so a CRLF checkout cannot break the script.
    let script = (open --raw ~/.dotfiles/xpkg/windows/wsl-first-boot.sh | str replace -a "\r\n" "\n")
    let s = ($script | ^wsl.exe -d $name -u root -- bash -s -- $user | complete)
    if $s.exit_code != 0 {
        print $"     (ansi red)!!(ansi reset) wsl ($name) first-boot (ansi red)exit ($s.exit_code)(ansi reset)"
        for l in ($"($s.stdout)($s.stderr)" | str replace -a (char nul) "" | lines | where ($it | str trim | is-not-empty) | last 3) { print $"        ($l)" }
        return
    }
    # Not through `complete`, so the TTY reaches passwd.
    ^wsl.exe -d $name -u root -- passwd $user
    ^wsl.exe --terminate $name
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
    let profile = ($def.profiles? | get -o $host | get -o packages | default [])
    let declared = ($common ++ $profile | uniq)

    print $"(ansi green)==(ansi reset) profile (ansi cyan)($host)(ansi reset): ($declared | length) declared \(($common | length) common + ($profile | length) profile\)"

    let pkgs = (installed-packages)
    let installed_ids = ($pkgs | get id)

    # Install declared-but-missing; skip declared-and-present.
    for id in $declared {
        if ($id in $installed_ids) {
            print $"     (ansi dark_gray)==(ansi reset) ($id)"
        } else {
            install-winget $id ($id in $skip) ($def.winget?.override? | default {} | get -o $id)
        }
    }

    # Removed: listed under `remove` and still installed.
    for id in ($def.remove? | default [] | where ($it in $installed_ids)) {
        print $"     (ansi red)--(ansi reset) ($id)"
        let r = (^winget uninstall -eh --disable-interactivity --accept-source-agreements --id $id | complete)
        if $r.exit_code != 0 {
            print $"     (ansi red)!!(ansi reset) ($id) (ansi red)exit ($r.exit_code)(ansi reset)"
            for l in ($"($r.stdout)($r.stderr)" | lines | where ($it | str trim | is-not-empty) | last 3) { print $"        ($l)" }
        }
    }

    # Direct (not on winget, vendor URL): skip when the DisplayName is installed.
    let installed_names = ($pkgs | get name)
    for entry in ($def.direct? | default {} | transpose name spec) {
        # Prefix match: Inno Setup installers append the version to the
        # DisplayName ("VoiSona Talk 1.3.10.0", "Little Big Mouse version 5.6.0").
        if ($installed_names | any {|n| $n starts-with $entry.name }) {
            print $"     (ansi dark_gray)==(ansi reset) ($entry.name)"
        } else {
            install-direct $entry.name $entry.spec.url ($entry.spec.args? | default []) $entry.spec.member?
        }
    }

    # WSL distros: skip when `wsl -l -q` lists the name; else install, run the
    # first-boot script as root, set the password interactively, then restart.
    let wsl_entries = ($def.wsl? | default {} | transpose name spec)
    if not ($wsl_entries | is-empty) {
        let have = (installed-wsl)
        for entry in $wsl_entries {
            if ($entry.name in $have) {
                print $"     (ansi dark_gray)==(ansi reset) wsl ($entry.name)"
            } else {
                install-wsl $entry.name $entry.spec.user
            }
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
