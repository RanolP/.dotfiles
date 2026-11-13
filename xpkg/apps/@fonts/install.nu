#!/usr/bin/env nu

# Downloads every font in fonts.toml into .fonts/<name>/extracted, then on
# Windows installs it for the current user: the file goes to
# %LOCALAPPDATA%\Microsoft\Windows\Fonts and gets an HKCU Fonts entry, which is
# what Settings > Fonts > "Install" does without "for all users". Apps already
# running see a new font only after they restart.
let file = (open $"($env.FILE_PWD)/fonts.toml")
let user_fonts = ($env.LOCALAPPDATA? | default '' | path join Microsoft Windows Fonts)

for $fontname in ($file | columns) {
    echo $"(ansi blue)Install(ansi reset) ($fontname)..."
    let font = ($file | get $fontname)

    if $font.manual? == true {
        echo $"    (ansi yellow)[!](ansi reset) You should manually install this. visit (ansi u)($font.url)(ansi reset)"
        continue
    }

    let dir = $"($env.FILE_PWD)/.fonts/($fontname)"
    let extracted = $"($dir)/extracted"
    if not (($extracted | path exists) and (ls $extracted | is-not-empty)) {
        mkdir $dir
        ^curl -fsSLo $"($dir)/font.zip" $font.url
        rm -rf $"($dir)/unzipped" $extracted
        ^7z x $"($dir)/font.zip" $"-o($dir)/unzipped" -y | ignore
        mkdir $extracted
        # glob reads the backslashes of a Windows path as escapes; run it from
        # inside the directory instead.
        do { cd $"($dir)/unzipped"; glob '**/*' }
        | where {|path| ($path | path basename) =~ $font.extract }
        | each {|path| cp -f $path $extracted }
        | ignore
        rm -rf $"($dir)/unzipped"
        if $font.family? != null {
            # The elevated install process has no mise dirs on PATH.
            ^(^mise which uv | str trim) run -q --with fonttools python $"($env.FILE_PWD)/rename-family.py" $font.family ...(ls $extracted | get name)
        }
    } else {
        echo $"    (ansi black)Already downloaded(ansi reset)"
    }

    if $nu.os-info.name == windows {
        mkdir $user_fonts
        let reg_key = 'Software\Microsoft\Windows NT\CurrentVersion\Fonts'
        # One in-process read of the Fonts key; `reg add` runs only for an entry
        # that is missing or points elsewhere.
        let registered = ((try { registry query --hkcu $reg_key } catch { [] }) | reduce --fold {} {|it, acc| $acc | upsert $it.name $it.value })
        let installed = (ls $user_fonts | get name)
        for $source in (ls $extracted | get name) {
            let file = ($source | path parse)
            # Windows keeps every registered font file open for the whole
            # session, so a changed font cannot overwrite its old file. It goes
            # in beside it under a hash-suffixed name instead; the old file is
            # removed on a later run, once a sign-out has released it.
            let plain = ($user_fonts | path join $"($file.stem).($file.extension)")
            # Same size and an installed copy at least as new as the source means
            # unchanged; only a size match with an older copy is worth a hash.
            let target = if not ($plain | path exists) {
                $plain
            } else {
                let src = (ls -l $source | first)
                let dst = (ls -l $plain | first)
                if $src.size == $dst.size and $dst.modified >= $src.modified {
                    $plain
                } else if $src.size == $dst.size and ((open --raw $plain | hash sha256) == (open --raw $source | hash sha256)) {
                    $plain
                } else {
                    $user_fonts | path join $"($file.stem).((open --raw $source | hash sha256) | str substring 0..7).($file.extension)"
                }
            }
            if not ($target | path exists) {
                cp $source $target
            }
            $installed
            | where {|old| ($old | path basename | str starts-with $"($file.stem).") and $old != $target }
            | each {|old| do -i { rm $old } }
            | ignore
            let entry = $"(($source | path parse).stem) \(TrueType\)"
            if ($registered | get -o $entry) != $target {
                ^reg add $'HKCU\($reg_key)' /v $entry /t REG_SZ /d $target /f | ignore
            }
        }
    }
}
