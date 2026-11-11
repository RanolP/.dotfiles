#!/usr/bin/env nu

# Mirrors nix's `.gnupg/gpg-agent.conf` (long passphrase cache). Git's gpg
# reads the homedir `gpgconf --list-dirs homedir` reports; the agent only
# rereads the file on restart, so it is killed (and respawns on next use) only
# when the content changed.
let source = ($nu.home-dir | path join '.dotfiles' 'nix' 'home' 'configs' 'gnupg' 'gpg-agent.conf')
# Git's gpg tools live in its usr/bin, which only Git Bash puts on PATH; the
# elevated run gets the registry PATH, so find them from `git --exec-path`
# (<git>/<mingw64|ucrt64>/libexec/git-core).
let git_usr_bin = (^git --exec-path | str trim | path dirname | path dirname | path dirname | path join 'usr' 'bin')
let gpgconf = ($git_usr_bin | path join 'gpgconf.exe')
# gpgconf prints an MSYS path (/c/Users/...); nu needs the Windows form.
let homedir = (^($git_usr_bin | path join 'cygpath.exe') -w (^$gpgconf --list-dirs homedir | str trim) | str trim)
let target = ($homedir | path join 'gpg-agent.conf')

mkdir $homedir
if ($target | path exists) and ((open --raw $target) == (open --raw $source)) {
    return
}
cp -f $source $target
^$gpgconf --kill gpg-agent
