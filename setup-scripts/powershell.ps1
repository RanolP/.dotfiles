if ([System.Environment]::OSVersion.Platform -ne 'Win32NT') {
    Write-Output "It does not supports powershell with non-Windows environment. try bash or similar alternatives."
    exit 1
}

Clear-Host
Write-Output "You are now installing RanolP's dotfiles..."