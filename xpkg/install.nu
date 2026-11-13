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

# Each group's failure is recorded, not thrown, so a failing Packages step
# cannot abort before the settings output is printed; the exit code reports it.
mut failed = []

print $"(ansi green)==(ansi reset) Packages"
let packages_ok = try { nu ~/.dotfiles/xpkg/windows/install.nu; true } catch {|e|
    print -e $"(ansi red)!!(ansi reset) packages failed: ($e.msg)"
    false
}
if not $packages_ok { $failed = ($failed | append packages) }

# The configs step runs in a child process that inherits this PATH.
if $nu.os-info.name == windows { refresh-path }

if $settings != null {
    let r = (job recv)
    print $"(ansi green)==(ansi reset) Settings \(ran alongside Packages, ($r.secs | math round --precision 1)s\)"
    print ($r.output | str trim --right)
    if $r.exit_code != 0 {
        print -e $"(ansi red)!!(ansi reset) settings exit ($r.exit_code)"
        $failed = ($failed | append settings)
    }
}

print $"(ansi green)==(ansi reset) Configs and Fonts"
# Not captured: mise install and the unit blocks stream as they finish.
let configs_ok = try { nu $configs --rebuild; true } catch { false }
if not $configs_ok { $failed = ($failed | append configs) }

print $"(ansi green)==(ansi reset) rebuild done in (((date now) - $started) / 1sec | math round --precision 1)s"
if ($failed | is-not-empty) {
    print -e $"(ansi red)!!(ansi reset) failed: ($failed | str join ', ')"
    exit 1
}
