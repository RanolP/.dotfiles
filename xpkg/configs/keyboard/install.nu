#!/usr/bin/env nu

# Korean 101-key type 1 hardware layout (한/영 on Right Alt, 한자 on Right
# Ctrl). The i8042prt values only reach PS/2 keyboards; kbdhid, which drives
# every USB/Bluetooth keyboard, reads the per-device
# KeyboardTypeOverride/KeyboardSubtypeOverride instead and otherwise reports
# type 4 (101-key). Both are written, for every keyboard Windows has seen, so
# a keyboard plugged in later picks it up on the next rebuild. Takes effect
# after the keyboard is replugged or the machine restarts.
if $nu.os-info.name != windows {
    return
}

# Name -> data of one key's values ({} when the key is missing); DWORDs come
# back as ints so they compare with the wanted value.
def reg-values [key: string] {
    let r = (^reg query $key | complete)
    if $r.exit_code != 0 { return {} }
    $r.stdout
    | lines
    | parse --regex '^\s+(?<name>.+?)\s+(?<type>REG_\w+)\s*(?<data>.*)$'
    | reduce --fold {} {|it, acc|
        $acc | upsert $it.name (if $it.type == REG_DWORD { $it.data | into int } else { $it.data })
    }
}

# reg add only the values that differ; each spawn is a process per value.
def reg-set [key: string, wanted: list] {
    let cur = (reg-values $key)
    for v in $wanted {
        let want = if $v.type == REG_DWORD { $v.value | into int } else { $v.value }
        if ($cur | get -o $v.name) != $want {
            ^reg add $key /v $v.name /t $v.type /d $v.value /f | ignore
        }
    }
}

let i8042 = 'HKLM\SYSTEM\CurrentControlSet\Services\i8042prt\Parameters'
reg-set $i8042 [
    [name type value];
    ['LayerDriver KOR' REG_SZ kbd101a.dll]
    [OverrideKeyboardIdentifier REG_SZ PCAT_101AKEY]
    [OverrideKeyboardType REG_DWORD '8']
    [OverrideKeyboardSubtype REG_DWORD '3']
]

# Class GUID {4d36e96b-...} is the Keyboard setup class. The Enum\HID registry
# read finds the same devices as Get-PnpDevice -Class Keyboard (checked: the
# same 9 InstanceIds) without the 1.5 s PowerShell launch.
let devices = (
    ^reg query 'HKLM\SYSTEM\CurrentControlSet\Enum\HID' /s /v ClassGUID
    | lines
    | each {|l| $l | str trim }
    | window 2
    | where {|w| ($w.0 starts-with 'HKEY_') and ($w.1 =~ '(?i)^ClassGUID\s+REG_SZ\s+\{4d36e96b-e325-11ce-bfc1-08002be10318\}') }
    | each {|w| $w.0 | str replace 'HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Enum\' '' }
)
echo $"     (ansi blue)Set(ansi reset) Korean 101-key type 1 on ($devices | length) HID keyboard\(s\)"
for id in $devices {
    reg-set $'HKLM\SYSTEM\CurrentControlSet\Enum\($id)\Device Parameters' [
        [name type value];
        [KeyboardTypeOverride REG_DWORD '8']
        [KeyboardSubtypeOverride REG_DWORD '3']
    ]
}
