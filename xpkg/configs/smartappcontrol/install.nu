#!/usr/bin/env nu

# Smart App Control off: it blocks unsigned python/node dev tools. SAC has no
# per-app exceptions, and turning it off cannot be undone short of reinstalling
# Windows. VerifiedAndReputablePolicyState is 0 off, 1 on, 2 evaluation; the
# change takes effect after a reboot. Needs an elevated shell (HKLM).
if $nu.os-info.name != windows {
    return
}

let key = 'HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy'
let name = 'VerifiedAndReputablePolicyState'

let cur = (^reg query $key /v $name | complete)
if $cur.exit_code == 0 and ($cur.stdout =~ '(?m)REG_DWORD\s+0x0\s*$') {
    print $"(ansi green)==(ansi reset) Smart App Control already off"
    return
}

let r = (^reg add $key /v $name /t REG_DWORD /d 0 /f | complete)
if $r.exit_code != 0 {
    print -e $"(ansi red)!!(ansi reset) Smart App Control: could not write ($key)\\($name): ($r.stdout) ($r.stderr)"
    return
}
print $"(ansi yellow)++(ansi reset) Smart App Control off; applies after a reboot"
