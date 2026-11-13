#!/bin/sh
# The sh branch of the root `setup` polyglot: `curl -fsSL https://dotfiles.ranolp.dev/setup | sh`.
# Everything lives in main, called on the last line, so sh has read the whole
# script before an inner `curl | bash` can touch the shared stdin.
main() {
    os=$(uname -s)
    id=
    if [ "$os" = Linux ] && [ -r /etc/os-release ]; then
        id=$(. /etc/os-release && printf '%s' "$ID")
    fi
    case "$os:$id" in
    Linux:arch)
        curl -fsSL https://dotfiles.ranolp.dev/xpkg/setup-scripts/linux/arch.sh | bash
        ;;
    MINGW*:* | MSYS*:*)
        # Git Bash on Windows: the PowerShell script owns the Windows setup.
        powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://dotfiles.ranolp.dev/xpkg/setup-scripts/windows.ps1 | iex"
        ;;
    *)
        echo "Unsupported environment: $os${id:+ ($id)}. Only Arch Linux and Windows are supported." >&2
        exit 1
        ;;
    esac
}

main "$@"
