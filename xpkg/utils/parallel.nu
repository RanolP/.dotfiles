#!/usr/bin/env nu

# Runs independent `nu <script>` units at the same time and prints each one as
# a single block when it finishes, so concurrent units never interleave lines.
# Each unit is a record {name: string, script: path, args?: list<string>}.
#
# Output is always captured: a unit's uncaptured stdout inside par-each becomes
# the closure's value and can vanish. ANSI colours a child prints itself survive
# the capture; an external tool the child runs sees a pipe and may drop its own.
#
# With a group name, each unit also reports its start and finish through
# ./events.nu for the `rebuild` panel; without one, nothing is emitted.
use ~/.dotfiles/xpkg/utils/events.nu [emit]

# Runs one unit to completion and returns {name, exit_code, secs, output}.
export def run-unit [unit: record, --group: string] {
    if $group != null { emit {ev: unit_start, group: $group, unit: $unit.name} }
    let started = (date now)
    let result = (do -i { ^nu $unit.script ...($unit.args? | default []) o+e>| complete })
    let r = {
        name: $unit.name
        exit_code: $result.exit_code
        secs: (((date now) - $started) / 1sec)
        output: $result.stdout
    }
    if $group != null {
        emit {ev: unit_end, group: $group, unit: $r.name, exit_code: $r.exit_code, secs: $r.secs, output: $r.output}
    }
    $r
}

# Prints one finished unit: a green `ok` or red `!!` header, then its output
# indented 6 spaces, all in one `print` so the block stays contiguous.
export def print-unit [r: record] {
    let header = if $r.exit_code == 0 {
        $"   (ansi green)ok(ansi reset) ($r.name)  ($r.secs | math round --precision 1)s"
    } else {
        $"   (ansi red)!!(ansi reset) ($r.name)  exit ($r.exit_code)"
    }
    let body = ($r.output | str trim --right | lines | each {|line| $"      ($line)" })
    print ([$header ...$body] | str join "\n")
}

# Runs every unit concurrently, printing each as it finishes. Returns the
# results so the caller can tell whether any failed. Collected before return:
# par-each streams, so a short-circuiting consumer such as `any` would stop at
# the first failure and the process could exit before slower units finish.
# The group defaults to $env.XPKG_GROUP, which xpkg/install.nu sets for the
# child that calls this.
export def run-units [units: list, --group: string] {
    let group = ($group | default $env.XPKG_GROUP?)
    if $group != null { for unit in $units { emit {ev: unit_wait, group: $group, unit: $unit.name} } }
    $units | par-each {|unit|
        let r = (run-unit $unit --group=$group)
        print-unit $r
        $r
    } | collect
}
