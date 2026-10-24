#!/usr/bin/env nu

# Shared config content is the single source of truth in the nix tree; Windows
# COPIES it into ~/.claude. Symlinks need elevation / Developer Mode on Windows
# and fail silently (do -i), which leaves stale files behind -- that is how the
# old blanket-deny claude-dir-edit-guard kept coming back and killing the memory
# and plan tools. Copying is reliable; re-run this after editing the nix sources.
# Only the OS-specific bits (statusline.js, the rewritten settings.json
# tokens) are xpkg-local.
let home = $nu.home-path
let nix = $'($home)/.dotfiles/nix/home/configs'
let local = $env.FILE_PWD

do -i { mkdir $'($home)/.claude/hooks' }
do -i { mkdir $'($home)/.claude/agents' }
do -i { mkdir $'($home)/.claude/rules' }
do -i { mkdir $'($home)/.claude/skills' }
do -i { mkdir $'($home)/.claude/mods' }

echo $"     (ansi blue)Merge(ansi reset) CLAUDE.md from shared AGENTS.md + claude-specific rules"
let merged = (open $'($nix)/.agents/AGENTS.md') + "\n" + (open $'($nix)/claude/CLAUDE.md')
$merged | save -f $'($home)/.claude/CLAUDE.md'

# Claude Code rewrites settings.json at runtime, so a symlink would get
# clobbered into a regular file on the next write -- keep a plain copy. The nix
# source targets Unix (python3, a bare statusline.sh); rewrite those two tokens
# for Windows (python, node statusline.js) as it is copied.
#
# CLAUDE_CODE_PLUGIN_DIRS is split on the platform PATH delimiter (`;` here,
# `:` in the nix source) and each entry must be absolute or start with ~, so
# the list is rebuilt with `;` and absolute forward-slash paths. Mods in
# $skipped_mods stay out of it: codex-subagent and tool-compose run their
# daemons on a Unix-domain socket file, and tool-compose's exec refuses any OS
# but darwin, so neither works on native Windows.
let skipped_mods = [codex-subagent tool-compose]
let home_fwd = ($home | str replace --all '\' '/')
let plugin_dirs_src = (open $'($nix)/claude/settings.json' | get env.CLAUDE_CODE_PLUGIN_DIRS)
let mods = ($plugin_dirs_src | split row ':' | each {|d| $d | path basename } | where {|m| $m not-in $skipped_mods })
let plugin_dirs_win = ($mods | each {|m| $'($home_fwd)/.claude/mods/($m)' } | str join ';')

echo $"     (ansi blue)Generate(ansi reset) settings.json \(Windows-adapted from nix source\)"
(open $'($nix)/claude/settings.json' --raw
    | str replace --all 'python3 ' 'python '
    | str replace --all '~/.claude/statusline.sh' 'node ~/.claude/statusline.js'
    | str replace $'"($plugin_dirs_src)"' $'"($plugin_dirs_win)"'
) | save -f $'($home)/.claude/settings.json'

# Mirrors claudeOutputStyle in nix/home/default.nix: same frontmatter, then the
# shared output-manner body. settings.json's "outputStyle" names this file, and
# a missing file silently falls back to the default style.
echo $"     (ansi blue)Generate(ansi reset) output style concise-adhd-korean"
do -i { mkdir $'($home)/.claude/output-styles' }
let style_header = "---
name: concise-adhd-korean
description: ADHD 독자에 맞춘 한국어 문체와 간결한 보고 규칙을 합친 출력 스타일이다. 코딩 지침을 유지한다.
keep-coding-instructions: true
---

"
($style_header + (open $'($nix)/.agents/output-manner.md' --raw)) | save -f $'($home)/.claude/output-styles/concise-adhd-korean.md'

echo $"     (ansi blue)Copy(ansi reset) statusline.js"
do -i { cp --force $'($local)/statusline.js' $'($home)/.claude/statusline.js' }

# Each mod is copied whole: Claude Code rejects a hook module whose realpath
# escapes the plugin directory, and the mods import their sibling files.
echo $"     (ansi blue)Copy(ansi reset) mods \(($mods | str join ', ')\)"
for m in $mods {
    let dest = $'($home)/.claude/mods/($m)'
    do -i { rm -rf $dest }
    cp --recursive $'($nix)/claude/mods/($m)' $dest
}

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
# The flake-input skills (skill-creator, humanize-*, ...) come from the
# nix store and aren't available without nix, so Windows gets the local set.
echo $"     (ansi blue)Copy(ansi reset) skills"
for skill in (ls ($'($nix)/.agents/skills/*' | into glob) | where type == dir) {
    let name = ($skill.name | path basename)
    let dest = $'($home)/.claude/skills/($name)'
    do -i { rm -rf $dest }
    do -i { cp --recursive $skill.name $dest }
}
# nix/home/default.nix links apology a second time under the name the user
# types. Its `dotfiles:evolve` link keeps the source name here, since `:` is
# not a valid character in a Windows file name.
do -i { rm -rf $'($home)/.claude/skills/시말서' }
do -i { cp --recursive $'($nix)/.agents/skills/apology' $'($home)/.claude/skills/시말서' }

# Home-manager drops a link once its source leaves the repo; a copy stays
# behind. Remove each copy whose source git history shows as deleted and the
# repo no longer has (the handoff skill, time-budget.py, ...), and leave every
# other file in these directories alone.
def retired [repo_dir: string] {
    git -C ($nu.home-path | path join '.dotfiles') log --format= --name-only --diff-filter=D -- $repo_dir
    | lines
    | where {|l| $l starts-with $'($repo_dir)/' }
    | each {|l| $l | str substring (($repo_dir | str length) + 1).. | split row '/' | first }
    | uniq
    | where {|n| not ($nu.home-path | path join '.dotfiles' $repo_dir $n | path exists) }
}
echo $"     (ansi blue)Remove(ansi reset) retired hooks, agents and skills"
for r in [
    [repo_dir dest];
    ['nix/home/configs/claude/hooks' 'hooks']
    ['nix/home/configs/claude/agents' 'agents']
    ['nix/home/configs/.agents/skills' 'skills']
] {
    for n in (retired $r.repo_dir) {
        let target = $'($home)/.claude/($r.dest)/($n)'
        if ($target | path exists) {
            echo $"       ($r.dest)/($n)"
            rm -rf $target
        }
    }
}
