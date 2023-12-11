#!/usr/bin/env nu
def main [cmdline: string] {
    return (^(((which git).path | path dirname | path parse).parent.0 | path join "bin\\bash.exe") -c $cmdline)
}
