#!/usr/bin/env nu

# Little Big Mouse keeps its whole calibration (monitor sizes, positions, borders,
# options) under HKCU\SOFTWARE\Mgth\LittleBigMouse. littlebigmouse.reg is a
# regedit export of that key, so a fresh machine gets the measured layout back.
# A layout is keyed by the set of connected monitors: it applies only where the
# same monitors are attached. After recalibrating in the app, re-export with
#   reg export "HKCU\SOFTWARE\Mgth\LittleBigMouse" <this dir>\littlebigmouse.reg /y
if $nu.os-info.name != windows {
    return
}

let reg = ($env.FILE_PWD | path join 'littlebigmouse.reg')
if not ($reg | path exists) {
    print $"     (ansi yellow)[!](ansi reset) no ($reg) yet: calibrate in the app, then export it"
    return
}

^reg import $reg
