#!/usr/bin/env nu

# Distro names from `wsl -l -q`, or null when wsl.exe exits non-zero (no WSL
# feature yet, or the service failed). Captured through `complete` so that
# exit never aborts the caller: an uncaptured non-zero external ends the
# whole `rebuild`. wsl.exe prints UTF-16LE; for ASCII names, stripping the
# NULs leaves the text.
export def installed-wsl [] {
    let r = (do -i { ^wsl.exe -l -q } | complete)
    if $r.exit_code != 0 { return null }
    $r.stdout | str replace -a (char nul) "" | str replace -a "\r" "" | lines | where ($it | is-not-empty)
}
