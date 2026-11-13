#!/usr/bin/env nu

# Audio enhancements off on the 7Ryms SR-USB Mini microphone, which takes Voice
# Clarity and Voice Focus with it. The Settings > Sound > <mic> > Audio
# enhancements toggle writes PKEY_AudioEndpoint_Disable_SysFx
# ({1da5d803-...},5 = 1) into the endpoint's FxProperties; nothing else
# changes. The endpoint GUID is per machine and per port, so the endpoint is
# found by its device name ({b3f8fa53-...},6 under Properties).
#
# FxProperties grants Administrators and Users only SetValue, and `reg add`
# asks for more, so it is refused even elevated. Opening the key for SetValue
# alone works without admin.
if $nu.os-info.name != windows {
    return
}

let capture = 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Capture'
let endpoints = ^reg query $capture /s /d /f '7Ryms'
    | lines
    | where ($it | str ends-with '\Properties')
    | each { str replace 'HKEY_LOCAL_MACHINE\' '' | str replace --regex '\\Properties$' '\FxProperties' }

if ($endpoints | is-empty) {
    print -e $"(ansi yellow)!!(ansi reset) No 7Ryms microphone under ($capture); plug it in and rerun"
    return
}

const sysfx = '{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5'
for fx in $endpoints {
    # Already 1: skip the PowerShell launch (~0.8 s per endpoint).
    let cur = (^reg query $'HKLM\($fx)' /v $sysfx | complete)
    if $cur.exit_code == 0 and ($cur.stdout =~ 'REG_DWORD\s+0x1\s') {
        continue
    }
    ^powershell -NoProfile -Command $"
        $ErrorActionPreference = 'Stop'
        $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey\('($fx)', 'ReadWriteSubTree', 'SetValue'\)
        $key.SetValue\('($sysfx)', 1, 'DWord'\)
        $key.Close\(\)
    "
}
