#!/usr/bin/env nu

# Copies user.js into the profile each Firefox install starts with: the
# `Default=` of every [Install...] section in profiles.ini. A copy, not a link,
# so rerun this after editing user.js.
if $nu.os-info.name != windows {
    return
}

let root = ($env.APPDATA | path join Mozilla Firefox)
let ini = ($root | path join profiles.ini)
if not ($ini | path exists) {
    print -e $"(ansi yellow)!!(ansi reset) No ($ini); start Firefox once and rerun"
    return
}

# [ProfileN] sections carry a `Default=1` flag too, so only [Install...] counts.
let profiles = open --raw $ini
    | lines
    | reduce --fold {section: '', paths: []} {|line, acc|
        if ($line | str starts-with '[') {
            $acc | upsert section $line
        } else if ($acc.section | str starts-with '[Install') and ($line | str starts-with 'Default=') {
            $acc | upsert paths ($acc.paths | append ($line | str replace 'Default=' '' | str trim))
        } else {
            $acc
        }
    }
    | get paths
    | uniq

for profile in $profiles {
    let dir = ($root | path join $profile)
    if not ($dir | path exists) {
        print -e $"(ansi yellow)!!(ansi reset) ($dir) is in profiles.ini but missing; skipped"
        continue
    }
    cp -f ($env.FILE_PWD | path join user.js) ($dir | path join user.js)
}

# Add-ons: Firefox enterprise policy, read from <install dir>/distribution/policies.json
# (the Windows counterpart of nix/home/darwin/programs/firefox.nix extensions.packages).
# Program Files is admin-only, so when the copy is denied print the gsudo command instead.
let dist = ($env.ProgramFiles | path join "Firefox Developer Edition" distribution)
let policies = ($env.FILE_PWD | path join policies.json)
if (open $policies | get policies.ExtensionSettings | is-empty) { error make {msg: "policies.json has no ExtensionSettings"} }
try {
    mkdir $dist
    cp -f $policies ($dist | path join policies.json)
} catch {
    print -e $"(ansi yellow)!!(ansi reset) ($dist) needs admin; run: (ansi cyan)gsudo nu ($env.FILE_PWD | path join install.nu)(ansi reset)"
}
