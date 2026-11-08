#!/usr/bin/env nu
export alias ln = coreutils ln

# Git for Windows' own gpg, the one git signs with; it is not on the Windows
# PATH. Called directly rather than through bash so piped input reaches it
# (`keybase pgp export | gpg --import`).
export def --wrapped gpg [...args] {
    let input = $in
    # --exec-path is <git root>\<mingw64|ucrt64>\libexec\git-core whichever
    # git.exe PATH finds first.
    let root = (^git --exec-path | str trim | path dirname | path dirname | path dirname)
    $input | ^($root | path join usr bin gpg.exe) ...$args
}
