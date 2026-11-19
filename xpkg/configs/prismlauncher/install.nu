#!/usr/bin/env nu

# Force Prism Launcher onto the mise-managed JDK. The version comes from the
# `java` pin in the Windows mise overlay, through mise's stable
# `installs/java/<pin>` symlink, so a patch upgrade needs no edit here. The
# global cfg gets JavaPath plus AutomaticJavaDownload/AutomaticJavaSwitch off
# (Application.cpp registers both), every instance drops its own Java
# (OverrideJavaLocation=false, AutomaticJava=false, no JavaPath) so it inherits
# the global one, and Prism's downloaded runtime dir is deleted. Prism
# re-probes the version when its cached JavaSignature stops matching. Prism
# rewrites its cfgs on exit, so a running instance would overwrite this.
if $nu.os-info.name != windows {
    return
}

let prism = ($env.APPDATA | path join PrismLauncher)
let cfg = ($prism | path join prismlauncher.cfg)
if not ($cfg | path exists) {
    print $"     (ansi dark_gray)==(ansi reset) no ($cfg); start Prism Launcher once, then re-run"
    return
}
if (ps | where name =~ '(?i)^prismlauncher' | is-not-empty) {
    print $"     (ansi yellow)!!(ansi reset) Prism Launcher is running; quit it first or it overwrites its cfgs on exit"
    return
}

# Set `key=value` in a cfg, replacing the line or adding it under [General],
# the file's first section. Prism writes CRLF.
def set-key [cfg: string, key: string, value: string] {
    let line = $"($key)=($value)"
    let lines = (open --raw $cfg | lines)
    let updated = if ($lines | any {|l| $l starts-with $"($key)=" }) {
        $lines | each {|l| if ($l starts-with $"($key)=") { $line } else { $l } }
    } else {
        $lines | insert 1 $line
    }
    $updated | str join "\r\n" | $"($in)\r\n" | save -f $cfg
    print $"     (ansi green)++(ansi reset) ($cfg | path basename): ($line)"
}

# The pin is a version string, or a table whose `version` is the pin.
let tool = (open ($env.FILE_PWD | path join .. mise config.toml) | get tools.java)
let pin = if ($tool | describe | str starts-with record) { $tool.version } else { $tool }
let java = ($env.LOCALAPPDATA | path join mise installs java $pin bin java.exe | str replace -a '\' '/')

set-key $cfg JavaPath $java
set-key $cfg AutomaticJavaDownload "false"
set-key $cfg AutomaticJavaSwitch "false"

for dir in (glob ($prism | path join instances * instance.cfg)) {
    set-key $dir OverrideJavaLocation "false"
    set-key $dir AutomaticJava "false"
    let kept = (open --raw $dir | lines | where {|l| not ($l starts-with 'JavaPath=') })
    $kept | str join "\r\n" | $"($in)\r\n" | save -f $dir
    print $"     (ansi green)++(ansi reset) ($dir | path dirname | path basename): JavaPath removed"
}

let runtimes = ($prism | path join java)
if ($runtimes | path exists) {
    rm -rf $runtimes
    print $"     (ansi green)++(ansi reset) removed ($runtimes)"
}
