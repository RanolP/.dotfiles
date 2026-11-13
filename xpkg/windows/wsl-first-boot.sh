#!/bin/bash
# First-boot setup of a freshly installed WSL Arch distro, run as root.
# Usage: bash -s -- <user>   (script on stdin). Idempotent.
set -euo pipefail
user=$1

# The official image initialises the keyring in its interactive OOBE, which
# `wsl --install --no-launch` + `-u root` skips.
if [ ! -e /etc/pacman.d/gnupg/trustdb.gpg ]; then
  pacman-key --init
  pacman-key --populate archlinux
fi

pacman -Syu --noconfirm --needed sudo

id "$user" >/dev/null 2>&1 || useradd -m -G wheel -s /bin/bash "$user"

install -m 0440 /dev/stdin /etc/sudoers.d/wheel <<< '%wheel ALL=(ALL:ALL) ALL'

cat > /etc/wsl.conf <<WSLCONF
[boot]
systemd=true

[user]
default=$user

[automount]
enabled = true
options = "metadata"
mountFsTab = true
WSLCONF
