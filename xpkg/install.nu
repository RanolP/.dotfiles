#!/usr/bin/env nu

# xpkg -- the Windows counterpart to `nix`: install packages, then link configs.
# The config *content* lives in ../nix/home/configs (single source of truth);
# this tree carries only the Windows-specific pieces and the install glue.
use ~/.dotfiles/xpkg/utils/@windows/bootstrap.nu [relaunch-elevated refresh-path]
use ~/.dotfiles/xpkg/utils/parallel.nu [run-unit]
use ~/.dotfiles/xpkg/utils/events.nu [emit]
use ~/.dotfiles/xpkg/utils/@windows/wsl.nu [installed-wsl]

# uv's path, from PATH or mise (the elevated relaunch gets the registry PATH,
# which has no mise install dirs); null when neither has it.
def find-uv [] {
    if (which uv | is-not-empty) { return 'uv' }
    let r = (do -i { ^mise which uv } | complete)
    if $r.exit_code == 0 { $r.stdout | str trim } else { null }
}

# True when a [wsl.<distro>] is not installed yet: its first boot asks for a
# password on the terminal, which the panel would hide. A failing wsl.exe
# counts as pending, so the plain path runs.
def wsl-first-boot-pending [] {
    let declared = (open ~/.dotfiles/xpkg/windows/default.toml | get -o wsl | default {} | columns)
    if ($declared | is-empty) { return false }
    let have = (installed-wsl)
    if $have == null { return true }
    $declared | any { $in not-in $have }
}

if ($nu.os-info.name == windows) and (not (is-admin)) {
    nu ~/.dotfiles/xpkg/windows/install.nu --user-scope
    relaunch-elevated ~/.dotfiles/xpkg/install.nu
    return
}

# Show the rebuild panel (xpkg/utils/panel.py): it re-runs this script as its
# child with XPKG_NO_PANEL set, so the child runs the plain path below.
if ($nu.os-info.name == windows) and ($env.XPKG_NO_PANEL? | is-empty) and (is-terminal --stdout) {
    let uv = (find-uv)
    if ($uv != null) and not (wsl-first-boot-pending) {
        let dir = ($nu.temp-dir | path join $"xpkg-rebuild-(date now | format date '%Y%m%d-%H%M%S')")
        mkdir $dir
        let events = ($dir | path join events.jsonl)
        let script = ('~/.dotfiles/xpkg/install.nu' | path expand)
        let panel = ('~/.dotfiles/xpkg/utils/panel.py' | path expand)
        # The panel creates events.log right before it starts the child. With
        # no log, uv or the panel failed first (offline with textual not
        # cached, a crash at startup), so the plain path below still runs.
        # Otherwise the panel's exit code is the child's.
        let code = (with-env {XPKG_NO_PANEL: '1'} {
            try { ^$uv run --quiet --with textual==8.2.8 python $panel $events -- nu $script; 0 } catch {|e| $e.exit_code? | default 1 }
        })
        if ($dir | path join events.log | path exists) { exit $code }
        print -e $"(ansi red)!!(ansi reset) panel did not start \(exit ($code)\); running plain"
    }
}

let started = (date now)
let configs = ('~/.dotfiles/xpkg/configs/install.nu' | path expand)

# The registry-only settings need nothing from Packages, so they run in the
# background while Packages keeps the terminal: winget progress and the WSL
# `passwd` prompt need it. Their captured output prints once Packages is done.
let settings = if $nu.os-info.name == windows {
    emit {ev: group_start, group: Settings}
    # The child's run-units reads XPKG_GROUP and reports each settings unit.
    job spawn { with-env {XPKG_GROUP: Settings} { run-unit {name: settings, script: $configs, args: [--system]} } | job send 0 }
}

# Each group's failure is recorded, not thrown, so a failing Packages step
# cannot abort before the settings output is printed; the exit code reports it.
mut failed = []

print $"(ansi green)==(ansi reset) Packages"
emit {ev: group_start, group: Packages}
let packages_ok = try { nu ~/.dotfiles/xpkg/windows/install.nu; true } catch {|e|
    print -e $"(ansi red)!!(ansi reset) packages failed: ($e.msg)"
    false
}
emit {ev: group_end, group: Packages, ok: $packages_ok}
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
    emit {ev: group_end, group: Settings, ok: ($r.exit_code == 0)}
}

print $"(ansi green)==(ansi reset) Configs and Fonts"
# Not captured: mise install and the unit blocks stream as they finish.
emit {ev: group_start, group: Configs}
let configs_ok = try { with-env {XPKG_GROUP: Configs} { nu $configs --rebuild }; true } catch { false }
emit {ev: group_end, group: Configs, ok: $configs_ok}
if not $configs_ok { $failed = ($failed | append configs) }

print $"(ansi green)==(ansi reset) rebuild done in (((date now) - $started) / 1sec | math round --precision 1)s"
if ($failed | is-not-empty) {
    print -e $"(ansi red)!!(ansi reset) failed: ($failed | str join ', ')"
    exit 1
}
