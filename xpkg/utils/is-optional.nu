export def main [path: string] {
    let basename = ($path | path basename)

    return (not ($basename | parse -r '^\[[^]]+\](?:\..+)?$' | is-empty))
}