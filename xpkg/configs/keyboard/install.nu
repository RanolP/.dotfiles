#!/usr/bin/env nu

# Korean 103/106-key hardware layout (한/영 and 한자 as their own keys instead
# of Right Alt / Right Ctrl). The i8042prt values only reach PS/2 keyboards;
# kbdhid, which drives every USB/Bluetooth keyboard, reads the per-device
# KeyboardTypeOverride/KeyboardSubtypeOverride instead and otherwise reports
# type 4 (101-key). Both are written, for every keyboard Windows has seen, so
# a keyboard plugged in later picks it up on the next rebuild. Takes effect
# after the keyboard is replugged or the machine restarts.
if $nu.os-info.name != windows {
    return
}

let i8042 = 'HKLM\SYSTEM\CurrentControlSet\Services\i8042prt\Parameters'
for v in [
    [name type value];
    ['LayerDriver KOR' REG_SZ kbd103.dll]
    [OverrideKeyboardIdentifier REG_SZ PCAT_103KEY]
    [OverrideKeyboardType REG_DWORD '8']
    [OverrideKeyboardSubtype REG_DWORD '6']
] {
    ^reg add $i8042 /v $v.name /t $v.type /d $v.value /f | ignore
}

let devices = (
    ^powershell.exe -NoProfile -Command '(Get-PnpDevice -Class Keyboard).InstanceId'
    | lines
    | where {|id| $id starts-with 'HID\' }
)
echo $"     (ansi blue)Set(ansi reset) Korean 103-key type on ($devices | length) HID keyboard\(s\)"
for id in $devices {
    let key = $'HKLM\SYSTEM\CurrentControlSet\Enum\($id)\Device Parameters'
    ^reg add $key /v KeyboardTypeOverride /t REG_DWORD /d 8 /f | ignore
    ^reg add $key /v KeyboardSubtypeOverride /t REG_DWORD /d 6 /f | ignore
}
