{ config, lib, ... }:
let
  cfg = config.arch.pacman;
  packages = lib.escapeShellArgs cfg.packages;
in
{
  options.arch.pacman.packages = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
  };

  config.home.activation.pacmanPackages = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    missing=()
    for package in ${packages}; do
      if ! /usr/bin/pacman -Q "$package" >/dev/null 2>&1 \
        && ! /usr/bin/pacman -Qg "$package" >/dev/null 2>&1; then
        missing+=("$package")
      fi
    done

    # Refresh the sync db and the keyring before the upgrade, so packages
    # signed by a key newer than the installed keyring still verify.
    echo "     ++ pacman -Sy archlinux-keyring"
    if ! run /usr/bin/sudo /usr/bin/pacman -Sy --needed --noconfirm archlinux-keyring; then
      echo "     !! pacman: run sudo pacman -Sy archlinux-keyring" >&2
      exit 1
    fi
    echo "     ++ pacman -Su ''${missing[*]}"
    if ! run /usr/bin/sudo /usr/bin/pacman -Su --needed --noconfirm "''${missing[@]}"; then
      echo "     !! pacman: run sudo pacman -Su --needed ''${missing[*]}" >&2
      exit 1
    fi
  '';
}
