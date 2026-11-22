#!/usr/bin/env nu

# nvcc looks for cl.exe on PATH and does not use vswhere, so the current MSVC
# Hostx64\x64 bin dir goes on the user PATH. The dir embeds the toolset
# version, so an older entry of the same shape is dropped when it moves.
# --dry-run prints the PATH it would write and writes nothing.
def msvc-bin-dir [] {
    let vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
    let found = if ($vswhere | path exists) {
        (do -i { ^$vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath } | complete).stdout | lines | where ($it | is-not-empty) | get -o 0
    }
    let install = if ($found | is-empty) { 'C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools' } else { $found | str trim }
    let ver_file = ($install | path join 'VC' 'Auxiliary' 'Build' 'Microsoft.VCToolsVersion.default.txt')
    if not ($ver_file | path exists) { return null }
    let ver = (open --raw $ver_file | str trim)
    $install | path join 'VC' 'Tools' 'MSVC' $ver 'bin' 'Hostx64' 'x64'
}

def main [--dry-run] {
    if $nu.os-info.name != windows {
        return
    }

    let dir = (msvc-bin-dir)
    if ($dir == null) or not ($dir | path join 'cl.exe' | path exists) {
        echo $"(ansi yellow)!!(ansi reset) cl.exe not found under the VS Build Tools; skipped the MSVC PATH entry"
        return
    }

    let reg_line = (^reg query 'HKCU\Environment' /v Path | lines | where ($it | str contains 'Path') | first)
    let user_path = ($reg_line | parse --regex 'REG_(?:EXPAND_)?SZ\s+(?<v>.*)' | get v.0)
    let entries = ($user_path | split row ';' | where ($it | is-not-empty))
    let stale = {|p| ($p | str trim --right --char '\') =~ '(?i)\\VC\\Tools\\MSVC\\[^\\]+\\bin\\Hostx64\\x64$' and (($p | str trim --right --char '\') != $dir) }
    let kept = ($entries | where {|p| not (do $stale $p) })
    let missing = not ($kept | any {|p| ($p | str trim --right --char '\') == $dir })
    let dropped = (($entries | length) != ($kept | length))
    let plain_sz = ($reg_line | str contains 'REG_SZ')
    let new_path = (if $missing { $kept | append $dir } else { $kept } | str join ';')
    if $dry_run {
        print $"would add: ($dir)"
        print $"new PATH: ($new_path)"
        return
    }
    if $missing or $dropped or $plain_sz {
        ^reg add 'HKCU\Environment' /v Path /t REG_EXPAND_SZ /d $new_path /f | ignore
        if $missing or $dropped {
            echo $"(ansi yellow)!!(ansi reset) Set ($dir) on the user PATH so nvcc finds cl.exe; new shells see it"
        }
        if $plain_sz {
            echo $"(ansi yellow)!!(ansi reset) The user PATH was REG_SZ and was restored to REG_EXPAND_SZ so %VARS% expand; new shells see it"
        }
    }
}
