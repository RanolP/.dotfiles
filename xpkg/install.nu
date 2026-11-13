#!/usr/bin/env nu

# xpkg -- the Windows counterpart to `nix`: install packages, then link configs.
# The config *content* lives in ../nix/home/configs (single source of truth);
# this tree carries only the Windows-specific pieces and the install glue.
use ~/.dotfiles/xpkg/utils/@windows/bootstrap.nu [relaunch-elevated refresh-path]
use ~/.dotfiles/xpkg/utils/parallel.nu [run-unit]

if ($nu.os-info.name == windows) and (not (is-admin)) {
    relaunch-elevated ~/.dotfiles/xpkg/install.nu
    return
}

let started = (date now)
let configs = ('~/.dotfiles/xpkg/configs/install.nu' | path expand)

# The registry-only settings need nothing from Packages, so they run in the
# background while Packages keeps the terminal: winget progress and the WSL
# `passwd` prompt need it. Their captured output prints once Packages is done.
let settings = if $nu.os-info.name == windows {
    job spawn { run-unit {name: settings, script: $configs, args: [--system]} | job send 0 }
}

print $"(ansi green)==(ansi reset) Packages"
nu ~/.dotfiles/xpkg/windows/install.nu

# The configs step runs in a child process that inherits this PATH.
if $nu.os-info.name == windows { refresh-path }

if $settings != null {
    let r = (job recv)
    print $"(ansi green)==(ansi reset) Settings \(ran alongside Packages, ($r.secs | math round --precision 1)s\)"
    print ($r.output | str trim --right)
    if $r.exit_code != 0 { print -e $"(ansi red)!!(ansi reset) settings exit ($r.exit_code)" }
}

print $"(ansi green)==(ansi reset) Configs and Fonts"
do -i { nu $configs --rebuild }

print $"(ansi green)==(ansi reset) rebuild done in (((date now) - $started) / 1sec | math round --precision 1)s"
