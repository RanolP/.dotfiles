#!/usr/bin/env nu

# Always show file extensions in Explorer: HideFileExt is the "File name
# extensions" toggle under View > Show. Open Explorer windows pick it up on F5.
if $nu.os-info.name != windows {
    return
}

^reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' /v HideFileExt /t REG_DWORD /d 0 /f | ignore

# Show hidden files and folders (not protected OS files: ShowSuperHidden stays).
^reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' /v Hidden /t REG_DWORD /d 1 /f | ignore
