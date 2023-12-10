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
