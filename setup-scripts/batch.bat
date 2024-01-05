@echo off
cls
echo You are now installing RanolP's dotfiles...
echo Environment : Windows + Batch

echo Installing essential packages...
echo You may interfered with several popups.
:: Git for Windows
echo $ winget install --exact --id Git.Git
echo y | winget install --exact --id Git.Git
:: nushell
echo $ winget install --exact --id Nushell.Nushell
echo y | winget install --exact --id Nushell.Nushell
:: uutils coreutils
echo $ winget install --exact --id uutils.coreutils
echo y | winget install --exact --id uutils.coreutils
:: gsudo
echo $ winget install --exact --id gerardog.gsudo
echo y | winget install --exact --id gerardog.gsudo

:: refresh "Path" env var
echo Refreshing paths for getting "git" and "nu" executable...
curl -L dotfiles.ranolp.dev/utils/@windows/refresh-path.bat > %Temp%\refresh-path.bat
call %Temp%\refresh-path.bat

:: run common windows setup script
nu -c "nu -c (http get https://dotfiles.ranolp.dev/setup-scripts/nu.nu)"
