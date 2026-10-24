#!/usr/bin/env nu

# The vendored choco-pi tree lives in the nix tree; Windows COPIES it into
# ~/.pi/agent/vendor, where nix/home/configs/pi/settings.json points its
# relative `packages` entries. Pi never npm-installs a local package, so the
# two directories with third-party dependencies get theirs from their
# committed pnpm lockfiles here.
let home = $nu.home-path
let nix = $'($home)/.dotfiles/nix/home/configs'
let agent = $'($home)/.pi/agent'
let vendor = $'($agent)/vendor/choco-pi'

do -i { mkdir $'($agent)/vendor' }

print $"     (ansi blue)Copy(ansi reset) vendor/choco-pi"
do -i { rm -rf $vendor }
cp --recursive $'($nix)/pi/choco-pi' $vendor

for dir in [packages/choco-pi-web-access extensions] {
    print $"     (ansi blue)Install(ansi reset) vendor/choco-pi/($dir) dependencies"
    let result = (do { cd $'($vendor)/($dir)'; ^pnpm install --frozen-lockfile --ignore-scripts } | complete)
    print $result.stdout
    if ($result.stderr | is-not-empty) { print -e $result.stderr }
    if $result.exit_code != 0 {
        error make { msg: $"pnpm install in ($vendor)/($dir) exited ($result.exit_code)" }
    }
}

# Pi rewrites settings.json at runtime, so keep every key it wrote and put
# the repo keys on top.
print $"     (ansi blue)Merge(ansi reset) settings.json"
let live_path = $'($agent)/settings.json'
let live = if ($live_path | path exists) { open $live_path } else { {} }
$live | merge (open $'($nix)/pi/settings.json') | to json --indent 2 | save -f $live_path
