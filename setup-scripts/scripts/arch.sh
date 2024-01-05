#!/usr/bin/env sh
echo Installing essential packages...
echo You may interfered with several popups.
# Git
echo $ pacman -Sy --noconfirm git
pacman -Sy --noconfirm git
# nushell
echo $ pacman -Sy --noconfirm nushell
pacman -Sy --noconfirm nushell

# run common windows setup script
nu -c "nu -c (http get https://dotfiles.ranolp.dev/setup-scripts/nu.nu)"
