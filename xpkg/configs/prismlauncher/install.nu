#!/usr/bin/env nu

# Point Prism Launcher's global Java at the mise-managed JDK. The version comes
# from the `java` pin in the Windows mise overlay, through mise's stable
# `installs/java/<pin>` symlink, so a patch upgrade needs no edit here. Only the
# JavaPath line changes; Prism re-probes the version when its cached
# JavaSignature stops matching. Prism rewrites the cfg on exit, so a running
# instance would overwrite this.
if $nu.os-info.name != windows {
    return
}

let cfg = ($env.APPDATA | path join PrismLauncher prismlauncher.cfg)
if not ($cfg | path exists) {
    print $"     (ansi dark_gray)==(ansi reset) no ($cfg); start Prism Launcher once, then re-run"
    return
}
if (ps | where name =~ '(?i)^prismlauncher' | is-not-empty) {
    print $"     (ansi yellow)!!(ansi reset) Prism Launcher is running; quit it first or it overwrites JavaPath on exit"
    return
}

let pin = (open ($env.FILE_PWD | path join .. mise config.toml) | get tools.java)
let java = ($env.LOCALAPPDATA | path join mise installs java $pin bin java.exe | str replace -a '\' '/')
let line = $"JavaPath=($java)"

let lines = (open --raw $cfg | lines)
let updated = if ($lines | any {|l| $l starts-with 'JavaPath=' }) {
    $lines | each {|l| if ($l starts-with 'JavaPath=') { $line } else { $l } }
} else {
    # Keys live under [General], the file's first section.
    $lines | insert 1 $line
}
# Prism writes CRLF.
$updated | str join "\r\n" | $"($in)\r\n" | save -f $cfg
print $"     (ansi green)++(ansi reset) ($line)"
