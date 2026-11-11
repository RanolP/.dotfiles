#!/usr/bin/env nu

# User shims in ~/bin, the directory Git Bash already puts on PATH (Claude's
# Bash tool) and which this step adds to the user PATH for nushell and cmd.
# Each shim is a pair: an extensionless sh script for Git Bash and a .cmd for
# nushell/cmd, because Windows ignores shebangs. They mirror the nix-installed
# ~/.local/bin tools: fast-apply, copy-sync-check, jira, notion. figma-cli is
# left out: it reads its token from the macOS keychain (`security`).
if $nu.os-info.name != windows {
    return
}

let bin = ($nu.home-dir | path join 'bin')
mkdir $bin

# name: [sh body, cmd body]. Repo paths hang off $HOME / %USERPROFILE%.
let dot = '.dotfiles/nix/home/configs'
let shims = {
    fast-apply: [$'PYTHONUTF8=1 exec python "$HOME/($dot)/bin/fast-apply" "$@"', $'@set PYTHONUTF8=1&& python "%USERPROFILE%\($dot | str replace --all '/' '\')\bin\fast-apply" %*']
    copy-sync-check: [$'PYTHONUTF8=1 exec python "$HOME/($dot)/bin/copy-sync-check" "$@"', $'@set PYTHONUTF8=1&& python "%USERPROFILE%\($dot | str replace --all '/' '\')\bin\copy-sync-check" %*']
    jira: [$'PYTHONUTF8=1 exec uv run --script "$HOME/($dot)/jira-cli/jira.py" "$@"', $'@set PYTHONUTF8=1&& uv run --script "%USERPROFILE%\($dot | str replace --all '/' '\')\jira-cli\jira.py" %*']
    notion: [
        "echo \"notion: the official command is 'ntn' -- this is a local shim. Use 'ntn' next time.\" >&2\nexec ntn \"$@\""
        "@echo notion: the official command is 'ntn' -- this is a local shim. Use 'ntn' next time. 1>&2\n@ntn %*"
    ]
}

mut changed = false
for name in ($shims | columns) {
    let sh = $"#!/bin/sh\n(($shims | get $name).0)\n"
    let cmd = ($"@echo off\n(($shims | get $name).1)\n" | str replace --all "\n" "\r\n")
    for pair in [[($bin | path join $name) $sh] [($bin | path join $"($name).cmd") $cmd]] {
        if not ($pair.0 | path exists) or ((open --raw $pair.0) != $pair.1) {
            $pair.1 | save -f --raw $pair.0
            $changed = true
        }
    }
}

let user_path = (^reg query 'HKCU\Environment' /v Path | lines | where ($it | str contains 'Path') | first | parse --regex 'REG_(?:EXPAND_)?SZ\s+(?<v>.*)' | get v.0)
if not ($user_path | split row ';' | any {|p| ($p | str trim --right --char '\') == $bin }) {
    ^reg add 'HKCU\Environment' /v Path /t REG_EXPAND_SZ /d $"($user_path);($bin)" /f | ignore
    echo $"(ansi yellow)!!(ansi reset) Added ($bin) to the user PATH; new shells see it"
}
