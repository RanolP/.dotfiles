#!/usr/bin/env nu

# No Keybase at sign-in. `keybase ctl autostart --disable` deletes the
# `Keybase.Keybase.GUI` value under HKCU\...\Run (the GUI starts the service and
# KBFS), the same value the GUI's "open on startup" setting reads, so the two
# stay in sync. It runs with NoFork, so it never spawns an elevated service.
if $nu.os-info.name != windows {
    return
}

let kb = ($env.LOCALAPPDATA | path join Keybase keybase.exe)
if not ($kb | path exists) {
    print $"     (ansi dark_gray)==(ansi reset) no ($kb); Keybase not installed yet"
    return
}

let r = (^$kb ctl autostart --disable | complete)
if $r.exit_code != 0 {
    print -e $"(ansi red)!!(ansi reset) keybase ctl autostart --disable exit ($r.exit_code): ($r.stdout) ($r.stderr)"
    exit 1
}
print $"(ansi green)==(ansi reset) Keybase autostart off"
