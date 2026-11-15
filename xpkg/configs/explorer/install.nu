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

# No recency-based lists in Start or Explorer. Start_TrackDocs is Settings >
# Personalization > Start "Show recently opened items in Start, Jump Lists, and
# File Explorer"; Start_TrackProgs is "Show most used apps"; ShowRecent and
# ShowFrequent are Explorer's Folder Options "Show recently used files" and
# "Show frequently used folders" (Home / Quick Access).
^reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' /v Start_TrackDocs /t REG_DWORD /d 0 /f | ignore
^reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced' /v Start_TrackProgs /t REG_DWORD /d 0 /f | ignore
^reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer' /v ShowRecent /t REG_DWORD /d 0 /f | ignore
^reg add 'HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer' /v ShowFrequent /t REG_DWORD /d 0 /f | ignore

# "Show recently added apps" in Start has no per-user value; the policy is HKLM
# (configs/install.nu runs elevated).
^reg add 'HKLM\SOFTWARE\Policies\Microsoft\Windows\Explorer' /v HideRecentlyAddedApps /t REG_DWORD /d 1 /f | ignore
