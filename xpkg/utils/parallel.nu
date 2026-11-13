#!/usr/bin/env nu

# Runs independent `nu <script>` units at the same time and prints each one as
# a single block when it finishes, so concurrent units never interleave lines.
# Each unit is a record {name: string, script: path, args?: list<string>}.
#
# Output is always captured: a unit's uncaptured stdout inside par-each becomes
# the closure's value and can vanish. ANSI colours a child prints itself survive
# the capture; an external tool the child runs sees a pipe and may drop its own.

# Runs one unit to completion and returns {name, exit_code, secs, output}.
export def run-unit [unit: record] {
    let started = (date now)
    let result = (do -i { ^nu $unit.script ...($unit.args? | default []) o+e>| complete })
    {
        name: $unit.name
        exit_code: $result.exit_code
        secs: (((date now) - $started) / 1sec)
        output: $result.stdout
    }
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
export def run-units [units: list] {
    $units | par-each {|unit|
        let r = (run-unit $unit)
        print-unit $r
        $r
    } | collect
}
