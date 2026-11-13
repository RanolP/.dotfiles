#!/usr/bin/env nu

# The vendored choco-pi tree lives in the nix tree; Windows COPIES it into
# ~/.pi/agent/vendor, where nix/home/configs/pi/settings.json points its
# relative `packages` entries. Pi never npm-installs a local package, so the
# two directories with third-party dependencies get theirs from their
# committed pnpm lockfiles here.
let home = $nu.home-dir
let nix = $'($home)/.dotfiles/nix/home/configs'
let agent = $'($home)/.pi/agent'
let vendor = $'($agent)/vendor/choco-pi'

mkdir $'($agent)/vendor'

print $"     (ansi blue)Copy(ansi reset) vendor/choco-pi"
# Mirror (deleting files the source dropped) but leave node_modules alone, so
# an unchanged lockfile needs no reinstall. robocopy: exit < 8 is success.
let src = ($'($nix)/pi/choco-pi' | path expand)
let dst = ($vendor | path expand)
let copy = (^robocopy $src $dst /MIR /XD node_modules /NFL /NDL /NJH /NJS /NP | complete)
if $copy.exit_code >= 8 {
    print $copy.stdout
    error make { msg: $"robocopy into ($vendor) exited ($copy.exit_code)" }
}

for dir in [packages/choco-pi-web-access extensions] {
    let target = $'($vendor)/($dir)'
    # pnpm's own node_modules/.pnpm/lock.yaml is a normalised rewrite of
    # pnpm-lock.yaml, so it never matches byte for byte; stamp our own hash of
    # the install inputs inside node_modules instead.
    let stamp = $'($target)/node_modules/.xpkg-install-hash'
    let hash = (
        [pnpm-lock.yaml package.json pnpm-workspace.yaml]
        | each {|f|
            let p = $'($target)/($f)'
            if ($p | path exists) { open --raw $p | hash sha256 } else { "" }
        }
        | str join ":"
    )
    if ($stamp | path exists) and ((open --raw $stamp | str trim) == $hash) {
        print $"     (ansi blue)Skip(ansi reset) vendor/choco-pi/($dir) dependencies, lockfile unchanged"
        continue
    }
    print $"     (ansi blue)Install(ansi reset) vendor/choco-pi/($dir) dependencies"
    # The elevated install process has no mise dirs on PATH. `mise which`
    # rather than `mise exec`, which would first install every missing tool.
    let pnpm = (^mise which pnpm | str trim)
    let result = (do { cd $target; ^$pnpm install --frozen-lockfile --ignore-scripts } | complete)
    print $result.stdout
    if ($result.stderr | is-not-empty) { print -e $result.stderr }
    if $result.exit_code != 0 {
        error make { msg: $"pnpm install in ($target) exited ($result.exit_code)" }
    }
    $hash | save -f $stamp
}

# Pi rewrites settings.json at runtime, so keep every key it wrote and put
# the repo keys on top.
print $"     (ansi blue)Merge(ansi reset) settings.json"
let live_path = $'($agent)/settings.json'
let live = if ($live_path | path exists) { open $live_path } else { {} }
$live | merge (open $'($nix)/pi/settings.json') | to json --indent 2 | save -f $live_path
