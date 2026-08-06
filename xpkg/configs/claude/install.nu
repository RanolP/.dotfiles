#!/usr/bin/env nu

# Shared config content is the single source of truth in the nix tree; Windows
# COPIES it into ~/.claude. Symlinks need elevation / Developer Mode on Windows
# and fail silently (do -i), which leaves stale files behind -- that is how the
# old blanket-deny claude-dir-edit-guard kept coming back and killing the memory
# and plan tools. Copying is reliable; re-run this after editing the nix sources.
# Only the OS-specific bits (statusline.js, the two rewritten settings.json
# tokens) are xpkg-local.
let home = $nu.home-path
let nix = $'($home)/.dotfiles/nix/home/configs'
let local = $env.FILE_PWD

do -i { mkdir $'($home)/.claude/hooks' }
do -i { mkdir $'($home)/.claude/agents' }
do -i { mkdir $'($home)/.claude/rules' }
do -i { mkdir $'($home)/.claude/skills' }

echo $"     (ansi blue)Merge(ansi reset) CLAUDE.md from shared AGENTS.md + claude-specific rules"
let merged = (open $'($nix)/.agents/AGENTS.md') + "\n" + (open $'($nix)/claude/CLAUDE.md')
$merged | save -f $'($home)/.claude/CLAUDE.md'

# Claude Code rewrites settings.json at runtime, so a symlink would get
# clobbered into a regular file on the next write -- keep a plain copy. The nix
# source targets Unix (python3, a bare statusline.sh); rewrite those two tokens
# for Windows (python, node statusline.js) as it is copied.
echo $"     (ansi blue)Generate(ansi reset) settings.json \(Windows-adapted from nix source\)"
(open $'($nix)/claude/settings.json' --raw
    | str replace --all 'python3 ' 'python '
    | str replace --all '~/.claude/statusline.sh' 'node ~/.claude/statusline.js'
) | save -f $'($home)/.claude/settings.json'

echo $"     (ansi blue)Copy(ansi reset) statusline.js"
do -i { cp --force $'($local)/statusline.js' $'($home)/.claude/statusline.js' }

echo $"     (ansi blue)Copy(ansi reset) hooks"
for hook in (ls ($'($nix)/claude/hooks/*.py' | into glob)) {
    let name = ($hook.name | path basename)
    do -i { cp --force $hook.name $'($home)/.claude/hooks/($name)' }
}

echo $"     (ansi blue)Copy(ansi reset) agents"
for agent in (ls ($'($nix)/claude/agents/*.md' | into glob)) {
    let name = ($agent.name | path basename)
    do -i { cp --force $agent.name $'($home)/.claude/agents/($name)' }
}

# Local skills only: each is a directory under the shared .agents/skills tree.
# The flake-input skills (skill-creator, humanize-*, orca, ...) come from the
# nix store and aren't available without nix, so Windows gets the local set.
echo $"     (ansi blue)Copy(ansi reset) skills"
for skill in (ls ($'($nix)/.agents/skills/*' | into glob) | where type == dir) {
    let name = ($skill.name | path basename)
    let dest = $'($home)/.claude/skills/($name)'
    do -i { rm -rf $dest }
    do -i { cp --recursive $skill.name $dest }
}
