#!/usr/bin/env sh
clear
echo "RanolP's dotfiles use nix on macOS/Linux."
echo "xpkg (the Windows installer) does not apply here."
echo
echo "Set this machine up with nix:"
echo "  1. Install nix:"
echo "     sh <(curl --proto '=https' --tlsv1.2 -L https://nixos.org/nix/install)"
echo "  2. Clone the dotfiles:"
echo "     git clone https://github.com/RanolP/.dotfiles.git ~/.dotfiles"
echo "  3. Apply the flake:"
echo "     # macOS: sudo nix run nix-darwin -- switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26"
echo "     # Linux: nix run home-manager -- switch --flake ~/.dotfiles/nix#ranolp-archwsl -b before-hm"
echo
echo "See https://dotfiles.ranolp.dev for the full guide."
