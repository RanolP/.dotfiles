#!/usr/bin/env nu

# Mirrors nix/home/programs/git.nix (the source of truth). Windows can't run
# home-manager, so xpkg applies the same settings via `git config --global`.
# Deliberately NOT mirrored here:
#   - credential.helper : nix pins a macOS keychain path; Windows uses Git
#                         Credential Manager by default.
#   - core.pager / interactive.diffFilter / delta.* : delta isn't installed.
#   - commit.gpgsign / user.signingkey : owned by
#     xpkg/apps/common/git/setup-gpg-signing.nu, which sets them only after
#     importing the key (enabling signing with no key breaks every commit).

# identity (replaces the old interactive setup-user.nu)
git config --global user.name "RanolP"
git config --global user.email "me@ranolp.dev"

# no CRLF at all
git config --global core.eol lf

# defaults matching nix
git config --global init.defaultBranch main
git config --global push.autoSetupRemote true
git config --global pull.rebase true
git config --global merge.conflictstyle zdiff3
git config --global rerere.enabled true
git config --global diff.colorMoved default
git config --global diff.algorithm histogram

# global excludes (core.excludesFile) -- mirrors programs.git.ignores in git.nix
let git_ignore = ($nu.home-path | path join '.config' 'git' 'ignore')
mkdir ($git_ignore | path dirname)
".nanno-workers.json\n.slopless/\n" | save -f $git_ignore
git config --global core.excludesFile ($git_ignore | str replace --all '\' '/')
