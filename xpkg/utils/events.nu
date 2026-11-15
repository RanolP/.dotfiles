#!/usr/bin/env nu

# Progress events for the `rebuild` panel (xpkg/utils/panel.py). When
# XPKG_EVENTS names a file, each event appends one JSON line to it; when it is
# unset every call here is a no-op, so plain `rebuild` behaves as before.
#
# Units in par-each emit concurrently. Each event is one short line written by
# a single `save --append`, which NTFS appends whole; that is what keeps two
# events from interleaving, so an event must stay one line.

# Seconds since the Unix epoch, as a float.
export def now [] { (date now | into int) / 1e9 }

# Appends `rec` plus a `t` timestamp as one JSON line to $env.XPKG_EVENTS.
export def emit [rec: record] {
    let file = ($env.XPKG_EVENTS? | default '')
    if ($file | is-empty) { return }
    $"({t: (now)} | merge $rec | to json --raw)\n" | save --append $file
}
