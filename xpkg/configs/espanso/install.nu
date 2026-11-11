#!/usr/bin/env nu

# Mirrors nix/home/darwin/default.nix: the typsi and nannosym match packages
# from RanolP/typsi at the same pinned rev, copied into espanso's
# match/packages. espanso is restarted only when something changed.
if $nu.os-info.name != windows {
    return
}

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
def tree-hash [dir: string] {
    do { cd $dir; glob '**/*' | where {|p| ($p | path type) == file } }
    | each {|p| {path: ($p | path relative-to $dir | str replace --all '\' '/'), hash: (open --raw $p | hash sha256)} }
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

if $changed and (^$espanso status | complete).exit_code == 0 {
    ^$espanso restart | ignore
}
