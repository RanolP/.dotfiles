#!/usr/bin/env nu

# The shared opencode config lives in the nix tree; Windows COPIES it to
# ~/.config/opencode/opencode.jsonc (symlinks need elevation on Windows). The
# directory also holds opencode-managed node_modules/ and providers/, so only
# the one file is written.
let home = $nu.home-path
let nix = $'($home)/.dotfiles/nix/home/configs'

do -i { mkdir $'($home)/.config/opencode' }

print $"     (ansi blue)Copy(ansi reset) opencode.jsonc"
cp --force $'($nix)/opencode/opencode.jsonc' $'($home)/.config/opencode/opencode.jsonc'

# opencode scans ~/.agents/skills and ~/.claude/skills for SKILL.md. The
# Claude installer fills ~/.claude/skills; this fills ~/.agents/skills the
# way home-manager does on nix hosts.
do -i { mkdir $'($home)/.agents/skills' }
print $"     (ansi blue)Copy(ansi reset) skills to ~/.agents/skills"
for skill in (ls ($'($nix)/.agents/skills/*' | into glob) | where type == dir) {
    let dest = $'($home)/.agents/skills/($skill.name | path basename)'
    do -i { rm -rf $dest }
    do -i { cp --recursive $skill.name $dest }
}
