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
    } else {
        echo $"    (ansi black)Already downloaded(ansi reset)"
    }

    if $nu.os-info.name == windows {
        mkdir $user_fonts
        for $source in (ls $extracted | get name) {
            let target = ($user_fonts | path join ($source | path basename))
            # A font an app has loaded is locked, so an installed file stays.
            if not ($target | path exists) {
                cp $source $target
            }
            let entry = $"(($source | path parse).stem) \(TrueType\)"
            ^reg add 'HKCU\Software\Microsoft\Windows NT\CurrentVersion\Fonts' /v $entry /t REG_SZ /d $target /f | ignore
        }
    }
}
