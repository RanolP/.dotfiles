#!/usr/bin/env nu

# OneDrive fully off. The client itself is uninstalled through `remove` in
# xpkg/windows/default.toml; this unit keeps it from coming back and clears what
# the uninstaller leaves behind. Needs an elevated shell (HKLM).
if $nu.os-info.name != windows {
    return
}

# DisableFileSyncNGSC is the "Prevent the usage of OneDrive for file storage"
# policy: a reinstalled or MSIX-shipped client refuses to sync or sign in.
^reg add 'HKLM\SOFTWARE\Policies\Microsoft\Windows\OneDrive' /v DisableFileSyncNGSC /t REG_DWORD /d 1 /f | ignore

# Drop the OneDrive entry from Explorer's navigation pane.
^reg add 'HKCU\Software\Classes\CLSID\{018D5C66-4533-4307-9B53-224DE2ED1FE6}' /v System.IsPinnedToNameSpaceTree /t REG_DWORD /d 0 /f | ignore

# No autostart at sign-in (absent once uninstalled, so a failed delete is fine).
^reg delete 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' /v OneDrive /f | complete | ignore
