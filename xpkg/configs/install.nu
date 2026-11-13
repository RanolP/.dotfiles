#!/usr/bin/env nu
source ~/.dotfiles/xpkg/utils/normalize.nu
use ~/.dotfiles/xpkg/configs/render.nu [nushell-config mise-config]
use ~/.dotfiles/xpkg/utils/@windows/bootstrap.nu [relaunch-elevated]
use ~/.dotfiles/xpkg/utils/parallel.nu [run-units]

# The elevated process `sudo` relaunches into gets the registry PATH, which has
# no mise install dirs (they only enter PATH through `mise activate` in an
# interactive shell), so a bare `which` misses every mise-managed tool and its
# configs get skipped silently. Ask mise as well.
def installed [tool: string] {
    (not (which $tool | is-empty)) or ((do -i { ^mise which $tool } | complete).exit_code == 0)
}

# Units that only write the registry or powercfg and need nothing a package
# install provides. `rebuild` runs them alongside Packages through `--system`.
def system-units [configs: path] {
    if $nu.os-info.name != windows { return [] }
    [
        {name: keyboard, script: $'($configs)/keyboard/install.nu'}
        {name: lock, script: $'($configs)/lock/install.nu'}
        {name: explorer, script: $'($configs)/explorer/install.nu'}
        {name: theme, script: $'($configs)/theme/install.nu'}
        {name: chrome, script: $'($configs)/chrome/install.nu'}
        {name: audio, script: $'($configs)/audio/install.nu'}
        {name: littlebigmouse, script: $'($configs)/littlebigmouse/install.nu'}
        {name: bin, script: $'($configs)/bin/install.nu'}
    ]
}

# Units that need packages or mise tools in place. gitconfig stays one unit:
# concurrent `git config` writers collide on .gitconfig.lock.
def tool-units [configs: path] {
    let windows = ($nu.os-info.name == windows)
    [
        {name: gitconfig, script: $'($configs)/gitconfig.nu', when: true}
        {name: gnupg, script: $'($configs)/gnupg/install.nu', when: $windows}
        {name: espanso, script: $'($configs)/espanso/install.nu', when: $windows}
        {name: firefox, script: $'($configs)/firefox/install.nu', when: $windows}
        {name: terminal, script: $'($configs)/terminal/install.nu', when: $windows}
        {name: prismlauncher, script: $'($configs)/prismlauncher/install.nu', when: $windows}
        {name: vscode, script: $'($configs)/vscode/install.nu', when: (installed code)}
        {name: claude, script: $'($configs)/claude/install.nu', when: (installed claude)}
        {name: codex, script: $'($configs)/codex/install.nu', when: (installed codex)}
        {name: pi, script: $'($configs)/pi/install.nu', when: (installed pi)}
        {name: opencode, script: $'($configs)/opencode/install.nu', when: (installed opencode)}
    ]
    | where when
    | reject when
}

# Run alone, this applies every config. `rebuild` (xpkg/install.nu) splits it:
# `--system` runs the registry-only units while Packages installs, then
# `--rebuild` runs the rest with Fonts joining the same parallel group.
def main [
    --system   # only the registry/powercfg units
    --rebuild  # skip the --system units and add Fonts to the parallel group
] {
    if ($nu.os-info.name == windows) and (not (is-admin)) {
        relaunch-elevated ~/.dotfiles/xpkg/configs/install.nu
        return
    }

    let configs = $env.FILE_PWD

    if $system {
        if (run-units (system-units $configs) | any { $in.exit_code != 0 }) { exit 1 }
        return
    }

    print $"(ansi purple)>>(ansi reset) Generating nushell configs \(Windows overlay + shared nix\)"
    nushell-config $nu.env-path $nu.config-path

    print $"(ansi purple)>>(ansi reset) Merging mise config \(shared nix + Windows overlay\)"
    mise-config ($nu.home-dir | path join '.config' 'mise' 'config.toml')

    # Writing the config installs nothing; tools the overlay adds (pnpm for the
    # Pi unit, java for Prism Launcher, uv for Fonts) stay missing until this
    # runs. One tool failing should not skip every config after it.
    print $"(ansi purple)>>(ansi reset) Installing mise tools"
    try { ^mise install } catch {|e| print -e $"(ansi red)!!(ansi reset) mise install failed: ($e.msg)" }

    let fonts = if $rebuild and ($nu.os-info.name == windows) {
        [{name: fonts, script: ('~/.dotfiles/xpkg/apps/@fonts/install.nu' | path expand)}]
    } else { [] }
    let units = (
        (if $rebuild { [] } else { system-units $configs })
        ++ (tool-units $configs)
        ++ $fonts
    )
    print $"(ansi purple)>>(ansi reset) Applying ($units | length) units in parallel"
    let failed = (run-units $units | where exit_code != 0)

    if ($nu.os-info.kernel_version | str contains 'WSL2') {
        print $"(ansi purple)>>(ansi reset) Integrating Windows fonts for WSL2"
        do -i { sudo mkdir /etc/fonts/ }
        do -i { sudo ln -s -f $'($configs)/fonts/local.conf' '/etc/fonts/local.conf' }
    }

    if ($failed | is-not-empty) {
        print -e $"(ansi red)!!(ansi reset) failed: ($failed | get name | str join ', ')"
        exit 1
    }
}
