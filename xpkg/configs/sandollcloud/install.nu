#!/usr/bin/env nu

# The SandollCloud installer creates its Start Menu shortcut only from a
# checkbox on its finish page (.onInstSuccess reads ioSpecial.ini "Field 8"),
# and the `/S` install in xpkg/windows/default.toml never shows that page, so
# the shortcut is made here: the same %APPDATA% Start Menu path and target the
# installer uses.
if $nu.os-info.name != windows {
    return
}

let exe = 'C:\Program Files\SandollCloud\SandollCloud.exe'
if not ($exe | path exists) {
    print $"     (ansi dark_gray)==(ansi reset) no ($exe); SandollCloud not installed yet"
    return
}

let lnk = ($env.APPDATA | path join Microsoft Windows 'Start Menu' Programs SandollCloud.lnk)
if ($lnk | path exists) {
    print $"(ansi dark_gray)==(ansi reset) ($lnk)"
    return
}

let ps = $"$s = \(New-Object -ComObject WScript.Shell\).CreateShortcut\('($lnk)'\); $s.TargetPath = '($exe)'; $s.WorkingDirectory = '($exe | path dirname)'; $s.Save\(\)"
let r = (^powershell -NoProfile -NonInteractive -Command $ps | complete)
if $r.exit_code != 0 {
    print -e $"(ansi red)!!(ansi reset) Start Menu shortcut exit ($r.exit_code): ($r.stdout) ($r.stderr)"
    exit 1
}
print $"(ansi green)++(ansi reset) ($lnk)"
