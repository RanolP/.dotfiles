#!/usr/bin/env nu

# Mirrors nix/home/programs/git.nix (the source of truth). Windows can't run
# home-manager, so xpkg applies the same settings via `git config --global`.
# Deliberately NOT mirrored here:
#   - credential.helper : nix pins a macOS keychain path; Windows uses Git
#                         Credential Manager by default.
#   - commit.gpgsign / user.signingkey : owned by
#     xpkg/apps/common/git/setup-gpg-signing.nu, which sets them only after
#     importing the key (enabling signing with no key breaks every commit).

# Read the global config once and write only the keys whose value differs;
# each `git config` spawn costs more than the whole read.
$env.GIT_GLOBAL_CURRENT = (
    (^git config --global --list | complete | get stdout)
    | lines
    | parse '{key}={value}'
    | reduce --fold {} {|it, acc| $acc | upsert $it.key $it.value }
)
def set-config [key: string, value: string] {
    if ($env.GIT_GLOBAL_CURRENT | get -o ($key | str lowercase)) != $value {
        git config --global $key $value
    }
}

# identity (replaces the old interactive setup-user.nu)
set-config user.name "RanolP"
set-config user.email "me@ranolp.dev"

# no CRLF at all
set-config core.eol 'lf'

# defaults matching nix
set-config init.defaultBranch 'main'
set-config push.autoSetupRemote 'true'
set-config pull.rebase 'true'
set-config merge.conflictstyle 'zdiff3'
set-config rerere.enabled 'true'
set-config diff.colorMoved 'default'
set-config diff.algorithm 'histogram'

# delta as pager (installed through mise)
set-config core.pager delta
set-config interactive.diffFilter "delta --color-only"
set-config delta.navigate 'true'
set-config delta.side-by-side 'false'

# global excludes (core.excludesFile) -- mirrors programs.git.ignores in git.nix
let git_ignore = ($nu.home-dir | path join '.config' 'git' 'ignore')
mkdir ($git_ignore | path dirname)
".nanno-workers.json\n.slopless/\n" | save -f $git_ignore
set-config core.excludesFile ($git_ignore | str replace --all '\' '/')
