#!/usr/bin/env sh
echo Installing essential packages...
echo You may interfered with several popups.
# Git
echo $ sudo pacman -Sy --noconfirm git
sudo pacman -Sy --noconfirm git
# nushell
echo $ sudo pacman -Sy --noconfirm nushell
sudo pacman -Sy --noconfirm nushell
# paru
echo $ # Install paru
echo $ sudo pacman -Sy --noconfirm --needed base-devel
sudo pacman -Sy --noconfirm --needed base-devel
git clone https://aur.archlinux.org/paru.git
(cd paru; makepkg -si)
rm -rf paru

# run common windows setup script
nu -c "nu -c (http get https://dotfiles.ranolp.dev/setup-scripts/nu.nu)"
