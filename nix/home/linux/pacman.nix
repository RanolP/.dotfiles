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

    if [ "''${#missing[@]}" -eq 0 ]; then
      echo "     == pacman ${packages}"
    else
      echo "     ++ pacman ''${missing[*]}"
      if ! run /usr/bin/sudo /usr/bin/pacman -S --needed --noconfirm "''${missing[@]}"; then
        echo "     !! pacman: run sudo pacman -S --needed ''${missing[*]}" >&2
        exit 1
      fi
    fi
  '';
}
