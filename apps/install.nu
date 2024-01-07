use ~/.dotfiles/utils/is-compatible.nu
use ~/.dotfiles/utils/is-optional.nu
use ~/.dotfiles/utils/yesno.nu
use ~/.dotfiles/utils/escape-filename.nu

for manifest_file in (glob ~/.dotfiles/apps/**/*.manifest.toml$ | where { |x| ($x | path type) == file }) {
    if not (is-compatible $manifest_file) {
        echo $"(ansi black)Skipped(ansi reset) ($manifest_file | path relative-to ~/.dotfiles)"
        continue
    }
    
    let manifest = (open (escape-filename $manifest_file))

    if (is-optional $manifest_file) {
        if not (yesno $"?? Would you install (ansi yellow)($manifest_file | path relative-to ~/.dotfiles)(ansi reset)? \(($manifest | columns | length) packages\)" true) {
            echo $"(ansi black)Skipped(ansi reset) ($manifest_file)"
            continue
        }
    }
    echo $"(ansi green)Install(ansi reset) ($manifest_file | path relative-to ~/.dotfiles)"


    for package_name in ($manifest | columns) {
        let package = ($manifest | get $package_name)

        if $package.optional? == true {
            if not (yesno $"    Would you install ($package_name)?" true) {
                echo $"(ansi erase_line_from_cursor_to_beginning)    (ansi black)Skipped(ansi reset) ($package_name)"
                continue
            }
        }
        

        match $nu.os-info.name {
            windows => {
                let to_install = $package.windows?.winget?
                if ($to_install | describe) == nothing {
                    echo $"    (ansi red)Error(ansi reset) no winget package specified for ($package_name)"
                    continue
                }
                echo $"    (ansi green)Install(ansi reset) ($package_name) \(winget: ($to_install)\)"
                winget install -eh --accept-package-agreements --accept-source-agreements --id $to_install
            }
            linux => {
                match (sys).host.name {
                    'Arch Linux' => {
                        let to_install = $package.linux?.pacman?
                        if ($to_install | describe) == nothing {
                            echo $"    (ansi red)Error(ansi reset) no paru package specified for ($package_name)"
                        }
                        echo $"    (ansi green)Install(ansi reset) ($package_name) \(paru: ($to_install)\)"
                        paru --noconfirm --needed -Sy $to_install
                    }
                    _ => {
                        echo $"    (ansi red)Unsupported Linux Distro(ansi reset): ((sys).host.name)"
                    }
                }
            }
            _ => {
                echo $"    (ansi red)Unsupported OS(ansi reset): ($nu.os-info.name)"
            }
        }
    }
}
