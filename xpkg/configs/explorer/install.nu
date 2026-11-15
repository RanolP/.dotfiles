#!/usr/bin/env nu

# Always show file extensions in Explorer: HideFileExt is the "File name
# extensions" toggle under View > Show. Open Explorer windows pick it up on F5.
if $nu.os-info.name != windows {
    return
}

^reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' /v HideFileExt /t REG_DWORD /d 0 /f | ignore

# Show hidden files and folders (not protected OS files: ShowSuperHidden stays).
^reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' /v Hidden /t REG_DWORD /d 1 /f | ignore

# Hide desktop icons: HideIcons is the desktop right-click View > "Show desktop
# icons" toggle. Takes effect after Explorer restarts or the next sign-in.
^reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' /v HideIcons /t REG_DWORD /d 1 /f | ignore
