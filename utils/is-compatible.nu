#!/usr/bin/env nu
export def main [path: string] {
    if ($path | is-empty) {
        return true
    }
    let parsed = ($path | path parse)
    if ($parsed.stem | str starts-with '@') {
        match $parsed.stem {
            @windows => {
                if $nu.os-info.name != windows {
                    return false
                }
            }
            @linux => {
                if $nu.os-info.name != linux {
                    return false
                }
            }
            @macos => {
                # @todo
            }
            @unix => {
                if $nu.os-info.family != unix {
                    return false
                }
            }
        }
    }
    return (main $parsed.parent)
}
