use ~/.dotfiles/utils/yesno.nu

let file = (open $"($env.FILE_PWD)/fonts.toml")
for $fontname in ($file | columns) {
    echo $"(ansi blue)Install(ansi reset) ($fontname)..."
    if (
        ($"($env.FILE_PWD)/.fonts/($fontname)/extracted" | path exists) and
        (not (ls $"($env.FILE_PWD)/.fonts/($fontname)/extracted" | is-empty))
    ) {
        if (yesno $"(ansi yellow)[?] (ansi reset)Would you skip reinstalling ($fontname)?" true) {
            echo $"    (ansi black)Skipped(ansi reset)"
            continue
        }
    }
    mkdir $"($env.FILE_PWD)/.fonts/($fontname)"
    let font = ($file | get $fontname)

    if $font.manual? == true {
        echo $"    (ansi yellow)[!](ansi reset) You should manually install this. visit (ansi u)($font.url)(ansi reset)"
        continue
    }

    curl $font.url -sLo $"($env.FILE_PWD)/.fonts/($fontname)/font.zip"

    let files = (
        7z l $"($env.FILE_PWD)/.fonts/($fontname)/font.zip" -ba
        | lines
        | each { |entry| $entry | from ssv -n | get 0 }
        | filter { |entry| not ($entry.column1 | str substring (-5..) | str starts-with 'D') }
        | get column4
        | find -r $font.extract
        | each { |filename| $"\"($filename)\"" }
    )
    rm -rf $"-o($env.FILE_PWD)/.fonts/($fontname)/extracted"
    run-external 7z e $"\"($env.FILE_PWD)/.fonts/($fontname)/font.zip\"" $"-o($env.FILE_PWD)/.fonts/($fontname)/extracted" $files
}
