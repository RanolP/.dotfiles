#!/usr/bin/env nu
# Windows Terminal equivalent of nix/home/darwin/programs/ghostty.nix: Nord
# scheme, Iosevka font, nu as the default profile. Merges into the user's
# settings.json and keeps everything else (comments are dropped on rewrite;
# the original is saved once as settings.json.bak).

if $nu.os-info.name != windows { return }

let dir = $'($env.LOCALAPPDATA)\Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState'
let target = $'($dir)\settings.json'
if not ($target | path exists) {
    echo $'(ansi black)Skipped(ansi reset) Windows Terminal settings not found at ($target)'
    return
}

# Palette of arcticicestudio/nord-windows-terminal (ghostty's built-in Nord is the same).
let nord = {
    name: Nord
    cursorColor: '#D8DEE9', selectionBackground: '#434C5E'
    background: '#2E3440', foreground: '#D8DEE9'
    black: '#3B4252', red: '#BF616A', green: '#A3BE8C', yellow: '#EBCB8B'
    blue: '#81A1C1', purple: '#B48EAD', cyan: '#88C0D0', white: '#E5E9F0'
    brightBlack: '#4C566A', brightRed: '#BF616A', brightGreen: '#A3BE8C', brightYellow: '#EBCB8B'
    brightBlue: '#81A1C1', brightPurple: '#B48EAD', brightCyan: '#8FBCBB', brightWhite: '#ECEFF4'
}
# WT auto-generates a "Nushell" profile (source nu) once nu is installed; defaultProfile accepts a name.
let old_nu_guid = '{6e75a3c1-4b0e-5f4a-9d1e-2c7b8a5e0f31}'

# nu's JSON parser tolerates the comments Windows Terminal allows.
let before = (open --raw $target)
let s = ($before | from json)

let font_size = 12
let defaults = ($s.profiles.defaults | upsert colorScheme Nord | upsert font {face: 'IosevkaTerm Nerd Font', size: $font_size})
let list = ($s.profiles.list | where guid != $old_nu_guid)
let schemes = (($s.schemes? | default []) | where name != Nord | append $nord)

let new = ($s
    | upsert schemes $schemes
    | upsert defaultProfile Nushell
    | upsert profiles ($s.profiles | upsert defaults $defaults | upsert list $list)
    | to json --indent 4)

if ($new | str trim) == ($before | str trim) {
    echo $'(ansi black)Unchanged(ansi reset) ($target)'
    return
}
let bak = $'($target).bak'
if not ($bak | path exists) { cp $target $bak }
$new | save -f $target
echo $'     (ansi blue)Updated(ansi reset) ($target)'
