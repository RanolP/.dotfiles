#!/bin/bash
# Install nix and apply the `ranolp-archwsl` home-manager flake on Arch Linux
# (WSL or bare metal). Every step is idempotent and prints one status line:
# `==` already done, `++` changed, `!!` failed.
#
#   bash arch.sh            # system phase via sudo, then home phase
#   bash arch.sh system     # as root: pacman git+nix, nix-daemon, flakes
#   bash arch.sh home       # as the user: clone ~/.dotfiles, home-manager switch
#   curl -fsSL https://raw.githubusercontent.com/RanolP/.dotfiles/main/xpkg/setup-scripts/linux/arch.sh | bash
#
# Everything lives in functions and `main` runs on the last line, so when the
# script arrives on stdin bash has parsed all of it before any command could
# read stdin; commands still get </dev/null to be safe.
set -euo pipefail

ok() { printf '     == %s\n' "$*"; }
changed() { printf '     ++ %s\n' "$*"; }
die() { printf '     !! %s\n' "$*" >&2; exit 1; }

phase_system() {
  set -euo pipefail
  [ "$(id -u)" -eq 0 ] || die "system phase must run as root"

  if pacman -Q git nix >/dev/null 2>&1; then
    ok "pacman git nix"
  else
    changed "pacman git nix"
    pacman -S --needed --noconfirm git nix </dev/null
  fi

  [ -d /run/systemd/system ] || die "systemd is not running (WSL: set [boot] systemd=true in /etc/wsl.conf, then wsl --terminate)"

  if systemctl is-enabled --quiet nix-daemon.socket && systemctl is-active --quiet nix-daemon.socket; then
    ok "nix-daemon.socket enabled"
  else
    changed "nix-daemon.socket enabled"
    systemctl enable --now nix-daemon.socket
  fi

  local conf=/etc/nix/nix.conf want='experimental-features = nix-command flakes'
  if [ -f "$conf" ] && grep -qxF "$want" "$conf"; then
    ok "$conf flakes"
  else
    changed "$conf flakes"
    mkdir -p /etc/nix
    touch "$conf"
    sed -i '/^[[:space:]]*experimental-features[[:space:]]*=/d' "$conf"
    printf '%s\n' "$want" >>"$conf"
    # Restarts only a running daemon; a socket-activated one reads the new conf.
    systemctl try-restart nix-daemon.service
  fi

  # The Arch package does not create /nix/store; the first store access does.
  if [ -d /nix/store ]; then
    ok "/nix/store"
  else
    changed "/nix/store"
    nix store info </dev/null >/dev/null
    [ -d /nix/store ] || die "/nix/store still missing after 'nix store info'"
  fi
}

phase_home() {
  [ "$(id -u)" -ne 0 ] || die "home phase must run as the normal user, not root"
  command -v nix >/dev/null || die "nix not found; run the system phase first"

  local repo="$HOME/.dotfiles"
  if [ -e "$repo" ]; then
    ok "$repo present (left untouched)"
  else
    changed "git clone $repo"
    git clone https://github.com/RanolP/.dotfiles.git "$repo" </dev/null
  fi

  changed "home-manager switch --flake $repo/nix#ranolp-archwsl"
  nix --extra-experimental-features 'nix-command flakes' \
    run home-manager/master -- switch --flake "$repo/nix#ranolp-archwsl" -b before-hm </dev/null
}

main() {
  case "${1:-}" in
    system) phase_system ;;
    home) phase_home ;;
    "")
      if [ "$(id -u)" -eq 0 ]; then
        die "run as the normal user (system phase uses sudo), or pass 'system'"
      fi
      # Re-invoke from the function source, not "$0": piped, there is no file.
      sudo bash -c "$(declare -f ok changed die phase_system); phase_system"
      phase_home
      ;;
    *) die "usage: arch.sh [system|home]" ;;
  esac
}

main "$@"
