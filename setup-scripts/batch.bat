@echo off
cls
echo You are now installing RanolP's dotfiles...
echo Environment : Windows + Batch

echo Installing essential packages...
:: Git for Windows
echo $ winget install --exact --id Git.Git
echo y | winget install --exact --id Git.Git
:: nushell
echo $ winget install --exact --id Nushell.Nushell
echo y | winget install --exact --id Nushell.Nushell

:: refresh "Path" env var
echo Refreshing paths for getting "git" and "nu" executable...
for /f "usebackq skip=2 tokens=2,*" %%a in (`%WinDir%\System32\Reg QUERY "HKLM\System\CurrentControlSet\Control\Session Manager\Environment" /v Path`) do (
  for /f "usebackq skip=2 tokens=2,*" %%c in (`%WinDir%\System32\Reg QUERY "HKCU\Environment" /v Path`) do (
    set Path=%%b;%%d
  )
)
