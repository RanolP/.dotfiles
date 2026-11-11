#!/usr/bin/env nu

# Mirrors nix's `.gnupg/gpg-agent.conf` (long passphrase cache). Git's gpg
# reads the homedir `gpgconf --list-dirs homedir` reports; the agent only
# rereads the file on restart, so it is killed (and respawns on next use) only
# when the content changed.
let source = ($nu.home-dir | path join '.dotfiles' 'nix' 'home' 'configs' 'gnupg' 'gpg-agent.conf')
# Git's gpgconf prints an MSYS path (/c/Users/...); nu needs the Windows form.
let homedir = (^cygpath -w (^gpgconf --list-dirs homedir | str trim) | str trim)
let target = ($homedir | path join 'gpg-agent.conf')

mkdir $homedir
if ($target | path exists) and ((open --raw $target) == (open --raw $source)) {
    return
}
cp -f $source $target
^gpgconf --kill gpg-agent
