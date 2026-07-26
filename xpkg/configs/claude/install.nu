#!/usr/bin/env nu

# Shared config content is the single source of truth in the nix tree; Windows
# links against it directly. Only the OS-specific bits (statusline.js, and the
# two rewritten settings.json tokens) live here under xpkg.
let home = $nu.home-path
let nix = $'($home)/.dotfiles/nix/home/configs'
let local = $env.FILE_PWD

do -i { mkdir $'($home)/.claude/hooks' }
do -i { mkdir $'($home)/.claude/agents' }
do -i { mkdir $'($home)/.claude/rules' }

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

echo $"     (ansi blue)Symlink(ansi reset) statusline.js"
do -i { ln -s -f $'($local)/statusline.js' $'($home)/.claude/statusline.js' }

echo $"     (ansi blue)Symlink(ansi reset) hooks"
for hook in (ls ($'($nix)/claude/hooks/*.py' | into glob)) {
    let name = ($hook.name | path basename)
    do -i { ln -s -f $hook.name $'($home)/.claude/hooks/($name)' }
}

echo $"     (ansi blue)Symlink(ansi reset) agents"
for agent in (ls ($'($nix)/claude/agents/*.md' | into glob)) {
    let name = ($agent.name | path basename)
    do -i { ln -s -f $agent.name $'($home)/.claude/agents/($name)' }
}

# argent's self-update rewrites this file at runtime, same problem as
# settings.json above, so keep it a writable copy, not a symlink.
echo $"     (ansi blue)Copy(ansi reset) rules/argent.md"
cp $'($nix)/claude/rules/argent.md' $'($home)/.claude/rules/argent.md'
