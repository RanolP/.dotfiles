#!/usr/bin/env nu
export def main [message: string default: bool] {
    if $default {
        print -n $"($message) [Y/n]: "
    } else {
        print -n $"($message) [y/N]: "
    }
    while true {
        let ch = input -sn 1
        if $ch == 'y' {
            print "yes"
            return true
        } else if $ch == 'n' {
            print "no"
            return false
        } else if $ch == '' {
            if $default {
                print "yes"
            } else {
                print "no"
            }
            return $default
        }
    }
}
