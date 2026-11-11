#!/usr/bin/env nu
source ~/.dotfiles/xpkg/utils/normalize.nu
use ~/.dotfiles/xpkg/configs/render.nu [nushell-config mise-config]
use ~/.dotfiles/xpkg/utils/@windows/bootstrap.nu [relaunch-elevated]

if ($nu.os-info.name == windows) and (not (is-admin)) {
    relaunch-elevated ~/.dotfiles/xpkg/configs/install.nu
    return
}

let configs = $env.FILE_PWD

# The elevated process `sudo` relaunches into gets the registry PATH, which has
# no mise install dirs (they only enter PATH through `mise activate` in an
# interactive shell), so a bare `which` misses every mise-managed tool and its
# configs get skipped silently. Ask mise as well.
def installed [tool: string] {
    (not (which $tool | is-empty)) or ((do -i { ^mise which $tool } | complete).exit_code == 0)
}

echo $"(ansi purple)>>(ansi reset) Generating nushell configs \(Windows overlay + shared nix\)"
nushell-config $nu.env-path $nu.config-path

echo $"(ansi purple)>>(ansi reset) Merging mise config \(shared nix + Windows overlay\)"
mise-config ($nu.home-dir | path join '.config' 'mise' 'config.toml')

# Writing the config installs nothing; tools the overlay adds (pnpm for the Pi
# step below) stay missing until this runs. One tool failing should not skip
# every config after it.
echo $"(ansi purple)>>(ansi reset) Installing mise tools"
try { ^mise install } catch {|e| print -e $"(ansi red)!!(ansi reset) mise install failed: ($e.msg)" }

echo $"(ansi purple)>>(ansi reset) Updating .gitconfig"
nu $'($configs)/gitconfig.nu'

if $nu.os-info.name == windows {
    echo $"(ansi purple)>>(ansi reset) Setting the Korean 103-key keyboard type"
    nu $'($configs)/keyboard/install.nu'

    echo $"(ansi purple)>>(ansi reset) Turning off the automatic sign-in lock"
    nu $'($configs)/lock/install.nu'

    echo $"(ansi purple)>>(ansi reset) Showing file extensions in Explorer"
    nu $'($configs)/explorer/install.nu'

    echo $"(ansi purple)>>(ansi reset) Switching Windows to dark mode"
    nu $'($configs)/theme/install.nu'

    echo $"(ansi purple)>>(ansi reset) Installing user shims in ~/bin"
    nu $'($configs)/bin/install.nu'

    echo $"(ansi purple)>>(ansi reset) Setting the gpg-agent cache"
    nu $'($configs)/gnupg/install.nu'

    echo $"(ansi purple)>>(ansi reset) Installing espanso match packages"
    nu $'($configs)/espanso/install.nu'

    echo $"(ansi purple)>>(ansi reset) Force-installing the Chrome extension by policy"
    nu $'($configs)/chrome/install.nu'

    echo $"(ansi purple)>>(ansi reset) Turning off microphone audio enhancements"
    nu $'($configs)/audio/install.nu'

    echo $"(ansi purple)>>(ansi reset) Setting Firefox fonts"
    nu $'($configs)/firefox/install.nu'

    echo $"(ansi purple)>>(ansi reset) Restoring the Little Big Mouse calibration"
    nu $'($configs)/littlebigmouse/install.nu'

    echo $"(ansi purple)>>(ansi reset) Pointing Prism Launcher at the mise JDK"
    nu $'($configs)/prismlauncher/install.nu'
}

if (installed code) {
    echo $"(ansi purple)>>(ansi reset) Symlinking VS Code settings"
    nu $'($configs)/vscode/install.nu'
}

if (installed claude) {
    echo $"(ansi purple)>>(ansi reset) Installing Claude Code configs"
    nu $'($configs)/claude/install.nu'
}

if (installed codex) {
    echo $"(ansi purple)>>(ansi reset) Installing Codex configs"
    nu $'($configs)/codex/install.nu'
}

if (installed pi) {
    echo $"(ansi purple)>>(ansi reset) Installing Pi configs"
    nu $'($configs)/pi/install.nu'
}

if (installed opencode) {
    echo $"(ansi purple)>>(ansi reset) Installing opencode configs"
    nu $'($configs)/opencode/install.nu'
}

if ($nu.os-info.kernel_version | str contains 'WSL2') {
    echo $"(ansi purple)>>(ansi reset) Integrating Windows fonts for WSL2"
    do -i { sudo mkdir /etc/fonts/ }
    do -i { sudo ln -s -f $'($configs)/fonts/local.conf' '/etc/fonts/local.conf' }
}
