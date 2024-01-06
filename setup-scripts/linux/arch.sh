#!/usr/bin/env sh
echo Installing essential packages...
echo You may interfered with several popups.
# Git
echo $ sudo pacman -Sy --noconfirm git
sudo pacman -Sy --noconfirm git
# nushell
echo $ sudo pacman -Sy --noconfirm nushell
sudo pacman -Sy --noconfirm nushell

# run common windows setup script
nu -c "nu -c (http get https://dotfiles.ranolp.dev/setup-scripts/nu.nu)"
