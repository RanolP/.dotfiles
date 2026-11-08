#!/usr/bin/env nu

# Relaunches `script` elevated through gsudo, installing gsudo first on a fresh
# machine. Not `sudo`: inside nu it resolves to C:\Windows\system32\sudo.exe,
# which Windows ships disabled.
export def relaunch-elevated [script: path] {
    print $"(ansi yellow)!!(ansi reset) Relaunch ($script) with admin privileges"
    let gsudo = ($env.ProgramFiles | path join gsudo Current gsudo.exe)
    if not ($gsudo | path exists) {
        print $"(ansi purple)>>(ansi reset) Installing gsudo"
        ^winget install --exact --id gerardog.gsudo --source winget --accept-package-agreements --accept-source-agreements
    }
    ^$gsudo nu $script
}

# Adds the registry PATH entries this process does not have yet. winget writes
# a new package's dir into the registry only, so without this every tool the
# package step just installed (mise, code, coreutils) is invisible to the rest
# of the same run.
export def --env refresh-path [] {
    let registry = (
        [
            (registry query --hklm 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' Path)
            (registry query --hkcu Environment Path)
        ]
        | get value
        | split row ';'
        | each { str trim --right --char '\' }
        | where { is-not-empty }
    )
    let current = ($env.PATH | each { str trim --right --char '\' })
    $env.PATH = ($env.PATH ++ ($registry | uniq | where { $in not-in $current }))
}
