#!/usr/bin/env nu

# Mirrors nix/home/darwin/default.nix: the typsi and nannosym match packages
# from RanolP/typsi at the same pinned rev, copied into espanso's
# match/packages. espanso is restarted only when something changed.
if $nu.os-info.name != windows {
    return
}
use ~/.dotfiles/xpkg/utils/@windows/bootstrap.nu [run-unelevated]

let rev = 'b871faf98997bd0f49ef6170297ea0f34ea765d3'
let espanso = if (which espanso | is-empty) {
    $env.LOCALAPPDATA | path join 'Programs' 'Espanso' 'espansod.exe' | if ($in | path exists) { $in } else { null }
} else { 'espanso' }
if $espanso == null {
    print -e $"(ansi yellow)!!(ansi reset) espanso not found; install it and rerun"
    return
}
# `espanso path` panics until espanso has run once and created its config
# directory, so fall back to the default location it will create.
let config = (do -i { ^$espanso path config } | complete | if $in.exit_code == 0 { $in.stdout | str trim } else { $env.APPDATA | path join 'espanso' })
let packages = ($config | path join 'match' 'packages')
let work = ($nu.temp-dir | path join $"typsi-($rev)")

if not ($work | path exists) {
    mkdir $work
    ^curl -fsSLo ($work | path join 'src.zip') $"https://github.com/RanolP/typsi/archive/($rev).zip"
    ^7z x ($work | path join 'src.zip') $"-o($work | path join 'unzipped')" -y | ignore
}

# Relative path + content hash of every file, so equal trees compare equal.
# `ls` inside the dir names files relative to it: under the elevated rebuild
# `glob` returned paths that `path relative-to $dir` rejected ("prefix not found").
def tree-hash [dir: string] {
    do {
        cd $dir
        ls -a ('**/*' | into glob) | where type == file
        | each {|f| {path: ($f.name | str replace --all '\' '/'), hash: (open --raw $f.name | hash sha256)} }
    }
    | sort-by path
}

mut changed = false
for name in [typsi nannosym] {
    let source = ($work | path join 'unzipped' $"typsi-($rev)" 'packages' $name)
    let target = ($packages | path join $name)
    if not (($target | path exists) and ((tree-hash $source) == (tree-hash $target))) {
        mkdir $packages
        rm -rf $target
        cp -r $source $target
        $changed = true
    }
}

# Leave espanso running after every rebuild. `espanso start`/`restart` spawn
# the daemon as our child holding the unit's output pipe, which hung the unit
# and let an aborted rebuild take espanso down with it. Start-Process detaches
# it, and run-unelevated keeps it out of the rebuild's admin token.
let running = { ps | where name == 'espansod.exe' | is-not-empty }
if $changed and (do $running) {
    ^$espanso stop | complete | ignore
}
if not (do $running) {
    let exe = ($env.LOCALAPPDATA | path join 'Programs' 'Espanso' 'espansod.exe')
    run-unelevated powershell -NoProfile -Command $"Start-Process -FilePath '($exe)' -ArgumentList launcher" | complete | ignore
}
