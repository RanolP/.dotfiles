#!/usr/bin/env sh
clear
echo "You are now installing RanolP's dotfiles..."
if [[ `uname -s` == 'Linux' ]]; then
    # ref: https://github.com/GuillaumeGomez/sysinfo/blob/43a12462624ce0c97105561775af059c5e4c0e35/src/unix/linux/system.rs#L389-L395
    case `(cat /etc/os-release 2>/dev/null || cat /etc/lsb-release 2>/dev/null) | grep ^ID=` in
    ID=arch)
        echo "Environment : ?Unknown? + Unix Shell"
        ;;
    *)
        echo "Environment : ?Unknown Linux? + Unix Shell"
    esac
else
    echo "Environment : ?Unknown? + Unix Shell"
fi
