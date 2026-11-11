#!/usr/bin/env nu

# Dark mode for apps (AppsUseLightTheme) and the system shell (SystemUsesLightTheme).
if $nu.os-info.name != windows {
    return
}

let key = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
^reg add $key /v AppsUseLightTheme /t REG_DWORD /d 0 /f | ignore
^reg add $key /v SystemUsesLightTheme /t REG_DWORD /d 0 /f | ignore
