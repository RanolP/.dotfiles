export def ln [
    --force (-f),     # remove existing destination files
    --symbolic (-s),  # make symbolic links instead of hard links
    target: string,
    link_name: string,
] {
    mut arguments = [$target $link_name]
    if $force {
        $arguments = ($arguments | prepend '--force')
    }
    if $symbolic {
        $arguments = ($arguments | prepend '--symbolic')
    }
    if (sys).host.name == 'Windows' {
        coreutils ln $arguments
    } else {
        run-external ln $arguments
    }
}
