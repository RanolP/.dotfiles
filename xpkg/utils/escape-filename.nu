export def main [path: string] {
    return ($path | str replace --regex --all '([\[\]])' '[$1]')
}
