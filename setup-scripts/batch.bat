@echo off
cls
echo You are now installing RanolP's dotfiles...
echo Environment : Windows + Batch

echo Installing essential packages...
:: Git for Windows
winget install --exact --id Git.Git
winget install --exact --id Nushell.Nushell
