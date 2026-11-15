#!/usr/bin/env nu

# No Keybase at sign-in. `keybase ctl autostart --disable` is Keybase's own
# switch for the service, KBFS and GUI autostart; on Windows it owns the
# `Keybase.Keybase.GUI` value under HKCU\...\Run and the startup shortcuts, so
# the GUI's own setting stays in sync instead of being fought over.
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
